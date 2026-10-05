import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { _logError } from './mainUtils.js';
import {
    parseHexColor,
    getApcaContrast,
    PROMPT_SHADOW_FLOOR,
    resolvePromptVisualState,
    applyPromptVisualState,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    PROMPT_VISUAL_ALGORITHM_VERSION,
} from './colorUtils.js';
import {
    resolveWallpaperSource,
    getFileMtimeAndSize,
    loadScaledWallpaperPixbuf,
    getWallpaperFileInfo,
    blendPixbufs,
    normalizePromptChromeBounds,
    getWallpaperTargetDimensions,
    getVisibleCoverViewport,
    mapNormalizedBoundsToPixbuf,
} from './wallpaperUtils.js';
import {
    createBlurredPromptSlice,
    sampleRegionAverageColor,
    sampleClockRegionLuminance,
    sampleSolidGradientPromptColors,
    sampleWallpaperChromeColors,
} from './wallpaperSampler.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    CANCEL_BUTTON_HOVER_OVERLAY_ALPHA,
    CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA,
} from './constants.js';
import {
    initCache,
    saveCache,
    clearCache as clearPersistentCache,
    flushAllCache,
    getCache,
    setCache,
    hasCache,
    scheduleVibrancyPruning,
    ensureCacheDirectory,
    CacheMetrics,
} from './alphaCache.js';
import {
    createClockAlphaIdentity,
    serializeClockAlphaIdentity,
    createPromptVibrancyIdentity,
    serializePromptVibrancyIdentity,
    formatBoundsKey,
    computeSliceHash,
    resolveSlicePath,
} from './cacheIdentity.js';

export { initCache, flushAllCache };

let _bgSettings = null;
const _inFlightAlphaQueries = new Map();
const _inFlightPromptQueries = new Map();

function getBgSettings() {
    if (!_bgSettings)
        _bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
    return _bgSettings;
}

export function clearCache() {
    clearPersistentCache();
    _inFlightAlphaQueries.clear();
    _inFlightPromptQueries.clear();
    _bgSettings = null;
}

/**
 * Calculates the ideal clock opacity (alpha) based on the background color/wallpaper behind it.
 * Uses single-flight request coalescing to prevent redundant parallel calculations.
 *
 * @param {Object} params
 * @returns {Promise<number>}
 */
