import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { CUPERTINO_PROMPT_VERTICAL_FRACTION, CUPERTINO_CHIP_VERTICAL_FRACTION } from './constants.js';
import { _logError } from './mainUtils.js';
import {
    parseHexColor,
    getApcaContrast,
    rgbToHsl,
    hslToRgb,
    PROMPT_SHADOW_FLOOR,
    processPromptColor,
    getPromptBlendOverlay,
    blendOverOpaque,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    rgbToHex,
} from './colorUtils.js';
import {
    resolveWallpaperSource,
    getFileMtimeAndSize,
    loadScaledWallpaperPixbuf,
    getWallpaperFileInfo,
} from './wallpaperUtils.js';
import { createBlurredPromptSlice, sampleRegionAverageColor } from './wallpaperSampler.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    CANCEL_BUTTON_BLUR_RADIUS,
    CANCEL_BUTTON_BLUR_BRIGHTNESS,
    CANCEL_BUTTON_HOVER_OVERLAY_ALPHA,
    CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA,
    CANCEL_BUTTON_WIDTH,
    CANCEL_BUTTON_HEIGHT,
    CANCEL_BUTTON_X_OFFSET,
    CANCEL_BUTTON_Y_OFFSET,
    A11Y_BUTTON_BLUR_RADIUS,
    A11Y_BUTTON_BLUR_BRIGHTNESS,
    A11Y_BUTTON_HOVER_OVERLAY_ALPHA,
    A11Y_BUTTON_ACTIVE_OVERLAY_ALPHA,
    A11Y_BUTTON_WIDTH,
    A11Y_BUTTON_HEIGHT,
    A11Y_BUTTON_MARGIN,
} from './constants.js';
import {
    initCache,
    saveCache,
    clearCache as clearPersistentCache,
    getCache,
    setCache,
    hasCache,
} from './alphaCache.js';

export { initCache };

let _bgSettings = null;

function getBgSettings() {
    if (!_bgSettings)
        _bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
    return _bgSettings;
}

export function clearCache() {
    clearPersistentCache();
    _bgSettings = null;
}

