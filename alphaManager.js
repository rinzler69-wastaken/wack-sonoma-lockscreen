import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;
const _cache = new Map();
let _loaded = false;
let _loadPromise = null;

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
                    if (data && data.__version__ === 'v8') {
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
        const obj = { __version__: 'v8' };
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

                // 1. Parse starttime
                const starttimeMatch = xmlStr.match(/<starttime>([\s\S]*?)<\/starttime>/);
                let startYear = 2020, startMonth = 0, startDay = 1, startHour = 0, startMin = 0, startSec = 0;
                if (starttimeMatch) {
                    const inner = starttimeMatch[1];
                    const yearM = inner.match(/<year>(\d+)<\/year>/);
                    const monthM = inner.match(/<month>(\d+)<\/month>/);
                    const dayM = inner.match(/<day>(\d+)<\/day>/);
                    const hourM = inner.match(/<hour>(\d+)<\/hour>/);
                    const minM = inner.match(/<minute>(\d+)<\/minute>/);
                    const secM = inner.match(/<second>(\d+)<\/second>/);
                    if (yearM) startYear = parseInt(yearM[1], 10);
                    if (monthM) startMonth = parseInt(monthM[1], 10) - 1;
                    if (dayM) startDay = parseInt(dayM[1], 10);
                    if (hourM) startHour = parseInt(hourM[1], 10);
                    if (minM) startMin = parseInt(minM[1], 10);
                    if (secM) startSec = parseInt(secM[1], 10);
                }
                const startDate = new Date(startYear, startMonth, startDay, startHour, startMin, startSec);

                // 2. Parse static and transition blocks in order
                const blockRegex = /<(static|transition)[^>]*>([\s\S]*?)<\/\1>/g;
                const blocks = [];
                let totalDuration = 0;
                let match;
                while ((match = blockRegex.exec(xmlStr)) !== null) {
                    const type = match[1];
                    const inner = match[2];
                    const durM = inner.match(/<duration>([\d.]+)<\/duration>/);
                    const duration = durM ? parseFloat(durM[1]) : 0;

                    let fileStr = '';
                    if (type === 'static') {
                        const fileM = inner.match(/<file>([\s\S]*?)<\/file>/);
                        fileStr = fileM ? fileM[1].trim() : '';
                    } else {
                        const fromM = inner.match(/<from>([\s\S]*?)<\/from>/);
                        fileStr = fromM ? fromM[1].trim() : '';
                    }

                    blocks.push({ type, duration, file: fileStr });
                    totalDuration += duration;
                }

                if (totalDuration > 0 && blocks.length > 0) {
                    const now = new Date();
                    let diffSeconds = (now.getTime() - startDate.getTime()) / 1000.0;
                    let offset = diffSeconds % totalDuration;
                    if (offset < 0)
                        offset += totalDuration;

                    for (const block of blocks) {
                        if (offset <= block.duration) {
                            resolve(block.file);
                            return;
                        }
                        offset -= block.duration;
                    }
                    resolve(blocks[0].file);
                    return;
                }
            } catch (e) {
                console.error(`[WACK/AlphaManager] Failed to resolve XML slideshow: ${e}`);
            }
            resolve(null);
        });
    });
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

    let targetUri = uri;
    let targetFilePath = null;
    if (uri && uri.startsWith('file://')) {
        const filePath = Gio.File.new_for_uri(uri).get_path();
        if (filePath && filePath.endsWith('.xml')) {
            const resolvedPath = await resolveSlideshowXml(filePath);
            if (resolvedPath) {
                targetFilePath = resolvedPath;
                targetUri = GLib.filename_to_uri(resolvedPath, null);
            }
        } else {
            targetFilePath = filePath;
        }
    }

    const cacheKey = `${targetUri}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${textLuminance}`;
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
            const file = Gio.File.new_for_path(targetFilePath);
            const pixbuf = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (fileObj, readRes) => {
                    try {
                        const stream = file.read_finish(readRes);
                        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                            stream,
                            160,
                            100,
                            false,
                            null,
                            (streamObj, pixRes) => {
                                try {
                                    const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(pixRes);
                                    stream.close(null); // Clean up stream
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

export function clearCache() {
    _cache.clear();
    _loaded = false;
    _loadPromise = null;
}