export async function getWallpaperAlpha(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        textLuminance = 1.0,
    } = params;

    await initCache();

    const { targetUri, targetFilePath, transitionInfo } = await resolveWallpaperSource(uri);
    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const identity = createClockAlphaIdentity({
        targetUri,
        mtime,
        size,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        textLuminance,
        transitionInfo,
    });
    const cacheKey = serializeClockAlphaIdentity(identity);

    if (hasCache(cacheKey))
        return getCache(cacheKey);

    // Single-flight coalescing: await an identical in-flight query if active
    if (_inFlightAlphaQueries.has(cacheKey)) {
        CacheMetrics.coalescedRequests++;
        return _inFlightAlphaQueries.get(cacheKey);
    }

    const queryPromise = (async () => {
        let bgR = 40, bgG = 40, bgB = 40; // Dark grey default fallback
        let bgNoise = 0.0;

        if (isColor) {
            const c1 = parseHexColor(primaryColor);
            const c2 = parseHexColor(secondaryColor);
            if (shadingType === 0) {
                bgR = c1.r;
                bgG = c1.g;
                bgB = c1.b;
            } else if (shadingType === 1) {
                // Upper third average is roughly 17.5% of the transition from color1 to color2
                bgR = c1.r + (c2.r - c1.r) * 0.175;
                bgG = c1.g + (c2.g - c1.g) * 0.175;
                bgB = c1.b + (c2.b - c1.b) * 0.175;
            } else {
                // Horizontal gradient average across the screen
                bgR = (c1.r + c2.r) / 2;
                bgG = (c1.g + c2.g) / 2;
                bgB = (c1.b + c2.b) / 2;
            }
        } else if (targetFilePath) {
            try {
                let pixbuf;
                if (transitionInfo?.isTransition && transitionInfo.from && transitionInfo.to) {
                    const [pbFrom, pbTo] = await Promise.all([
                        loadScaledWallpaperPixbuf(transitionInfo.from, 256, 256, true),
                        loadScaledWallpaperPixbuf(transitionInfo.to, 256, 256, true),
                    ]);
                    pixbuf = blendPixbufs(pbFrom, pbTo, transitionInfo.progress);
                } else {
                    pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 256, 256, true);
                }

                const bgSettings = getBgSettings();
                const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';
                const monitor = Main.layoutManager?.primaryMonitor || { width: 1920, height: 1080 };

                const sampled = sampleClockRegionLuminance(pixbuf, pictureOptions, monitor);
                bgR = sampled.bgR;
                bgG = sampled.bgG;
                bgB = sampled.bgB;
                bgNoise = sampled.bgNoise;
            } catch (e) {
                _logError(`[WACK/AlphaManager] Failed to read/scale wallpaper for luminance: ${e}`);
            }
        }

        const contrastLc = getApcaContrast(255, 255, 255, bgR, bgG, bgB);
        const absLc = Math.abs(contrastLc);
        const contrastFactor = Math.max(0, Math.min(1, (60.0 - absLc) / 40.0));

        const maxVal = Math.max(bgR, bgG, bgB);
        const minVal = Math.min(bgR, bgG, bgB);
        const chroma = (maxVal - minVal) / 255.0;
        let factor = contrastFactor * (1.0 - 0.5 * chroma);

        if (bgNoise > 0.0) {
            const bgLuminance = (0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB) / 255.0;
            const noiseScale = Math.min(1.0, 0.4 + 0.6 * (bgLuminance / 0.35));
            const noiseFactor = Math.min(1.0, bgNoise * 25.0) * noiseScale;
            factor = Math.max(factor, noiseFactor);
        }

        const alpha = 0.6 + (0.25 * factor);

        setCache(cacheKey, alpha);
        saveCache();
        return alpha;
    })();

    _inFlightAlphaQueries.set(cacheKey, queryPromise);
    return queryPromise.finally(() => {
        _inFlightAlphaQueries.delete(cacheKey);
    });
}

