import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    resolveSlideshowXmlContent,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
} from './constants.js';

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;
const _cache = new Map();
let _loaded = false;
let _loadPromise = null;
let _bgSettings = null;

function getBgSettings() {
    if (!_bgSettings)
        _bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
    return _bgSettings;
}

function getWallpaperFileInfo(filePath) {
    return new Promise((resolve) => {
        GdkPixbuf.Pixbuf.get_file_info_async(filePath, null, (source, result) => {
            try {
                const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(result);
                if (width > 0 && height > 0) {
                    resolve({ width, height });
                } else {
                    resolve(null);
                }
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function mapScreenToSourceCoords(x1, x2, y1, y2, Rw, Rs, pictureOptions, Ww, Wh, Sw, Sh) {
    let mapFn;

    if (pictureOptions === 'zoom') {
        mapFn = (u, v) => {
            let x_norm, y_norm;
            if (Rw > Rs) {
                x_norm = u * (Rs / Rw) + (1 - Rs / Rw) / 2;
                y_norm = v;
            } else {
                x_norm = u;
                y_norm = v * (Rw / Rs) + (1 - Rw / Rs) / 2;
            }
            return { x: x_norm, y: y_norm };
        };
    } else if (pictureOptions === 'scaled') {
        mapFn = (u, v) => {
            let x_norm, y_norm;
            if (Rw > Rs) {
                x_norm = u;
                y_norm = v * (Rw / Rs) + (1 - Rw / Rs) / 2;
            } else {
                x_norm = u * (Rs / Rw) + (1 - Rs / Rw) / 2;
                y_norm = v;
            }
            return {
                x: Math.max(0.0, Math.min(1.0, x_norm)),
                y: Math.max(0.0, Math.min(1.0, y_norm))
            };
        };
    } else if (pictureOptions === 'centered') {
        mapFn = (u, v) => {
            const x_norm = u * (Sw / Ww) + (1 - Sw / Ww) / 2;
            const y_norm = v * (Sh / Wh) + (1 - Sh / Wh) / 2;
            return {
                x: Math.max(0.0, Math.min(1.0, x_norm)),
                y: Math.max(0.0, Math.min(1.0, y_norm))
            };
        };
    } else if (pictureOptions === 'stretched') {
        mapFn = (u, v) => {
            return { x: u, y: v };
        };
    } else if (pictureOptions === 'wallpaper') {
        // Tiled-at-native-size starting from the top-left of the screen
        mapFn = (u, v) => {
            const x_pixel = u * Sw;
            const y_pixel = v * Sh;
            const x_norm = Ww > 0 ? (x_pixel % Ww) / Ww : 0;
            const y_norm = Wh > 0 ? (y_pixel % Wh) / Wh : 0;
            return { x: x_norm, y: y_norm };
        };
    } else {
        // Fallback for spanned (which spans across multiple monitors violating single monitor layout
        // assumptions), none, or invalid settings - default to zoom math
        mapFn = (u, v) => {
            let x_norm, y_norm;
            if (Rw > Rs) {
                x_norm = u * (Rs / Rw) + (1 - Rs / Rw) / 2;
                y_norm = v;
            } else {
                x_norm = u;
                y_norm = v * (Rw / Rs) + (1 - Rw / Rs) / 2;
            }
            return { x: x_norm, y: y_norm };
        };
    }

    const p1 = mapFn(x1, y1);
    const p2 = mapFn(x2, y2);

    return {
        x1: Math.min(p1.x, p2.x),
        x2: Math.max(p1.x, p2.x),
        y1: Math.min(p1.y, p2.y),
        y2: Math.max(p1.y, p2.y)
    };
}

function rgbToHsl(r, g, b) {
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;

    const max = Math.max(rNorm, gNorm, bNorm);
    const min = Math.min(rNorm, gNorm, bNorm);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
            case gNorm: h = (bNorm - rNorm) / d + 2; break;
            case bNorm: h = (rNorm - gNorm) / d + 4; break;
        }
        h /= 6;
    }

    return {
        h: h * 360,
        s: s,
        l: l
    };
}

function sampleChromaWeightedColor(pixbuf, bounds, centerCoords) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const {
        startX,
        endX,
        startY,
        endY,
    } = getPixbufSampleBounds(pixbuf, bounds);

    const numBins = 18;
    const hueBins = new Array(numBins).fill(0);
    const sThreshold = 0.15;
    let totalHueMass = 0;

    const width = endX - startX;
    const height = endY - startY;
    const pixelCache = new Array(width * height);

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const offset = y * rowstride + x * channels;
            const r = pixels[offset];
            const g = pixels[offset + 1];
            const b = pixels[offset + 2];

            const hsl = rgbToHsl(r, g, b);
            const w = hsl.s * hsl.s;

            const idx = (y - startY) * width + (x - startX);
            pixelCache[idx] = { r, g, b, hsl, w };

            if (hsl.s >= sThreshold) {
                const binIndex = Math.floor(hsl.h / (360 / numBins)) % numBins;
                hueBins[binIndex] += w;
                totalHueMass += w;
            }
        }
    }

    let isSingleHueDominant = true;
    if (totalHueMass > 0) {
        let maxWindowMass = 0;
        for (let i = 0; i < numBins; i++) {
            const windowMass = hueBins[(i - 1 + numBins) % numBins] +
                hueBins[i] +
                hueBins[(i + 1) % numBins];
            if (windowMass > maxWindowMass) {
                maxWindowMass = windowMass;
            }
        }
        if (maxWindowMass / totalHueMass < 0.70) {
            isSingleHueDominant = false;
        }
    }

    let rSum = 0, gSum = 0, bSum = 0, wSum = 0;

    if (isSingleHueDominant) {
        for (let i = 0; i < pixelCache.length; i++) {
            const p = pixelCache[i];
            const weight = Math.max(0.0001, p.w);
            rSum += p.r * weight;
            gSum += p.g * weight;
            bSum += p.b * weight;
            wSum += weight;
        }
    } else {
        const widthPixbuf = pixbuf.get_width();
        const heightPixbuf = pixbuf.get_height();
        const centerPixelX = Math.max(0, Math.min(widthPixbuf - 1, Math.round(centerCoords.x * widthPixbuf)));
        const centerPixelY = Math.max(0, Math.min(heightPixbuf - 1, Math.round(centerCoords.y * heightPixbuf)));

        const radius = 5;
        const startX_local = Math.max(startX, centerPixelX - radius);
        const endX_local = Math.min(endX, centerPixelX + radius + 1);
        const startY_local = Math.max(startY, centerPixelY - radius);
        const endY_local = Math.min(endY, centerPixelY + radius + 1);

        for (let y = startY_local; y < endY_local; y++) {
            for (let x = startX_local; x < endX_local; x++) {
                const idx = (y - startY) * width + (x - startX);
                const p = pixelCache[idx];
                const weight = Math.max(0.0001, p.w);
                rSum += p.r * weight;
                gSum += p.g * weight;
                bSum += p.b * weight;
                wSum += weight;
            }
        }
    }

    if (wSum === 0) {
        return { r: 40, g: 40, b: 40 };
    }

    return {
        r: Math.round(rSum / wSum),
        g: Math.round(gSum / wSum),
        b: Math.round(bSum / wSum),
    };
}

export function initCache() {
    if (_loadPromise)
        return _loadPromise;

    _loadPromise = new Promise((resolve) => {
        if (_loaded) {
            resolve();
            return;
        }
        _loaded = true;

        const file = Gio.File.new_for_path(CACHE_FILE);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [success, contents] = file.load_contents_finish(res);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data && data.__version__ === 'v1') {
                        for (const [k, v] of Object.entries(data)) {
                            if (k !== '__version__')
                                _cache.set(k, v);
                        }
                    } else {
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                }
            } catch (e) {
                // File does not exist or JSON parsing failed; ignore.
            }
            resolve();
        });
    });

    return _loadPromise;
}

