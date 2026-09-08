import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { CUPERTINO_PROMPT_VERTICAL_FRACTION } from './constants.js';
import {
    parseHexColor,
    getRelativeLuminance,
    getPerceptualLightness,
    getApcaContrast,
    getPromptBlendAlpha,
    getPromptDarkenedHueColor,
    getPromptInvertedNeutralColor,
    blendOverOpaque,
    PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD,
    PROMPT_BRIGHT_HUE_MIN_CHROMA,
    PROMPT_SHADOW_FLOOR,
    PROMPT_SHADOW_ROOF,
} from './colorUtils.js';
import {
    resolveWallpaperSource,
    getFileMtimeAndSize,
    loadScaledWallpaperPixbuf,
} from './wallpaperUtils.js';
import { sampleChromaWeightedColor } from './wallpaperSampler.js';
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
            console.error(`[WACK/AlphaManager] Failed to read/scale wallpaper for luminance: ${e}`);
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
export async function getWallpaperPromptColor(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        wellH = 0,
        yCenterFraction = null,
    } = params;

    await initCache();

    const { targetUri, targetFilePath } = await resolveWallpaperSource(uri);
    const bgSettings = getBgSettings();
    const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';

    const monitor = Main.layoutManager?.primaryMonitor;
    const monitorWidth = monitor ? monitor.width : 1920;
    const monitorHeight = monitor ? monitor.height : 1080;

    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const cacheKey = `prompt_${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${pictureOptions}_${monitorWidth}x${monitorHeight}_${wellH}_${yCenterFraction ? yCenterFraction.toFixed(4) : 'null'}`;
    if (hasCache(cacheKey)) {
        console.debug(`[WACK/AlphaManager] cache HIT for key: ${cacheKey}`);
        return getCache(cacheKey);
    }

    let sampled = { r: 40, g: 40, b: 40 };

    const yCenter = (yCenterFraction !== undefined && yCenterFraction !== null)
        ? yCenterFraction
        : (CUPERTINO_PROMPT_VERTICAL_FRACTION - 0.3 * (wellH / monitorHeight));

    if (isColor) {
        const c1 = parseHexColor(primaryColor);
        const c2 = parseHexColor(secondaryColor);

        if (shadingType === 0) {
            sampled = c1;
        } else if (shadingType === 1) {
            // The Cupertino password field sits in the lower third, so bias the
            // vertical gradient sample toward that lower-centered band.
            const t = Math.max(0.0, Math.min(1.0, yCenter));
            sampled = {
                r: Math.round(c1.r + (c2.r - c1.r) * t),
                g: Math.round(c1.g + (c2.g - c1.g) * t),
                b: Math.round(c1.b + (c2.b - c1.b) * t),
            };
        } else {
            sampled = {
                r: Math.round((c1.r + c2.r) / 2),
                g: Math.round((c1.g + c2.g) / 2),
                b: Math.round((c1.b + c2.b) / 2),
            };
        }
    } else if (targetFilePath) {
        try {
            const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 256, 256, true);

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
            }

            const y1 = yCenter - 20 / monitorHeight;
            const y2 = yCenter + 20 / monitorHeight;

            const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * 0.40)));
            const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * 0.60)));
            const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * y1)));
            const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * y2)));

            const mappedBounds = {
                x1: xStart / pbWidth,
                x2: xEnd / pbWidth,
                y1: yStart / pbHeight,
                y2: yEnd / pbHeight,
            };

            const centerCoords = {
                x: ((xStart + xEnd) / 2) / pbWidth,
                y: ((yStart + yEnd) / 2) / pbHeight,
            };

            // Sample using chroma-weighted, cluster-aware sampler
            sampled = sampleChromaWeightedColor(pixbuf, mappedBounds, centerCoords);
        } catch (e) {
            console.error(`[WACK/AlphaManager] Failed to sample wallpaper for prompt color: ${e}`);
        }
    }

    const luminance = Math.max(0, Math.min(1, getRelativeLuminance(sampled)));
    const perceptualL = getPerceptualLightness(luminance);

    const maxVal = Math.max(sampled.r, sampled.g, sampled.b);
    const minVal = Math.min(sampled.r, sampled.g, sampled.b);
    const chroma = (maxVal - minVal) / 255.0;
    const isBrightSample = perceptualL > PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD;
    const isBrightHue = isBrightSample && chroma >= PROMPT_BRIGHT_HUE_MIN_CHROMA;

    const blended = isBrightHue
        ? getPromptDarkenedHueColor(sampled)
        : isBrightSample
            ? getPromptInvertedNeutralColor(sampled, perceptualL)
            : blendOverOpaque(
            sampled,
            { r: 255, g: 255, b: 255 },
            getPromptBlendAlpha(sampled)
        );

    // Calculate a dynamic box-shadow alpha to help the entry chip stand out
    // against light details/clouds in the wallpaper.
    let shadowAlpha = PROMPT_SHADOW_FLOOR + (PROMPT_SHADOW_ROOF - PROMPT_SHADOW_FLOOR) * perceptualL;

    // Dark chips already separate well; avoid piling a dirty shadow on top.
    if (isBrightSample) {
        shadowAlpha = PROMPT_SHADOW_FLOOR;
    }

    const result = {
        r: blended.r,
        g: blended.g,
        b: blended.b,
        shadowAlpha: shadowAlpha,
    };

    console.debug(`[WACK/AlphaManager] cache MISS for key: ${cacheKey}, computed: ${JSON.stringify(result)}`);
    setCache(cacheKey, result);
    saveCache();
    return result;
}