/**
 * Calculates the ideal clock opacity (alpha) based on the background color/wallpaper behind it.
 * Falls back to 0.6 if there's sufficient contrast, scaling up to 0.85 if contrast is very low.
 *
 * @param {Object} params
 * @param {string} params.uri - Wallpaper picture URI
 * @param {boolean} params.isColor - True if the background option is color/none
 * @param {string} params.primaryColor - Hex value for primary color
 * @param {string} params.secondaryColor - Hex value for secondary color
 * @param {number} params.shadingType - Shading type (0=Solid, 1=Vertical, 2=Horizontal)
 * @param {number} [params.textLuminance=1.0] - Target text luminance (default 1.0, e.g. white text)
 * @returns {Promise<number>} The target alpha value between 0.6 and 0.85
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

    const { targetUri, targetFilePath } = await resolveWallpaperSource(uri);
    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const cacheKey = `${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${textLuminance}`;
    if (hasCache(cacheKey))
        return getCache(cacheKey);

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
            const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 256, 256, true);

            const pbWidth = pixbuf.get_width();
            const pbHeight = pixbuf.get_height();
            const pixels = pixbuf.get_pixels();
            const channels = pixbuf.get_n_channels();
            const rowstride = pixbuf.get_rowstride();

            const bgSettings = getBgSettings();
            const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';

            const monitor = Main.layoutManager?.primaryMonitor || { width: 1920, height: 1080 };
            const monitorWidth = monitor.width;
            const monitorHeight = monitor.height;
            const monitorAspect = monitorWidth / monitorHeight;
            const pbAspect = pbWidth / pbHeight;

            let visibleX = 0, visibleY = 0, visibleW = pbWidth, visibleH = pbHeight;

            if (pictureOptions === 'zoom' || pictureOptions === 'spanned') {
                if (pbAspect > monitorAspect) {
                    visibleW = pbHeight * monitorAspect;
                    visibleX = (pbWidth - visibleW) / 2;
                } else if (pbAspect < monitorAspect) {
                    visibleH = pbWidth / monitorAspect;
                    visibleY = (pbHeight - visibleH) / 2;
                }
            }

            const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * 0.25)));
            const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * 0.75)));
            const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * 0.05)));
            const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * 0.35)));

            let rSum = 0, gSum = 0, bSum = 0;
            let diffSum = 0;
            let count = 0;
            let diffCount = 0;

            for (let y = yStart; y < yEnd; y++) {
                for (let x = xStart; x < xEnd; x++) {
                    const offset = y * rowstride + x * channels;
                    const r = pixels[offset];
                    const g = pixels[offset + 1];
                    const b = pixels[offset + 2];

                    rSum += r;
                    gSum += g;
                    bSum += b;
                    count++;

                    // Calculate high-frequency texture noise (differences between adjacent pixels)
                    // within the bounding box to avoid scaling on smooth vector/gradient edges.
                    if (x < xEnd - 1 && y < yEnd - 1) {
                        const offsetRight = y * rowstride + (x + 1) * channels;
                        const offsetDown = (y + 1) * rowstride + x * channels;

                        const rR = pixels[offsetRight], gR = pixels[offsetRight + 1], bR = pixels[offsetRight + 2];
                        const rD = pixels[offsetDown], gD = pixels[offsetDown + 1], bD = pixels[offsetDown + 2];

                        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
                        const lumR = (0.2126 * rR + 0.7152 * gR + 0.0722 * bR) / 255.0;
                        const lumD = (0.2126 * rD + 0.7152 * gD + 0.0722 * bD) / 255.0;

                        diffSum += (Math.abs(lum - lumR) + Math.abs(lum - lumD)) / 2.0;
                        diffCount++;
                    }
                }
            }

            if (count > 0) {
                bgR = rSum / count;
                bgG = gSum / count;
                bgB = bSum / count;
            }

            if (diffCount > 0) {
                bgNoise = diffSum / diffCount;
            }
        } catch (e) {
            _logError(`[WACK/AlphaManager] Failed to read/scale wallpaper for luminance: ${e}`);
        }
    }

    const contrastLc = getApcaContrast(255, 255, 255, bgR, bgG, bgB);
    const absLc = Math.abs(contrastLc);

    // APCA threshold mapping for large (128px time, 30px date) clock text:
    // Only need maximum alpha boost (0.875) if contrast Lc is extremely low (<= 20).
    // If Lc >= 60, we have very good legibility and stay at the baseline floor of 0.6.
    // Between 20 and 60, scale smoothly.
    let factor = Math.max(0, Math.min(1, (60.0 - absLc) / 40.0));

    // Boost the alpha factor on highly textured/noisy backgrounds to help the
    // clock text stand out from busy patterns (up to maximum boost for noise >= 0.04).
    // We scale down/discount the noise boost if the background is dark (luminance < 0.35)
    // because white text naturally has excellent contrast against dark backgrounds.
    if (bgNoise > 0.0) {
        const bgLuminance = (0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB) / 255.0;
        const noiseScale = Math.min(1.0, bgLuminance / 0.35);
        const noiseFactor = Math.min(1.0, bgNoise * 25.0) * noiseScale;
        factor = Math.max(factor, noiseFactor);
    }

    // Calculate background chroma/saturation to discount the alpha boost for
    // highly saturated colors (where color/chrominance contrast significantly
    // aids legibility), while keeping the full boost for neutral/desaturated
    // light backgrounds (like white/grey/cyan skies or clouds).
    // We apply this after noise calculations so chroma discounts apply to noise boosts too.
    const maxVal = Math.max(bgR, bgG, bgB);
    const minVal = Math.min(bgR, bgG, bgB);
    const chroma = (maxVal - minVal) / 255.0; // 0.0 to 1.0
    factor = factor * (1.0 - 0.5 * chroma);

    // Alpha ranges between 0.6 (baseline floor) and 0.85 (extremely bright roof)
    const alpha = 0.6 + (0.25 * factor);

    setCache(cacheKey, alpha);
    saveCache();
    return alpha;
}

/**
 * Samples the wallpaper behind the Cupertino password prompt and resolves an
 * opaque chip color. Most backdrops get a frosted white blend; bright colorful
 * backdrops become a darker version of their sampled hue, while bright neutral
 * or all-white backdrops fall back to the older inverted alpha-blend logic.
 *
 * @param {Object} params
 * @param {string} params.uri - Wallpaper picture URI
 * @param {boolean} params.isColor - True if the background option is color/none
 * @param {string} params.primaryColor - Hex value for primary color
 * @param {string} params.secondaryColor - Hex value for secondary color
 * @param {number} params.shadingType - Shading type (0=Solid, 1=Vertical, 2=Horizontal)
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
export async function getWallpaperPromptColor({
    uri = null,
    isColor = false,
    primaryColor = '#000000',
    secondaryColor = '#000000',
    shadingType = 0,
    wellH = 0,
    yCenterFraction = null,
    promptBounds = null,
    cancelBounds = null,
    a11yBounds = null,
    avatarBounds = null,
} = {}) {
    await initCache();

    let targetUri = uri;
    let targetFilePath = null;

    if (!isColor) {
        if (!targetUri) {
            const bgSettings = getBgSettings();
            targetUri = bgSettings ? bgSettings.get_string('picture-uri') : null;
        }
        targetFilePath = resolveWallpaperSource(targetUri);
    }

    const bgSettings = getBgSettings();
    const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';

    const monitor = Main.layoutManager?.primaryMonitor;
    const monitorWidth = monitor ? monitor.width : 1920;
    const monitorHeight = monitor ? monitor.height : 1080;

    // The prompt chip sits at the bottom of the prompt stack (below the avatar).
    // While vertical fraction (0.9575) positions the prompt stack as a whole,
    // the chip itself is located lower on the screen (slightly higher than 0.9575, e.g. ~0.968).
    const chipVerticalFraction = CUPERTINO_CHIP_VERTICAL_FRACTION ?? 0.968;
    const yCenter = (yCenterFraction != null && yCenterFraction >= CUPERTINO_PROMPT_VERTICAL_FRACTION)
        ? yCenterFraction
        : chipVerticalFraction;

    let normX1, normX2, normY1, normY2;
    const promptBoundsCenterY = (promptBounds?.y1 != null && promptBounds?.y2 != null)
        ? (promptBounds.y1 + promptBounds.y2) / 2
        : null;

    if (promptBounds &&
        promptBounds.x1 != null &&
        promptBounds.x2 != null &&
        promptBounds.x2 > promptBounds.x1 &&
        promptBounds.x1 >= 0 &&
        promptBounds.x2 <= 1 &&
        promptBoundsCenterY !== null &&
        promptBoundsCenterY >= CUPERTINO_PROMPT_VERTICAL_FRACTION) {
        normX1 = promptBounds.x1;
        normX2 = promptBounds.x2;
        normY1 = promptBounds.y1;
        normY2 = promptBounds.y2;
    } else {
        // Cupertino prompt chip: ~170px width on 1080p (approx 8.9% screen width, centered at 0.50)
        // and ~36px height (approx 3.3% screen height, centered at yCenter)
        const halfW = (promptBounds?.x2 && promptBounds?.x1)
            ? (promptBounds.x2 - promptBounds.x1) / 2
            : (170 / monitorWidth) / 2;
        normX1 = Math.max(0, 0.50 - halfW);
        normX2 = Math.min(1, 0.50 + halfW);
        const halfH = 18 / monitorHeight;
        normY1 = Math.max(0, yCenter - halfH);
        normY2 = Math.min(1, yCenter + halfH);
    }

    // Cancel button bounds (offset with CANCEL_BUTTON_X_OFFSET / CANCEL_BUTTON_Y_OFFSET)
    let normCancelX1, normCancelX2, normCancelY1, normCancelY2;
    const offsetX = CANCEL_BUTTON_X_OFFSET / monitorWidth;
    const offsetY = CANCEL_BUTTON_Y_OFFSET / monitorHeight;
    const btnHalfW = (CANCEL_BUTTON_WIDTH / 2) / monitorWidth;
    const btnHalfH = (CANCEL_BUTTON_HEIGHT / 2) / monitorHeight;

    if (cancelBounds &&
        cancelBounds.x1 != null && cancelBounds.x2 != null &&
        cancelBounds.x2 > cancelBounds.x1) {
        normCancelX1 = Math.max(0, Math.min(1, cancelBounds.x1 + offsetX));
        normCancelX2 = Math.max(0, Math.min(1, cancelBounds.x2 + offsetX));
        normCancelY1 = Math.max(0, Math.min(1, cancelBounds.y1 + offsetY));
        normCancelY2 = Math.max(0, Math.min(1, cancelBounds.y2 + offsetY));
    } else {
        // Fallback: placed adjacent to prompt entry left edge (12px gap) plus user offset
        const baseCenterX = normX1 - (12 / monitorWidth) - btnHalfW;
        const baseCenterY = (normY1 + normY2) / 2;
        const centerX = baseCenterX + offsetX;
        const centerY = baseCenterY + offsetY;
        normCancelX1 = Math.max(0, Math.min(1, centerX - btnHalfW));
        normCancelX2 = Math.max(0, Math.min(1, centerX + btnHalfW));
        normCancelY1 = Math.max(0, Math.min(1, centerY - btnHalfH));
        normCancelY2 = Math.max(0, Math.min(1, centerY + btnHalfH));
    }

    // A11y button bounds (bottom-right on GDM / lockscreen)
    let normA11yX1, normA11yX2, normA11yY1, normA11yY2;
    if (a11yBounds &&
        a11yBounds.x1 != null && a11yBounds.x2 != null &&
        a11yBounds.x2 > a11yBounds.x1) {
        normA11yX1 = a11yBounds.x1;
        normA11yX2 = a11yBounds.x2;
        normA11yY1 = a11yBounds.y1;
        normA11yY2 = a11yBounds.y2;
    } else {
        const isRtl = Clutter?.get_default_text_direction ? Clutter.get_default_text_direction() === Clutter.TextDirection.RTL : false;
        const a11yX = isRtl ? A11Y_BUTTON_MARGIN : (monitorWidth - A11Y_BUTTON_MARGIN - A11Y_BUTTON_WIDTH);
        const a11yY = monitorHeight - A11Y_BUTTON_MARGIN - A11Y_BUTTON_HEIGHT;
        normA11yX1 = Math.max(0, a11yX / monitorWidth);
        normA11yX2 = Math.min(1, (a11yX + A11Y_BUTTON_WIDTH) / monitorWidth);
        normA11yY1 = Math.max(0, a11yY / monitorHeight);
        normA11yY2 = Math.min(1, (a11yY + A11Y_BUTTON_HEIGHT) / monitorHeight);
    }

    // Avatar bounds for "Not Listed" / empty icon placeholder (circular well)
    let normAvatarX1, normAvatarX2, normAvatarY1, normAvatarY2;
    const defaultAvatarSize = 56;
    const avatarHalfW = (defaultAvatarSize / 2) / monitorWidth;
    if (avatarBounds &&
        avatarBounds.x1 != null && avatarBounds.x2 != null &&
        avatarBounds.x2 > avatarBounds.x1) {
        normAvatarX1 = avatarBounds.x1;
        normAvatarX2 = avatarBounds.x2;
        normAvatarY1 = avatarBounds.y1;
        normAvatarY2 = avatarBounds.y2;
    } else {
        const anchorH = wellH > 0 ? Math.floor(wellH * 1.3) : 108;
        const targetStackY = Math.floor(monitorHeight * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
        normAvatarY1 = Math.max(0, targetStackY / monitorHeight);
        normAvatarY2 = Math.min(1, (targetStackY + defaultAvatarSize) / monitorHeight);
        normAvatarX1 = Math.max(0, 0.50 - avatarHalfW);
        normAvatarX2 = Math.min(1, 0.50 + avatarHalfW);
    }

    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const boundsKey = `${normX1.toFixed(4)}_${normX2.toFixed(4)}_${normY1.toFixed(4)}_${normY2.toFixed(4)}`;
    const cancelBoundsKey = `${normCancelX1.toFixed(4)}_${normCancelX2.toFixed(4)}_${normCancelY1.toFixed(4)}_${normCancelY2.toFixed(4)}`;
    const a11yBoundsKey = `${normA11yX1.toFixed(4)}_${normA11yX2.toFixed(4)}_${normA11yY1.toFixed(4)}_${normA11yY2.toFixed(4)}`;
    const avatarBoundsKey = `${normAvatarX1.toFixed(4)}_${normAvatarX2.toFixed(4)}_${normAvatarY1.toFixed(4)}_${normAvatarY2.toFixed(4)}`;
    const cacheKey = `prompt_grad_${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${pictureOptions}_${monitorWidth}x${monitorHeight}_${boundsKey}_cb${cancelBoundsKey}_a11y${a11yBoundsKey}_av${avatarBoundsKey}_b${PROMPT_BLUR_RADIUS}_pbr${PROMPT_BLUR_BRIGHTNESS}_cr${CANCEL_BUTTON_BLUR_RADIUS}_cbr${CANCEL_BUTTON_BLUR_BRIGHTNESS}_chov${CANCEL_BUTTON_HOVER_OVERLAY_ALPHA}_cact${CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA}_cover_v10`;
    if (hasCache(cacheKey)) {
        const cached = getCache(cacheKey);
        if (cached && cached.start && cached.end) {
            const hasPromptImg = cached.imagePath && Gio.File.new_for_path(cached.imagePath).query_exists(null);
            const hasCancelImg = cached.cancelImagePath && Gio.File.new_for_path(cached.cancelImagePath).query_exists(null);
            const hasHoverImg = cached.cancelHoverImagePath && Gio.File.new_for_path(cached.cancelHoverImagePath).query_exists(null);
            const hasActiveImg = cached.cancelActiveImagePath && Gio.File.new_for_path(cached.cancelActiveImagePath).query_exists(null);
            const hasA11yImg = cached.a11yImagePath && Gio.File.new_for_path(cached.a11yImagePath).query_exists(null);
            const hasA11yHoverImg = cached.a11yHoverImagePath && Gio.File.new_for_path(cached.a11yHoverImagePath).query_exists(null);
            const hasA11yActiveImg = cached.a11yActiveImagePath && Gio.File.new_for_path(cached.a11yActiveImagePath).query_exists(null);
            const hasAvatar = !!cached.avatarColor;
            if (hasPromptImg && hasCancelImg && hasHoverImg && hasActiveImg && hasA11yImg && hasA11yHoverImg && hasA11yActiveImg && hasAvatar) {
                return cached;
            }
        }
    }

    let sampledStart = null;
    let sampledEnd = null;
    let sampledPrimary = null;
    let sampledAvatarColor = null;
    let direction = 'vertical';
    let imagePath = null;
    let cancelImagePath = null;
    let cancelHoverImagePath = null;
    let cancelActiveImagePath = null;
    let a11yImagePath = null;
    let a11yHoverImagePath = null;
    let a11yActiveImagePath = null;
    let shadowAlpha = undefined;

    if (isColor) {
        const c1 = parseHexColor(primaryColor);
        const c2 = parseHexColor(secondaryColor);

        if (shadingType === 0) {
            const hsl = rgbToHsl(c1.r, c1.g, c1.b);
            const specularL = Math.min(1.0, hsl.l + 0.05);
            sampledStart = hslToRgb(hsl.h, hsl.s, specularL);
            sampledEnd = { ...c1 };
            sampledPrimary = { ...c1 };
        } else if (shadingType === 1) {
            const y1 = normY1;
            const y2 = normY2;
            const yt = (normY1 + normY2) / 2;
            sampledStart = {
                r: Math.round(c1.r + (c2.r - c1.r) * y1),
                g: Math.round(c1.g + (c2.g - c1.g) * y1),
                b: Math.round(c1.b + (c2.b - c1.b) * y1),
            };
            sampledEnd = {
                r: Math.round(c1.r + (c2.r - c1.r) * y2),
                g: Math.round(c1.g + (c2.g - c1.g) * y2),
                b: Math.round(c1.b + (c2.b - c1.b) * y2),
            };
            sampledPrimary = {
                r: Math.round(c1.r + (c2.r - c1.r) * yt),
                g: Math.round(c1.g + (c2.g - c1.g) * yt),
                b: Math.round(c1.b + (c2.b - c1.b) * yt),
            };
        } else {
            sampledStart = { ...c1 };
            sampledEnd = { ...c2 };
            sampledPrimary = {
                r: Math.round((c1.r + c2.r) / 2),
                g: Math.round((c1.g + c2.g) / 2),
                b: Math.round((c1.b + c2.b) / 2),
            };
            direction = 'horizontal';
        }

        const overlay = getPromptBlendOverlay(sampledPrimary, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
        sampledAvatarColor = {
            r: sampledPrimary.r,
            g: sampledPrimary.g,
            b: sampledPrimary.b,
            rgba: `rgba(${sampledPrimary.r}, ${sampledPrimary.g}, ${sampledPrimary.b}, 1.0)`,
            hex: rgbToHex(sampledPrimary.r, sampledPrimary.g, sampledPrimary.b),
            overlayR: overlay.overlayR,
            overlayG: overlay.overlayG,
            overlayB: overlay.overlayB,
            overlayAlpha: overlay.blendAlpha,
            overlayRgba: `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`,
        };
    } else if (targetFilePath) {
        try {
            const fileInfo = await getWallpaperFileInfo(targetFilePath);
            let targetW = monitorWidth;
            let targetH = monitorHeight;
            if (fileInfo && fileInfo.width > 0 && fileInfo.height > 0) {
                const origW = fileInfo.width;
                const origH = fileInfo.height;
                if (pictureOptions === 'stretched') {
                    targetW = monitorWidth;
                    targetH = monitorHeight;
                } else if (pictureOptions === 'scaled') {
                    const scale = Math.min(monitorWidth / origW, monitorHeight / origH);
                    targetW = Math.max(1, Math.round(origW * scale));
                    targetH = Math.max(1, Math.round(origH * scale));
                } else {
                    // zoom / spanned / default: cover
                    const scale = Math.max(monitorWidth / origW, monitorHeight / origH);
                    targetW = Math.max(1, Math.round(origW * scale));
                    targetH = Math.max(1, Math.round(origH * scale));
                }
            }

            const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, targetW, targetH, false);

            const pbWidth = pixbuf.get_width();
            const pbHeight = pixbuf.get_height();

            const monitorAspect = monitorWidth / monitorHeight;
            const pbAspect = pbWidth / pbHeight;

            let visibleX = 0, visibleY = 0, visibleW = pbWidth, visibleH = pbHeight;

            if (pictureOptions === 'zoom' || pictureOptions === 'spanned') {
                if (pbAspect > monitorAspect) {
                    visibleW = pbHeight * monitorAspect;
                    visibleX = (pbWidth - visibleW) / 2;
                } else if (pbAspect < monitorAspect) {
                    visibleH = pbWidth / monitorAspect;
                    visibleY = (pbHeight - visibleH) / 2;
                }
            } else if (pictureOptions === 'scaled') {
                if (pbAspect > monitorAspect) {
                    visibleH = pbWidth / monitorAspect;
                    visibleY = (pbHeight - visibleH) / 2;
                } else if (pbAspect < monitorAspect) {
                    visibleW = pbHeight * monitorAspect;
                    visibleX = (pbWidth - visibleW) / 2;
                }
            }

            const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normX1)));
            const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normX2)));
            const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normY1)));
            const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normY2)));

            const mappedBounds = {
                x1: xStart / pbWidth,
                x2: xEnd / pbWidth,
                y1: yStart / pbHeight,
                y2: yEnd / pbHeight,
            };

            const userName = GLib.get_user_name();
            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, cacheKey, -1).substring(0, 8);

            const sliceResult = createBlurredPromptSlice(pixbuf, mappedBounds, 320, 40, PROMPT_BLUR_RADIUS, PROMPT_BLUR_BRIGHTNESS);
            if (sliceResult?.pixbuf) {
                const filePath = `/var/tmp/wack-prompt-blur-${userName}-${hash}.png`;
                try {
                    sliceResult.pixbuf.savev(filePath, 'png', [], []);
                    const pFile = Gio.File.new_for_path(filePath);
                    pFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    imagePath = filePath;
                    shadowAlpha = sliceResult.shadowAlpha;
                    sampledPrimary = sliceResult.avgColor;
                    sampledStart = sliceResult.avgColor;
                    sampledEnd = sliceResult.avgColor;
                    direction = 'none';
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save blurred prompt slice: ${saveErr}`);
                }
            }

            // Sample dedicated slice for cancel button
            const cxStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normCancelX1)));
            const cxEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normCancelX2)));
            const cyStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normCancelY1)));
            const cyEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normCancelY2)));

            const cancelMappedBounds = {
                x1: cxStart / pbWidth,
                x2: cxEnd / pbWidth,
                y1: cyStart / pbHeight,
                y2: cyEnd / pbHeight,
            };

            const cancelSliceResult = createBlurredPromptSlice(
                pixbuf,
                cancelMappedBounds,
                CANCEL_BUTTON_WIDTH,
                CANCEL_BUTTON_HEIGHT,
                CANCEL_BUTTON_BLUR_RADIUS,
                CANCEL_BUTTON_BLUR_BRIGHTNESS,
                0.0
            );

            const cancelHoverSliceResult = createBlurredPromptSlice(
                pixbuf,
                cancelMappedBounds,
                CANCEL_BUTTON_WIDTH,
                CANCEL_BUTTON_HEIGHT,
                CANCEL_BUTTON_BLUR_RADIUS,
                CANCEL_BUTTON_BLUR_BRIGHTNESS,
                CANCEL_BUTTON_HOVER_OVERLAY_ALPHA
            );

            const cancelActiveSliceResult = createBlurredPromptSlice(
                pixbuf,
                cancelMappedBounds,
                CANCEL_BUTTON_WIDTH,
                CANCEL_BUTTON_HEIGHT,
                CANCEL_BUTTON_BLUR_RADIUS,
                CANCEL_BUTTON_BLUR_BRIGHTNESS,
                CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA
            );

            if (cancelSliceResult?.pixbuf) {
                const cancelFilePath = `/var/tmp/wack-cancel-blur-${userName}-${hash}.png`;
                try {
                    cancelSliceResult.pixbuf.savev(cancelFilePath, 'png', [], []);
                    const cFile = Gio.File.new_for_path(cancelFilePath);
                    cFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    cancelImagePath = cancelFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save cancel slice: ${saveErr}`);
                }
            }

            if (cancelHoverSliceResult?.pixbuf) {
                const cancelHoverFilePath = `/var/tmp/wack-cancel-blur-hover-${userName}-${hash}.png`;
                try {
                    cancelHoverSliceResult.pixbuf.savev(cancelHoverFilePath, 'png', [], []);
                    const chFile = Gio.File.new_for_path(cancelHoverFilePath);
                    chFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    cancelHoverImagePath = cancelHoverFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save cancel hover slice: ${saveErr}`);
                }
            }

            if (cancelActiveSliceResult?.pixbuf) {
                const cancelActiveFilePath = `/var/tmp/wack-cancel-blur-active-${userName}-${hash}.png`;
                try {
                    cancelActiveSliceResult.pixbuf.savev(cancelActiveFilePath, 'png', [], []);
                    const caFile = Gio.File.new_for_path(cancelActiveFilePath);
                    caFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    cancelActiveImagePath = cancelActiveFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save cancel active slice: ${saveErr}`);
                }
            }

            // Sample dedicated slice for a11y button
            const a11yXStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normA11yX1)));
            const a11yXEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normA11yX2)));
            const a11yYStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normA11yY1)));
            const a11yYEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normA11yY2)));

            const a11yMappedBounds = {
                x1: a11yXStart / pbWidth,
                x2: a11yXEnd / pbWidth,
                y1: a11yYStart / pbHeight,
                y2: a11yYEnd / pbHeight,
            };

            const a11ySliceResult = createBlurredPromptSlice(
                pixbuf,
                a11yMappedBounds,
                A11Y_BUTTON_WIDTH,
                A11Y_BUTTON_HEIGHT,
                A11Y_BUTTON_BLUR_RADIUS,
                A11Y_BUTTON_BLUR_BRIGHTNESS,
                0.0
            );

            const a11yHoverSliceResult = createBlurredPromptSlice(
                pixbuf,
                a11yMappedBounds,
                A11Y_BUTTON_WIDTH,
                A11Y_BUTTON_HEIGHT,
                A11Y_BUTTON_BLUR_RADIUS,
                A11Y_BUTTON_BLUR_BRIGHTNESS,
                A11Y_BUTTON_HOVER_OVERLAY_ALPHA
            );

            const a11yActiveSliceResult = createBlurredPromptSlice(
                pixbuf,
                a11yMappedBounds,
                A11Y_BUTTON_WIDTH,
                A11Y_BUTTON_HEIGHT,
                A11Y_BUTTON_BLUR_RADIUS,
                A11Y_BUTTON_BLUR_BRIGHTNESS,
                A11Y_BUTTON_ACTIVE_OVERLAY_ALPHA
            );

            if (a11ySliceResult?.pixbuf) {
                const a11yFilePath = `/var/tmp/wack-a11y-blur-${userName}-${hash}.png`;
                try {
                    a11ySliceResult.pixbuf.savev(a11yFilePath, 'png', [], []);
                    const aFile = Gio.File.new_for_path(a11yFilePath);
                    aFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    a11yImagePath = a11yFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save a11y slice: ${saveErr}`);
                }
            }

            if (a11yHoverSliceResult?.pixbuf) {
                const a11yHoverFilePath = `/var/tmp/wack-a11y-blur-hover-${userName}-${hash}.png`;
                try {
                    a11yHoverSliceResult.pixbuf.savev(a11yHoverFilePath, 'png', [], []);
                    const ahFile = Gio.File.new_for_path(a11yHoverFilePath);
                    ahFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    a11yHoverImagePath = a11yHoverFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save a11y hover slice: ${saveErr}`);
                }
            }

            if (a11yActiveSliceResult?.pixbuf) {
                const a11yActiveFilePath = `/var/tmp/wack-a11y-blur-active-${userName}-${hash}.png`;
                try {
                    a11yActiveSliceResult.pixbuf.savev(a11yActiveFilePath, 'png', [], []);
                    const aaFile = Gio.File.new_for_path(a11yActiveFilePath);
                    aaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    a11yActiveImagePath = a11yActiveFilePath;
                } catch (saveErr) {
                    _logError(`[WACK/AlphaManager] Failed to save a11y active slice: ${saveErr}`);
                }
            }

            // Sample dedicated color for empty avatar placeholder
            const avXStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normAvatarX1)));
            const avXEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normAvatarX2)));
            const avYStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normAvatarY1)));
            const avYEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normAvatarY2)));

            const avatarMappedBounds = {
                x1: avXStart / pbWidth,
                x2: avXEnd / pbWidth,
                y1: avYStart / pbHeight,
                y2: avYEnd / pbHeight,
            };

            const rawAvatarColor = sampleRegionAverageColor(pixbuf, avatarMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
            const overlay = getPromptBlendOverlay(rawAvatarColor);
            sampledAvatarColor = {
                r: rawAvatarColor.r,
                g: rawAvatarColor.g,
                b: rawAvatarColor.b,
                rgba: `rgba(${rawAvatarColor.r}, ${rawAvatarColor.g}, ${rawAvatarColor.b}, 1.0)`,
                hex: rgbToHex(rawAvatarColor.r, rawAvatarColor.g, rawAvatarColor.b),
                overlayR: overlay.overlayR,
                overlayG: overlay.overlayG,
                overlayB: overlay.overlayB,
                overlayAlpha: overlay.blendAlpha,
                overlayRgba: `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`,
            };

            // Clean up older slice PNGs for this user — keep only the current hash
            try {
                const tmpDir = Gio.File.new_for_path('/var/tmp');
                if (tmpDir.query_exists(null)) {
                    const enumerator = tmpDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    const toDelete = [];
                    let fileInfo;
                    while ((fileInfo = enumerator.next_file(null)) !== null) {
                        const fileName = fileInfo.get_name();
                        const currentSuffix = `-${hash}.png`;
                        const isUserSlice = (
                            fileName.startsWith(`wack-prompt-blur-${userName}-`) ||
                            fileName.startsWith(`wack-cancel-blur-active-${userName}-`) ||
                            fileName.startsWith(`wack-cancel-blur-hover-${userName}-`) ||
                            fileName.startsWith(`wack-a11y-blur-active-${userName}-`) ||
                            fileName.startsWith(`wack-a11y-blur-hover-${userName}-`) ||
                            (fileName.startsWith(`wack-cancel-blur-${userName}-`) &&
                             !fileName.startsWith(`wack-cancel-blur-hover-${userName}-`) &&
                             !fileName.startsWith(`wack-cancel-blur-active-${userName}-`)) ||
                            (fileName.startsWith(`wack-a11y-blur-${userName}-`) &&
                             !fileName.startsWith(`wack-a11y-blur-hover-${userName}-`) &&
                             !fileName.startsWith(`wack-a11y-blur-active-${userName}-`))
                        );
                        if (isUserSlice && !fileName.endsWith(currentSuffix)) {
                            toDelete.push(`/var/tmp/${fileName}`);
                        }
                    }
                    enumerator.close(null);
                    for (const path of toDelete) {
                        try {
                            Gio.File.new_for_path(path).delete(null);
                        } catch (_) {}
                    }
                }
            } catch (cleanupErr) {
                _logError(`[WACK/AlphaManager] Failed to clean old slice cache: ${cleanupErr}`);
            }
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

    if (!sampledAvatarColor) {
        const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
        const overlay = getPromptBlendOverlay(raw);
        sampledAvatarColor = {
            r: raw.r,
            g: raw.g,
            b: raw.b,
            rgba: `rgba(${raw.r}, ${raw.g}, ${raw.b}, 1.0)`,
            hex: rgbToHex(raw.r, raw.g, raw.b),
            overlayR: overlay.overlayR,
            overlayG: overlay.overlayG,
            overlayB: overlay.overlayB,
            overlayAlpha: overlay.blendAlpha,
            overlayRgba: `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`,
        };
    }

    if (shadowAlpha === undefined) {
        shadowAlpha = PROMPT_SHADOW_FLOOR;
    }

    const result = {
        r: sampledPrimary.r,
        g: sampledPrimary.g,
        b: sampledPrimary.b,
        start: { r: sampledStart.r, g: sampledStart.g, b: sampledStart.b },
        end: { r: sampledEnd.r, g: sampledEnd.g, b: sampledEnd.b },
        direction: direction,
        imagePath: imagePath,
        cancelImagePath: cancelImagePath,
        cancelHoverImagePath: cancelHoverImagePath,
        cancelActiveImagePath: cancelActiveImagePath,
        a11yImagePath: a11yImagePath,
        a11yHoverImagePath: a11yHoverImagePath,
        a11yActiveImagePath: a11yActiveImagePath,
        avatarColor: sampledAvatarColor,
        shadowAlpha: shadowAlpha,
    };

    console.debug(`[WACK/AlphaManager] cache MISS for key: ${cacheKey}, computed: ${JSON.stringify(result)}`);
    setCache(cacheKey, result);
    saveCache();
    return result;
}