function saveCache() {
    try {
        const obj = { __version__: 'v1' };
        for (const [k, v] of _cache.entries())
            obj[k] = v;
        const data = JSON.stringify(obj);
        const file = Gio.File.new_for_path(CACHE_FILE);
        const bytes = new TextEncoder().encode(data);
        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null,
            (obj2, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.error(`[WACK/AlphaManager] Failed to save persistent cache: ${e}`);
                }
            }
        );
    } catch (e) {
        console.error(`[WACK/AlphaManager] Failed to save persistent cache: ${e}`);
    }
}

function blendOverOpaque(base, overlay, alpha) {
    return {
        r: Math.round(base.r * (1 - alpha) + overlay.r * alpha),
        g: Math.round(base.g * (1 - alpha) + overlay.g * alpha),
        b: Math.round(base.b * (1 - alpha) + overlay.b * alpha),
    };
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

function getRelativeLuminance(color) {
    const channelLum = (val) => {
        const s = val / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channelLum(color.r) +
        0.7152 * channelLum(color.g) +
        0.0722 * channelLum(color.b);
}

// WCAG relative luminance is gamma-linear, not perceptually linear (mid-gray sits
// at ~0.18-0.22 relative luminance, not 0.5). Convert to CIE L* so the adaptive
// alpha responds to how bright the sample actually LOOKS, not the raw light value.
function getPerceptualLightness(luminance) {
    return luminance <= 0.008856
        ? luminance * 9.033
        : Math.pow(luminance, 1 / 3) * 1.16 - 0.16; // 0.0-1.0 scale (CIE L* / 100)
}

function getApcaContrast(txtR, txtG, txtB, bgR, bgG, bgB) {
    const simpleExp = (chan) => Math.pow(chan / 255.0, 2.4);

    let txtY = 0.2126729 * simpleExp(txtR) +
        0.7151522 * simpleExp(txtG) +
        0.0721750 * simpleExp(txtB);

    let bgY = 0.2126729 * simpleExp(bgR) +
        0.7151522 * simpleExp(bgG) +
        0.0721750 * simpleExp(bgB);

    const blkThrs = 0.022;
    const blkClmp = 1.414;
    txtY = (txtY > blkThrs) ? txtY : txtY + Math.pow(blkThrs - txtY, blkClmp);
    bgY = (bgY > blkThrs) ? bgY : bgY + Math.pow(blkThrs - bgY, blkClmp);

    if (Math.abs(bgY - txtY) < 0.0005)
        return 0.0;

    let sapc = 0.0;
    if (bgY > txtY) {
        sapc = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
        return (sapc < 0.1) ? 0.0 : (sapc - 0.027) * 100.0;
    } else {
        sapc = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14;
        return (sapc > -0.1) ? 0.0 : (sapc + 0.027) * 100.0;
    }
}

function resolveSlideshowXml(xmlPath) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(xmlPath);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [success, content] = file.load_contents_finish(res);
                if (!success || !content) {
                    resolve(null);
                    return;
                }

                const xmlStr = new TextDecoder('utf-8').decode(content);
                const resolved = resolveSlideshowXmlContent(xmlStr);
                resolve(resolved);
                return;
            } catch (e) {
                console.error(`[WACK/AlphaManager] Failed to resolve XML slideshow: ${e}`);
            }
            resolve(null);
        });
    });
}

