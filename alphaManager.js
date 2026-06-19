import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;
const _cache = new Map();
let _loaded = false;

function loadCache() {
    if (_loaded)
        return;
    _loaded = true;
    try {
        const file = Gio.File.new_for_path(CACHE_FILE);
        if (file.query_exists(null)) {
            const [success, contents] = file.load_contents(null);
            if (success) {
                const data = JSON.parse(new TextDecoder().decode(contents));
                for (const [k, v] of Object.entries(data))
                    _cache.set(k, v);
            }
        }
    } catch (e) {
        console.error(`[WACK/AlphaManager] Failed to load persistent cache: ${e}`);
    }
}

function saveCache() {
    try {
        const obj = {};
        for (const [k, v] of _cache.entries())
            obj[k] = v;
        const data = JSON.stringify(obj);
        const file = Gio.File.new_for_path(CACHE_FILE);
        file.replace_contents(
            new TextEncoder().encode(data),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );
    } catch (e) {
        console.error(`[WACK/AlphaManager] Failed to save persistent cache: ${e}`);
    }
}

function parseHexColor(hex) {
    if (!hex)
        return { r: 0, g: 0, b: 0 };
    const cleaned = hex.replace('#', '');
    if (cleaned.length === 3) {
        return {
            r: parseInt(cleaned[0] + cleaned[0], 16),
            g: parseInt(cleaned[1] + cleaned[1], 16),
            b: parseInt(cleaned[2] + cleaned[2], 16),
        };
    } else if (cleaned.length === 6) {
        return {
            r: parseInt(cleaned.substring(0, 2), 16),
            g: parseInt(cleaned.substring(2, 4), 16),
            b: parseInt(cleaned.substring(4, 6), 16),
        };
    }
    return { r: 0, g: 0, b: 0 };
}

function getLuminance(r, g, b) {
    return (0.2126 * (r / 255)) + (0.7152 * (g / 255)) + (0.0722 * (b / 255));
}

/**
 * Calculates the ideal clock opacity (alpha) based on the background color/wallpaper behind it.
 * Falls back to 0.6 if there's sufficient contrast, scaling up to 0.8 if contrast is very low.
 *
 * @param {Object} params
 * @param {string} params.uri - Wallpaper picture URI
 * @param {boolean} params.isColor - True if the background option is color/none
 * @param {string} params.primaryColor - Hex value for primary color
 * @param {string} params.secondaryColor - Hex value for secondary color
 * @param {number} params.shadingType - Shading type (0=Solid, 1=Vertical, 2=Horizontal)
 * @param {number} [params.textLuminance=1.0] - Target text luminance (default 1.0, e.g. white text)
 * @returns {number} The target alpha value between 0.6 and 0.8
 */
export function getWallpaperAlpha(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        textLuminance = 1.0,
    } = params;

    loadCache();
    const cacheKey = `${uri}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${textLuminance}`;
    if (_cache.has(cacheKey))
        return _cache.get(cacheKey);

    let bgR = 40, bgG = 40, bgB = 40; // Dark grey default fallback

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
    } else if (uri && uri.startsWith('file://')) {
        const filePath = Gio.File.new_for_uri(uri).get_path();
        if (filePath) {
            try {
                const file = Gio.File.new_for_path(filePath);
                if (file.query_exists(null)) {
                    // Fast downscale to a 160x100 thumbnail in memory
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, 160, 100, false);
                    const pixels = pixbuf.get_pixels();
                    const channels = pixbuf.get_n_channels();
                    const rowstride = pixbuf.get_rowstride();

                    let rSum = 0, gSum = 0, bSum = 0;
                    let count = 0;

                    // Clock bounding box on a 160x100 grid:
                    // X: 40 to 120 (middle 50%)
                    // Y: 5 to 35 (upper portion)
                    for (let y = 5; y < 35; y++) {
                        for (let x = 40; x < 120; x++) {
                            const offset = y * rowstride + x * channels;
                            rSum += pixels[offset];
                            gSum += pixels[offset + 1];
                            bSum += pixels[offset + 2];
                            count++;
                        }
                    }

                    if (count > 0) {
                        bgR = rSum / count;
                        bgG = gSum / count;
                        bgB = bSum / count;
                    }
                }
            } catch (e) {
                console.error(`[WACK/AlphaManager] Failed to read/scale wallpaper for luminance: ${e}`);
            }
        }
    }

    const bgLuminance = getLuminance(bgR, bgG, bgB);
    const luminanceDiff = Math.abs(textLuminance - bgLuminance);

    // Contrast factor: 0.0 (excellent contrast) to 1.0 (poor/barely legible contrast)
    const factor = Math.max(0, Math.min(1, (0.6 - luminanceDiff) / 0.3));

    // Alpha ranges between 0.6 (baseline floor) and 0.8 (extremely bright roof)
    const alpha = 0.6 + (0.2 * factor);

    _cache.set(cacheKey, alpha);
    saveCache();
    return alpha;
}

export function clearCache() {
    _cache.clear();
    _loaded = false;
}
