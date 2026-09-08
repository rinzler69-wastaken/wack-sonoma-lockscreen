import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { resolveSlideshowXmlContent } from './constants.js';

export function getWallpaperFileInfo(filePath) {
    return new Promise((resolve) => {
        GdkPixbuf.Pixbuf.get_file_info_async(filePath, null, (source, result) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(result);
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

export function mapScreenToSourceCoords(x1, x2, y1, y2, Rw, Rs, pictureOptions, Ww, Wh, Sw, Sh) {
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
                y: Math.max(0.0, Math.min(1.0, y_norm)),
            };
        };
    } else if (pictureOptions === 'centered') {
        mapFn = (u, v) => {
            const x_norm = u * (Sw / Ww) + (1 - Sw / Ww) / 2;
            const y_norm = v * (Sh / Wh) + (1 - Sh / Wh) / 2;
            return {
                x: Math.max(0.0, Math.min(1.0, x_norm)),
                y: Math.max(0.0, Math.min(1.0, y_norm)),
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
        y2: Math.max(p1.y, p2.y),
    };
}

export function resolveSlideshowXml(xmlPath) {
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
                console.error(`[WACK/WallpaperUtils] Failed to resolve XML slideshow: ${e}`);
            }
            resolve(null);
        });
    });
}

export async function resolveWallpaperSource(uri) {
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

export async function getFileMtimeAndSize(filePath) {
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

export async function loadScaledWallpaperPixbuf(targetFilePath, width, height, preserveAspectRatio = false) {
    const file = Gio.File.new_for_path(targetFilePath);
    return await new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (fileObj, readRes) => {
            try {
                const stream = file.read_finish(readRes);
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                    stream,
                    width,
                    height,
                    preserveAspectRatio,
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

export function getPixbufSampleBounds(pixbuf, bounds) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    return {
        startX: Math.max(0, Math.min(width, Math.floor(bounds.x1 * width))),
        endX: Math.max(1, Math.min(width, Math.ceil(bounds.x2 * width))),
        startY: Math.max(0, Math.min(height, Math.floor(bounds.y1 * height))),
        endY: Math.max(1, Math.min(height, Math.ceil(bounds.y2 * height))),
    };
}