/**
 * Samples the wallpaper behind the Cupertino password prompt and resolves an
 * opaque chip color. Coalesces concurrent identical calculations and schedules
 * background disk pruning without blocking the Clutter UI thread.
 *
 * @param {Object} params
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
export async function getWallpaperPromptColor(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        vibrancyMode = 'tonal',
    } = params;

    await initCache();

    const { targetUri, targetFilePath, transitionInfo, isXml, xmlName } = await resolveWallpaperSource(uri);
    let pictureOptions = params.pictureOptions;
    if (typeof pictureOptions === 'number') {
        const styleMap = {
            0: 'none',
            1: 'wallpaper',
            2: 'centered',
            3: 'scaled',
            4: 'stretched',
            5: 'zoom',
            6: 'spanned',
        };
        pictureOptions = styleMap[pictureOptions] || 'zoom';
    } else if (!pictureOptions) {
        const bgSettings = getBgSettings();
        pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';
    }

    const monitor = Main.layoutManager?.primaryMonitor;
    const monitorWidth = monitor ? monitor.width : 1920;
    const monitorHeight = monitor ? monitor.height : 1080;

    const normBounds = normalizePromptChromeBounds(params, monitorWidth, monitorHeight);
    const { prompt, cancel, avatar, a11y, session } = normBounds;

    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const boundsKey = formatBoundsKey(prompt.x1, prompt.x2, prompt.y1, prompt.y2);
    const cancelBoundsKey = formatBoundsKey(cancel.x1, cancel.x2, cancel.y1, cancel.y2);
    const avatarBoundsKey = formatBoundsKey(avatar.x1, avatar.x2, avatar.y1, avatar.y2);
    const a11yBoundsKey = formatBoundsKey(a11y.x1, a11y.x2, a11y.y1, a11y.y2);
    const sessionBoundsKey = formatBoundsKey(session.x1, session.x2, session.y1, session.y2);

    const identity = createPromptVibrancyIdentity({
        targetUri,
        mtime,
        size,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        pictureOptions,
        monitorWidth,
        monitorHeight,
        boundsKey,
        cancelBoundsKey,
        avatarBoundsKey,
        a11yBoundsKey,
        sessionBoundsKey,
        blurRadius: PROMPT_BLUR_RADIUS,
        blurBrightness: PROMPT_BLUR_BRIGHTNESS,
        cancelHoverAlpha: CANCEL_BUTTON_HOVER_OVERLAY_ALPHA,
        cancelActiveAlpha: CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA,
        algorithmVersion: PROMPT_VISUAL_ALGORITHM_VERSION,
        vibrancyMode,
        transitionInfo,
    });
    const cacheKey = serializePromptVibrancyIdentity(identity);

    if (hasCache(cacheKey)) {
        const cached = getCache(cacheKey);
        if (cached && cached.start && cached.end && cached.visualState?.overlay) {
            const hasAvatar = !!cached.avatarColor;
            const hasA11y = !!cached.a11yColor;
            const hasSession = !!cached.sessionColor;
            const hasCancel = !!cached.cancelColor;
            if (vibrancyMode === 'tonal' || vibrancyMode === 'less') {
                if (cached.r != null && hasAvatar && hasA11y && hasSession && hasCancel)
                    return { ...cached, transitionInfo: transitionInfo ?? null };
            } else {
                const hasPromptImg = cached.imagePath && Gio.File.new_for_path(cached.imagePath).query_exists(null);
                if (hasPromptImg && hasAvatar && hasA11y && hasSession && hasCancel)
                    return { ...cached, transitionInfo: transitionInfo ?? null };
            }
        }
    }

    // Single-flight coalescing: await an identical in-flight query if active
    if (_inFlightPromptQueries.has(cacheKey)) {
        CacheMetrics.coalescedRequests++;
        return _inFlightPromptQueries.get(cacheKey);
    }

    const queryPromise = (async () => {
        let sampledStart = null;
        let sampledEnd = null;
        let sampledPrimary = null;
        let promptVisualState = null;
        let sampledCancelColor = null;
        let sampledAvatarColor = null;
        let sampledA11yColor = null;
        let sampledSessionColor = null;
        let direction = 'vertical';
        let imagePath = null;
        let shadowAlpha = undefined;

        if (isColor) {
            const solidGradientResult = sampleSolidGradientPromptColors({
                primaryColor,
                secondaryColor,
                shadingType,
                normBounds,
                whiteBlendAlpha: CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
            });

            sampledStart = solidGradientResult.sampledStart;
            sampledEnd = solidGradientResult.sampledEnd;
            sampledPrimary = solidGradientResult.sampledPrimary;
            sampledCancelColor = solidGradientResult.sampledCancelColor;
            sampledAvatarColor = solidGradientResult.sampledAvatarColor;
            sampledA11yColor = solidGradientResult.sampledA11yColor;
            sampledSessionColor = solidGradientResult.sampledSessionColor;
            promptVisualState = solidGradientResult.promptVisualState;
            shadowAlpha = solidGradientResult.shadowAlpha;
            direction = solidGradientResult.direction;
        } else if (targetFilePath) {
            try {
                const fileInfo = await getWallpaperFileInfo(targetFilePath);
                const { targetW, targetH } = getWallpaperTargetDimensions(fileInfo, pictureOptions, monitorWidth, monitorHeight);

                let pixbuf;
                if (transitionInfo?.isTransition && transitionInfo.from && transitionInfo.to) {
                    const [pbFrom, pbTo] = await Promise.all([
                        loadScaledWallpaperPixbuf(transitionInfo.from, targetW, targetH, false),
                        loadScaledWallpaperPixbuf(transitionInfo.to, targetW, targetH, false),
                    ]);
                    pixbuf = blendPixbufs(pbFrom, pbTo, transitionInfo.progress);
                } else {
                    pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, targetW, targetH, false);
                }

                const pbWidth = pixbuf.get_width();
                const pbHeight = pixbuf.get_height();
                const visibleViewport = getVisibleCoverViewport(pbWidth, pbHeight, monitorWidth, monitorHeight, pictureOptions);

                const mappedBounds = mapNormalizedBoundsToPixbuf(prompt, pbWidth, pbHeight, visibleViewport);
                const cancelMappedBounds = mapNormalizedBoundsToPixbuf(cancel, pbWidth, pbHeight, visibleViewport);
                const avatarMappedBounds = mapNormalizedBoundsToPixbuf(avatar, pbWidth, pbHeight, visibleViewport);
                const a11yMappedBounds = mapNormalizedBoundsToPixbuf(a11y, pbWidth, pbHeight, visibleViewport);
                const sessionMappedBounds = mapNormalizedBoundsToPixbuf(session, pbWidth, pbHeight, visibleViewport);

                if (vibrancyMode === 'tonal' || vibrancyMode === 'less') {
                    const sampled = sampleRegionAverageColor(pixbuf, mappedBounds) || { r: 40, g: 40, b: 40 };
                    promptVisualState = resolvePromptVisualState(sampled, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
                    sampledPrimary = applyPromptVisualState(sampled, promptVisualState, { preblend: true });
                    sampledStart = sampledPrimary;
                    sampledEnd = sampledPrimary;
                    direction = 'none';

                    shadowAlpha = promptVisualState.shadowAlpha ?? PROMPT_SHADOW_FLOOR;

                    const rawCancel = sampleRegionAverageColor(pixbuf, cancelMappedBounds) || sampled || { r: 40, g: 40, b: 40 };
                    sampledCancelColor = applyPromptVisualState(
                        rawCancel,
                        promptVisualState,
                        { preblend: true }
                    );
                } else {
                    const userName = GLib.get_user_name();
                    const hash = computeSliceHash(cacheKey);
                    const { targetDir, filePath } = resolveSlicePath(userName, hash, isXml, xmlName);

                    ensureCacheDirectory(targetDir);

                    const actualCropW = Math.max(1, mappedBounds.xEnd - mappedBounds.xStart);
                    const actualCropH = Math.max(1, mappedBounds.yEnd - mappedBounds.yStart);
                    const targetDestH = 40;
                    const targetDestW = Math.max(1, Math.round(targetDestH * (actualCropW / actualCropH)));
                    const sliceResult = createBlurredPromptSlice(pixbuf, mappedBounds, targetDestW, targetDestH, PROMPT_BLUR_RADIUS, PROMPT_BLUR_BRIGHTNESS);
                    if (sliceResult?.pixbuf) {
                        const tmpPath = `${filePath}.tmp.${GLib.random_int()}`;
                        sliceResult.pixbuf.savev(tmpPath, 'png', [], []);
                        const tmpFile = Gio.File.new_for_path(tmpPath);
                        tmpFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                        const destFile = Gio.File.new_for_path(filePath);
                        tmpFile.move(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);

                        imagePath = filePath;
                        shadowAlpha = sliceResult.shadowAlpha;
                        sampledPrimary = sliceResult.avgColor;
                        sampledStart = sliceResult.avgColor;
                        sampledEnd = sliceResult.avgColor;
                        direction = 'none';
                        promptVisualState = sliceResult.visualState
                            ?? resolvePromptVisualState(sliceResult.avgColor, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);

                        // Schedule asynchronous background pruning
                        scheduleVibrancyPruning(targetDir, hash);
                    }

                    // Sample dedicated color for cancel button
                    const rawCancelColor = sampleRegionAverageColor(pixbuf, cancelMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
                    sampledCancelColor = applyPromptVisualState(rawCancelColor, promptVisualState, { preblend: true });
                }

                // Decoupled chrome sampling (avatar, a11y, session)
                const chromeColors = sampleWallpaperChromeColors({
                    pixbuf,
                    mappedBoundsMap: {
                        avatar: avatarMappedBounds,
                        a11y: a11yMappedBounds,
                        session: sessionMappedBounds,
                    },
                    promptVisualState,
                    fallbackPrimaryColor: sampledPrimary,
                    whiteBlendAlpha: CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
                });

                sampledAvatarColor = chromeColors.avatarColor;
                sampledA11yColor = chromeColors.a11yColor;
                sampledSessionColor = chromeColors.sessionColor;
                if (!promptVisualState)
                    promptVisualState = chromeColors.effectivePromptVisualState;
            } catch (e) {
                _logError(`[WACK/AlphaManager] Failed to sample wallpaper for prompt color: ${e}`);
            }
        }

        if (!sampledPrimary) {
            const fallback = { r: 40, g: 40, b: 40 };
            sampledPrimary = fallback;
            sampledStart = fallback;
            sampledEnd = fallback;
        }

        if (!sampledCancelColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledCancelColor = applyPromptVisualState(
                raw,
                promptVisualState ?? resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledAvatarColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledAvatarColor = applyPromptVisualState(
                raw,
                promptVisualState ?? resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledA11yColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledA11yColor = applyPromptVisualState(
                raw,
                resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledSessionColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledSessionColor = applyPromptVisualState(
                raw,
                resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (shadowAlpha === undefined) {
            shadowAlpha = promptVisualState?.shadowAlpha ?? PROMPT_SHADOW_FLOOR;
        }

        const result = {
            r: sampledPrimary.r,
            g: sampledPrimary.g,
            b: sampledPrimary.b,
            start: { r: sampledStart.r, g: sampledStart.g, b: sampledStart.b },
            end: { r: sampledEnd.r, g: sampledEnd.g, b: sampledEnd.b },
            noise: promptVisualState?.noise ?? sampledPrimary?.noise ?? 0.0,
            direction: direction,
            vibrancyMode: vibrancyMode,
            imagePath: imagePath,
            cancelColor: sampledCancelColor,
            avatarColor: sampledAvatarColor,
            a11yColor: sampledA11yColor,
            sessionColor: sampledSessionColor,
            shadowAlpha: shadowAlpha,
            useInverse: promptVisualState?.useInverse ?? false,
            visualState: promptVisualState,
            transitionInfo: transitionInfo ?? null,
        };

        setCache(cacheKey, result);
        saveCache();
        return result;
    })();

    _inFlightPromptQueries.set(cacheKey, queryPromise);
    return queryPromise.finally(() => {
        _inFlightPromptQueries.delete(cacheKey);
    });
}

const _precachedXmls = new Set();

/**
 * Parses all static slide files from an XML slideshow and warms the alpha and
 * prompt color cache for each slide in background idle, ensuring 0ms lookups.
 *
 * @param {Object} params Wallpaper parameters
 */