async function resolveWallpaperSource(uri) {
    let targetUri = uri;
    let targetFilePath = null;

    if (uri) {
        let filePath = null;
        if (uri.startsWith('file://')) {
            filePath = Gio.File.new_for_uri(uri).get_path();
        } else if (uri.startsWith('/')) {
            filePath = uri;
            // Normalize targetUri to be a file:// URI for caching consistency
            try {
                targetUri = GLib.filename_to_uri(uri, null);
            } catch (e) {
                targetUri = `file://${uri}`;
            }
        }

        if (filePath) {
            if (filePath.endsWith('.xml')) {
                const resolvedPath = await resolveSlideshowXml(filePath);
                if (resolvedPath) {
                    targetFilePath = resolvedPath;
                    targetUri = GLib.filename_to_uri(resolvedPath, null);
                }
            } else {
                targetFilePath = filePath;
            }
        }
    }

    return { targetUri, targetFilePath };
}

async function getFileMtimeAndSize(filePath) {
    if (!filePath)
        return { mtime: 0, size: 0 };
    const file = Gio.File.new_for_path(filePath);
    return new Promise((resolve) => {
        file.query_info_async(
            'time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (fileObj, res) => {
                try {
                    const info = file.query_info_finish(res);
                    const mtime = info.get_attribute_uint64('time::modified');
                    const size = info.get_attribute_uint64('standard::size');
                    resolve({ mtime, size });
                } catch (e) {
                    resolve({ mtime: 0, size: 0 });
                }
            }
        );
    });
}

async function loadScaledWallpaperPixbuf(targetFilePath, width, height) {
    const file = Gio.File.new_for_path(targetFilePath);
    return await new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (fileObj, readRes) => {
            try {
                const stream = file.read_finish(readRes);
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                    stream,
                    width,
                    height,
                    false,
                    null,
                    (streamObj, pixRes) => {
                        try {
                            const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(pixRes);
                            stream.close(null);
                            resolve(pb);
                        } catch (e) {
                            stream.close(null);
                            reject(e);
                        }
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    });
}

function getPixbufSampleBounds(pixbuf, bounds) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    return {
        startX: Math.max(0, Math.min(width, Math.floor(bounds.x1 * width))),
        endX: Math.max(1, Math.min(width, Math.ceil(bounds.x2 * width))),
        startY: Math.max(0, Math.min(height, Math.floor(bounds.y1 * height))),
        endY: Math.max(1, Math.min(height, Math.ceil(bounds.y2 * height))),
    };
}

function samplePixbufDominantColor(pixbuf, bounds) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const {
        startX,
        endX,
        startY,
        endY,
    } = getPixbufSampleBounds(pixbuf, bounds);

    const bucketSize = 32;
    const buckets = new Map();

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const offset = y * rowstride + x * channels;
            const r = pixels[offset];
            const g = pixels[offset + 1];
            const b = pixels[offset + 2];

            const qR = Math.floor(r / bucketSize);
            const qG = Math.floor(g / bucketSize);
            const qB = Math.floor(b / bucketSize);
            const key = `${qR},${qG},${qB}`;

            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = {
                    count: 0,
                    rSum: 0,
                    gSum: 0,
                    bSum: 0,
                };
                buckets.set(key, bucket);
            }

            bucket.count++;
            bucket.rSum += r;
            bucket.gSum += g;
            bucket.bSum += b;
        }
    }

    if (buckets.size === 0)
        return { r: 40, g: 40, b: 40 };

    let dominantBucket = null;
    for (const bucket of buckets.values()) {
        if (!dominantBucket || bucket.count > dominantBucket.count)
            dominantBucket = bucket;
    }

    return {
        r: Math.round(dominantBucket.rSum / dominantBucket.count),
        g: Math.round(dominantBucket.gSum / dominantBucket.count),
        b: Math.round(dominantBucket.bSum / dominantBucket.count),
    };
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
    if (_cache.has(cacheKey))
        return _cache.get(cacheKey);

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
            const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 160, 100);

            const pixels = pixbuf.get_pixels();
            const channels = pixbuf.get_n_channels();
            const rowstride = pixbuf.get_rowstride();

            let rSum = 0, gSum = 0, bSum = 0;
            let diffSum = 0;
            let count = 0;
            let diffCount = 0;

            // Clock bounding box on a 160x100 grid:
            // X: 40 to 120 (middle 50%)
            // Y: 5 to 35 (upper portion)
            for (let y = 5; y < 35; y++) {
                for (let x = 40; x < 120; x++) {
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
                    if (x < 119 && y < 34) {
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

    _cache.set(cacheKey, alpha);
    saveCache();
    return alpha;
}

// Tuning range for the adaptive prompt-chip white-blend alpha.
// Calibrated against the real macOS Sonoma lockscreen:
//   At FLOOR (0.12): chip is 12% white on very dark wallpapers — keeps the chip dark.
//   At ROOF  (0.70): chip is 70% white on bright wallpapers — keeps the chip frosted-white.
const PROMPT_ALPHA_FLOOR = 0.16;
const PROMPT_ALPHA_ROOF = 0.24;

/**
 * Computes the adaptive white-blend alpha for the Cupertino prompt chip based on
 * the sampled backdrop color's perceptual lightness and saturation.
 *
 * Darker wallpapers -> lower alpha (less white blend) -> prompt chip stays dark.
 * Brighter wallpapers -> higher alpha (more white blend) -> prompt chip stays light.
 * Saturated wallpapers -> vibrancy boost (more white blend) to avoid excessive coloring.
 *
 * @param {{r: number, g: number, b: number}} sampled
 * @returns {number} alpha between PROMPT_ALPHA_FLOOR and PROMPT_ALPHA_ROOF
 */
function getPromptBlendAlpha(sampled) {
    const luminance = Math.max(0, Math.min(1, getRelativeLuminance(sampled)));
    const perceptualL = getPerceptualLightness(luminance);

    // Darker samples (perceptualL near 0) -> alpha near FLOOR (less white, darker chip).
    // Brighter samples (perceptualL near 1) -> alpha near ROOF (more white, lighter chip).
    let alpha = PROMPT_ALPHA_FLOOR + (PROMPT_ALPHA_ROOF - PROMPT_ALPHA_FLOOR) * perceptualL;

    // Vibrancy boost: colours that are simultaneously saturated AND mid-to-bright
    // (the "neon green / lime / vivid yellow" band) get pushed back toward the roof.
    // chromaLuminanceProduct peaks for saturated bright hues (greens, cyans, yellows)
    // and is near-zero for dark colours or unsaturated pastels/greys.
    // The 0.75 cap prevents pure-white-like edge cases from over-boosting.
    const maxVal = Math.max(sampled.r, sampled.g, sampled.b);
    const minVal = Math.min(sampled.r, sampled.g, sampled.b);
    const chroma = (maxVal - minVal) / 255.0;
    const vibrancyProduct = Math.min(0.75, chroma * perceptualL);
    alpha = alpha + (PROMPT_ALPHA_ROOF - alpha) * vibrancyProduct;

    return Math.max(PROMPT_ALPHA_FLOOR, Math.min(PROMPT_ALPHA_ROOF, alpha));
}

/**
 * Samples the wallpaper behind the Cupertino password prompt and blends it with
 * white at an adaptive alpha to mimic frosted glass while staying fully opaque
 * and reliably light/legible regardless of the backdrop.
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
    } = params;

    await initCache();

    const { targetUri, targetFilePath } = await resolveWallpaperSource(uri);
    const bgSettings = getBgSettings();
    const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';

    const monitor = Main.layoutManager?.primaryMonitor;
    const monitorWidth = monitor ? monitor.width : 1920;
    const monitorHeight = monitor ? monitor.height : 1080;

    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const cacheKey = `prompt_${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${pictureOptions}_${monitorWidth}x${monitorHeight}`;
    if (_cache.has(cacheKey)) {
        console.log(`[WACK/AlphaManager] cache HIT for key: ${cacheKey}`);
        return _cache.get(cacheKey);
    }

    let sampled = { r: 40, g: 40, b: 40 };

    if (isColor) {
        const c1 = parseHexColor(primaryColor);
        const c2 = parseHexColor(secondaryColor);

        if (shadingType === 0) {
            sampled = c1;
        } else if (shadingType === 1) {
            // The Cupertino password field sits in the lower third, so bias the
            // vertical gradient sample toward that lower-centered band.
            const t = 0.76;
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
            const pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 160, 100);

            const Rs = monitorWidth / monitorHeight;

            let nativeWidth = 160;
            let nativeHeight = 100;
            const info = await getWallpaperFileInfo(targetFilePath);
            if (info) {
                nativeWidth = info.width;
                nativeHeight = info.height;
            }
            const Rw = nativeWidth / nativeHeight;

            const mappedBounds = mapScreenToSourceCoords(
                0.4, 0.6, 0.88, 1.0,
                Rw, Rs,
                pictureOptions,
                nativeWidth, nativeHeight,
                monitorWidth, monitorHeight
            );

            const centerMapped = mapScreenToSourceCoords(
                0.5, 0.5, CUPERTINO_PROMPT_VERTICAL_FRACTION, CUPERTINO_PROMPT_VERTICAL_FRACTION,
                Rw, Rs,
                pictureOptions,
                nativeWidth, nativeHeight,
                monitorWidth, monitorHeight
            );
            const centerCoords = { x: centerMapped.x1, y: centerMapped.y1 };

            // Sample using chroma-weighted, cluster-aware sampler
            sampled = sampleChromaWeightedColor(pixbuf, mappedBounds, centerCoords);
        } catch (e) {
            console.error(`[WACK/AlphaManager] Failed to sample wallpaper for prompt color: ${e}`);
        }
    }

    const alpha = getPromptBlendAlpha(sampled);
    const blended = blendOverOpaque(
        sampled,
        { r: 255, g: 255, b: 255 },
        alpha
    );
    console.log(`[WACK/AlphaManager] cache MISS for key: ${cacheKey}, computed: ${JSON.stringify(blended)}`);
    _cache.set(cacheKey, blended);
    saveCache();
    return blended;
}

export function clearCache() {
    _cache.clear();
    _loaded = false;
    _loadPromise = null;
    _bgSettings = null;
}