export async function precacheSlideshow(params) {
    const { uri } = params;
    if (!uri || !uri.toLowerCase().endsWith('.xml'))
        return;

    const vibrancyMode = params.vibrancyMode ?? 'tonal';
    const precacheKey = `${uri}|${vibrancyMode}`;
    if (_precachedXmls.has(precacheKey))
        return;

    _precachedXmls.add(precacheKey);

    let xmlText = null;
    const file = uri.startsWith('file://') ? Gio.File.new_for_uri(uri) : Gio.File.new_for_path(uri);
    if (file.query_exists(null)) {
        const [ok, contents] = await file.load_contents_async(null);
        if (ok)
            xmlText = new TextDecoder().decode(contents);
    }

    if (!xmlText)
        return;

    const fileMatches = xmlText.matchAll(/<static[^>]*>[\s\S]*?<file>\s*([^<]+)\s*<\/file>[\s\S]*?<\/static>/g);
    const files = new Set();
    for (const match of fileMatches) {
        if (match[1]) {
            const trimmed = match[1].trim();
            if (trimmed)
                files.add(trimmed);
        }
    }

    if (files.size === 0)
        return;

    await initCache();

    for (const filePath of files) {
        const slideFile = Gio.File.new_for_path(filePath);
        if (!slideFile.query_exists(null))
            continue;

        const slideUri = slideFile.get_uri();
        const slideParams = {
            ...params,
            uri: slideUri,
        };

        await Promise.all([
            getWallpaperPromptColor(slideParams),
            getWallpaperAlpha({ ...slideParams, textLuminance: 1.0 }),
        ]);
    }
}
