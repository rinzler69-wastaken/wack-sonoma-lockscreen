import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import {
    resolveSlideshowXmlContent,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
    CUPERTINO_CHIP_VERTICAL_FRACTION,
    CANCEL_BUTTON_WIDTH,
    CANCEL_BUTTON_HEIGHT,
    CANCEL_BUTTON_X_OFFSET,
    CANCEL_BUTTON_Y_OFFSET,
    AVATAR_BUTTON_WIDTH,
    AVATAR_BUTTON_HEIGHT,
    AVATAR_BUTTON_X_OFFSET,
    AVATAR_BUTTON_Y_OFFSET,
    A11Y_BUTTON_WIDTH,
    A11Y_BUTTON_HEIGHT,
    A11Y_BUTTON_X_OFFSET,
    A11Y_BUTTON_Y_OFFSET,
    SESSION_BUTTON_WIDTH,
    SESSION_BUTTON_HEIGHT,
    SESSION_BUTTON_X_OFFSET,
    SESSION_BUTTON_Y_OFFSET,
} from './constants.js';
import { _logError } from './mainUtils.js';

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
                _logError(`[WACK/WallpaperUtils] Failed to resolve XML slideshow: ${e}`);
            }
            resolve(null);
        });
    });
}

export function blendPixbufs(pbFrom, pbTo, progress) {
    if (!pbFrom && !pbTo) return null;
    if (!pbFrom) return pbTo;
    if (!pbTo) return pbFrom;
    if (progress <= 0) return pbFrom;
    if (progress >= 1) return pbTo;

    const w = pbFrom.get_width();
    const h = pbFrom.get_height();
    const toW = pbTo.get_width();
    const toH = pbTo.get_height();

    let actualPbTo = pbTo;
    if (toW !== w || toH !== h) {
        actualPbTo = pbTo.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR);
    }

    const fromPix = pbFrom.get_pixels();
    const toPix = actualPbTo.get_pixels();
    const fromChannels = pbFrom.get_n_channels();
    const toChannels = actualPbTo.get_n_channels();
    const fromStride = pbFrom.get_rowstride();
    const toStride = actualPbTo.get_rowstride();

    const outChannels = Math.max(fromChannels, toChannels);
    const outBytes = new Uint8Array(w * h * outChannels);
    const t = Math.max(0, Math.min(1, progress));
    const invT = 1.0 - t;

    for (let y = 0; y < h; y++) {
        const fromRow = y * fromStride;
        const toRow = y * toStride;
        const outRow = y * w * outChannels;
        for (let x = 0; x < w; x++) {
            const fOff = fromRow + x * fromChannels;
            const tOff = toRow + x * toChannels;
            const oOff = outRow + x * outChannels;

            outBytes[oOff] = Math.round(fromPix[fOff] * invT + toPix[tOff] * t);
            outBytes[oOff + 1] = Math.round(fromPix[fOff + 1] * invT + toPix[tOff + 1] * t);
            outBytes[oOff + 2] = Math.round(fromPix[fOff + 2] * invT + toPix[tOff + 2] * t);
            if (outChannels === 4) {
                const aFrom = fromChannels === 4 ? fromPix[fOff + 3] : 255;
                const aTo = toChannels === 4 ? toPix[tOff + 3] : 255;
                outBytes[oOff + 3] = Math.round(aFrom * invT + aTo * t);
            }
        }
    }

    const bytesObj = GLib.Bytes.new(outBytes);
    return GdkPixbuf.Pixbuf.new_from_bytes(
        bytesObj,
        GdkPixbuf.Colorspace.RGB,
        outChannels === 4,
        8,
        w,
        h,
        w * outChannels
    );
}

export async function resolveWallpaperSource(uri) {
    let targetUri = uri;
    let targetFilePath = null;
    let transitionInfo = null;
    let isXml = false;
    let xmlName = null;

    if (uri) {
        let filePath = null;
        if (uri.startsWith('file://')) {
            filePath = Gio.File.new_for_uri(uri).get_path();
        } else if (uri.startsWith('/')) {
            filePath = uri;
            // Normalize targetUri to be a file:// URI for caching consistency
            targetUri = Gio.File.new_for_path(uri).get_uri();
        }

        if (filePath) {
            if (filePath.endsWith('.xml')) {
                isXml = true;
                xmlName = GLib.path_get_basename(filePath).replace(/\.xml$/i, '');
                const resolved = await resolveSlideshowXml(filePath);
                if (resolved) {
                    if (typeof resolved === 'string') {
                        targetFilePath = resolved;
                        targetUri = Gio.File.new_for_path(resolved).get_uri();
                    } else if (resolved.filePath) {
                        targetFilePath = resolved.filePath;
                        targetUri = Gio.File.new_for_path(resolved.filePath).get_uri();
                        transitionInfo = resolved;
                    }
                }
            } else {
                targetFilePath = filePath;
            }
        }
    }

    return { targetUri, targetFilePath, transitionInfo, isXml, xmlName };
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


/**
 * Normalizes screen bounding boxes for Prompt chip and all peripheral chrome buttons
 * (Cancel, Avatar, Accessibility, Session) into [0, 1] relative screen coordinates.
 *
 * @param {object} params Parameter map containing bounds and alignment hints
 * @param {number} monitorWidth Primary monitor width
 * @param {number} monitorHeight Primary monitor height
 * @returns {{
 *   prompt: {x1: number, x2: number, y1: number, y2: number},
 *   cancel: {x1: number, x2: number, y1: number, y2: number},
 *   avatar: {x1: number, x2: number, y1: number, y2: number},
 *   a11y: {x1: number, x2: number, y1: number, y2: number},
 *   session: {x1: number, x2: number, y1: number, y2: number}
 * }}
 */
export function normalizePromptChromeBounds(params, monitorWidth = 1920, monitorHeight = 1080) {
    const {
        promptBounds = null,
        cancelBounds = null,
        avatarBounds = null,
        a11yBounds = null,
        sessionBounds = null,
        suspendBounds = null,
        restartBounds = null,
        powerOffBounds = null,
        yCenterFraction = null,
        wellH = 0,
    } = params;

    // Prompt bounds
    let normX1, normX2, normY1, normY2;
    if (promptBounds &&
        promptBounds.x1 != null &&
        promptBounds.x2 != null &&
        promptBounds.x2 > promptBounds.x1 &&
        promptBounds.y1 != null &&
        promptBounds.y2 != null &&
        promptBounds.y2 > promptBounds.y1 &&
        promptBounds.x1 >= 0 &&
        promptBounds.x2 <= 1 &&
        promptBounds.y1 >= 0 &&
        promptBounds.y2 <= 1) {
        normX1 = promptBounds.x1;
        normX2 = promptBounds.x2;
        normY1 = promptBounds.y1;
        normY2 = promptBounds.y2;
    } else {
        const halfW = (promptBounds?.x2 && promptBounds?.x1)
            ? (promptBounds.x2 - promptBounds.x1) / 2
            : (170 / monitorWidth) / 2;
        normX1 = Math.max(0, 0.50 - halfW);
        normX2 = Math.min(1, 0.50 + halfW);
        const halfH = 18 / monitorHeight;
        const targetY = (yCenterFraction != null && yCenterFraction > 0 && yCenterFraction < 1)
            ? yCenterFraction
            : (CUPERTINO_CHIP_VERTICAL_FRACTION ?? 0.9025);
        normY1 = Math.max(0, targetY - halfH);
        normY2 = Math.min(1, targetY + halfH);
    }

    // Cancel button bounds
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
        const baseCenterX = normX1 - (12 / monitorWidth) - btnHalfW;
        const baseCenterY = (normY1 + normY2) / 2;
        const centerX = baseCenterX + offsetX;
        const centerY = baseCenterY + offsetY;
        normCancelX1 = Math.max(0, Math.min(1, centerX - btnHalfW));
        normCancelX2 = Math.max(0, Math.min(1, centerX + btnHalfW));
        normCancelY1 = Math.max(0, Math.min(1, centerY - btnHalfH));
        normCancelY2 = Math.max(0, Math.min(1, centerY + btnHalfH));
    }

    // Avatar bounds
    let normAvatarX1, normAvatarX2, normAvatarY1, normAvatarY2;
    const avOffsetX = AVATAR_BUTTON_X_OFFSET / monitorWidth;
    const avOffsetY = AVATAR_BUTTON_Y_OFFSET / monitorHeight;
    const avatarHalfW = (AVATAR_BUTTON_WIDTH / 2) / monitorWidth;
    const avatarHalfH = (AVATAR_BUTTON_HEIGHT / 2) / monitorHeight;

    if (avatarBounds &&
        avatarBounds.x1 != null && avatarBounds.x2 != null &&
        avatarBounds.x2 > avatarBounds.x1) {
        normAvatarX1 = Math.max(0, Math.min(1, avatarBounds.x1 + avOffsetX));
        normAvatarX2 = Math.max(0, Math.min(1, avatarBounds.x2 + avOffsetX));
        normAvatarY1 = Math.max(0, Math.min(1, avatarBounds.y1 + avOffsetY));
        normAvatarY2 = Math.max(0, Math.min(1, avatarBounds.y2 + avOffsetY));
    } else {
        normAvatarX1 = Math.max(0, 0.50 - avatarHalfW + avOffsetX);
        normAvatarX2 = Math.min(1, 0.50 + avatarHalfW + avOffsetX);
        const anchorH = wellH > 0 ? Math.floor(wellH * 1.3) : 108;
        const targetStackY = Math.floor(monitorHeight * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
        normAvatarY1 = Math.max(0, (targetStackY / monitorHeight) + avOffsetY);
        normAvatarY2 = Math.min(1, ((targetStackY + AVATAR_BUTTON_HEIGHT) / monitorHeight) + avOffsetY);
    }

    // A11y button bounds
    let normA11yX1, normA11yX2, normA11yY1, normA11yY2;
    const a11yHalfW = (A11Y_BUTTON_WIDTH / 2) / monitorWidth;
    const a11yHalfH = (A11Y_BUTTON_HEIGHT / 2) / monitorHeight;

    if (a11yBounds &&
        a11yBounds.x1 != null && a11yBounds.x2 != null &&
        a11yBounds.x2 > a11yBounds.x1 &&
        a11yBounds.y1 != null && a11yBounds.y2 != null &&
        a11yBounds.y2 > a11yBounds.y1) {
        normA11yX1 = Math.max(0, Math.min(1, a11yBounds.x1));
        normA11yX2 = Math.max(0, Math.min(1, a11yBounds.x2));
        normA11yY1 = Math.max(0, Math.min(1, a11yBounds.y1));
        normA11yY2 = Math.max(0, Math.min(1, a11yBounds.y2));
    } else {
        const a11yOffsetX = A11Y_BUTTON_X_OFFSET / monitorWidth;
        const a11yOffsetY = A11Y_BUTTON_Y_OFFSET / monitorHeight;
        const fallbackA11yCenterX = 1.0 - (24 + A11Y_BUTTON_WIDTH / 2) / monitorWidth + a11yOffsetX;
        const fallbackA11yCenterY = 1.0 - (24 + A11Y_BUTTON_HEIGHT / 2) / monitorHeight + a11yOffsetY;
        normA11yX1 = Math.max(0, Math.min(1, fallbackA11yCenterX - a11yHalfW));
        normA11yX2 = Math.max(0, Math.min(1, fallbackA11yCenterX + a11yHalfW));
        normA11yY1 = Math.max(0, Math.min(1, fallbackA11yCenterY - a11yHalfH));
        normA11yY2 = Math.max(0, Math.min(1, fallbackA11yCenterY + a11yHalfH));
    }

    // Session button bounds
    let normSessionX1, normSessionX2, normSessionY1, normSessionY2;
    const sessionHalfW = (SESSION_BUTTON_WIDTH / 2) / monitorWidth;
    const sessionHalfH = (SESSION_BUTTON_HEIGHT / 2) / monitorHeight;

    if (sessionBounds &&
        sessionBounds.x1 != null && sessionBounds.x2 != null &&
        sessionBounds.x2 > sessionBounds.x1 &&
        sessionBounds.y1 != null && sessionBounds.y2 != null &&
        sessionBounds.y2 > sessionBounds.y1) {
        normSessionX1 = Math.max(0, Math.min(1, sessionBounds.x1));
        normSessionX2 = Math.max(0, Math.min(1, sessionBounds.x2));
        normSessionY1 = Math.max(0, Math.min(1, sessionBounds.y1));
        normSessionY2 = Math.max(0, Math.min(1, sessionBounds.y2));
    } else {
        const sessionOffsetX = SESSION_BUTTON_X_OFFSET / monitorWidth;
        const sessionOffsetY = SESSION_BUTTON_Y_OFFSET / monitorHeight;
        const fallbackSessionCenterX = 1.0 - (24 + A11Y_BUTTON_WIDTH + 12 + SESSION_BUTTON_WIDTH / 2) / monitorWidth + sessionOffsetX;
        const fallbackSessionCenterY = 1.0 - (24 + SESSION_BUTTON_HEIGHT / 2) / monitorHeight + sessionOffsetY;
        normSessionX1 = Math.max(0, Math.min(1, fallbackSessionCenterX - sessionHalfW));
        normSessionX2 = Math.max(0, Math.min(1, fallbackSessionCenterX + sessionHalfW));
        normSessionY1 = Math.max(0, Math.min(1, fallbackSessionCenterY - sessionHalfH));
        normSessionY2 = Math.max(0, Math.min(1, fallbackSessionCenterY + sessionHalfH));
    }

    // CSA Suspend button bounds
    let normSuspendX1, normSuspendX2, normSuspendY1, normSuspendY2;
    const csaHalfW = (38 / 2) / monitorWidth;
    const csaHalfH = (38 / 2) / monitorHeight;
    const csaFallbackY = 0.72;

    if (suspendBounds &&
        suspendBounds.x1 != null && suspendBounds.x2 != null &&
        suspendBounds.x2 > suspendBounds.x1 &&
        suspendBounds.y1 != null && suspendBounds.y2 != null &&
        suspendBounds.y2 > suspendBounds.y1) {
        normSuspendX1 = Math.max(0, Math.min(1, suspendBounds.x1));
        normSuspendX2 = Math.max(0, Math.min(1, suspendBounds.x2));
        normSuspendY1 = Math.max(0, Math.min(1, suspendBounds.y1));
        normSuspendY2 = Math.max(0, Math.min(1, suspendBounds.y2));
    } else {
        const fallbackSuspendCenterX = 0.50 - (76 / monitorWidth);
        normSuspendX1 = Math.max(0, Math.min(1, fallbackSuspendCenterX - csaHalfW));
        normSuspendX2 = Math.max(0, Math.min(1, fallbackSuspendCenterX + csaHalfW));
        normSuspendY1 = Math.max(0, Math.min(1, csaFallbackY - csaHalfH));
        normSuspendY2 = Math.max(0, Math.min(1, csaFallbackY + csaHalfH));
    }

    // CSA Restart button bounds
    let normRestartX1, normRestartX2, normRestartY1, normRestartY2;
    if (restartBounds &&
        restartBounds.x1 != null && restartBounds.x2 != null &&
        restartBounds.x2 > restartBounds.x1 &&
        restartBounds.y1 != null && restartBounds.y2 != null &&
        restartBounds.y2 > restartBounds.y1) {
        normRestartX1 = Math.max(0, Math.min(1, restartBounds.x1));
        normRestartX2 = Math.max(0, Math.min(1, restartBounds.x2));
        normRestartY1 = Math.max(0, Math.min(1, restartBounds.y1));
        normRestartY2 = Math.max(0, Math.min(1, restartBounds.y2));
    } else {
        const fallbackRestartCenterX = 0.50;
        normRestartX1 = Math.max(0, Math.min(1, fallbackRestartCenterX - csaHalfW));
        normRestartX2 = Math.max(0, Math.min(1, fallbackRestartCenterX + csaHalfW));
        normRestartY1 = Math.max(0, Math.min(1, csaFallbackY - csaHalfH));
        normRestartY2 = Math.max(0, Math.min(1, csaFallbackY + csaHalfH));
    }

    // CSA Power Off button bounds
    let normPowerOffX1, normPowerOffX2, normPowerOffY1, normPowerOffY2;
    if (powerOffBounds &&
        powerOffBounds.x1 != null && powerOffBounds.x2 != null &&
        powerOffBounds.x2 > powerOffBounds.x1 &&
        powerOffBounds.y1 != null && powerOffBounds.y2 != null &&
        powerOffBounds.y2 > powerOffBounds.y1) {
        normPowerOffX1 = Math.max(0, Math.min(1, powerOffBounds.x1));
        normPowerOffX2 = Math.max(0, Math.min(1, powerOffBounds.x2));
        normPowerOffY1 = Math.max(0, Math.min(1, powerOffBounds.y1));
        normPowerOffY2 = Math.max(0, Math.min(1, powerOffBounds.y2));
    } else {
        const fallbackPowerOffCenterX = 0.50 + (76 / monitorWidth);
        normPowerOffX1 = Math.max(0, Math.min(1, fallbackPowerOffCenterX - csaHalfW));
        normPowerOffX2 = Math.max(0, Math.min(1, fallbackPowerOffCenterX + csaHalfW));
        normPowerOffY1 = Math.max(0, Math.min(1, csaFallbackY - csaHalfH));
        normPowerOffY2 = Math.max(0, Math.min(1, csaFallbackY + csaHalfH));
    }

    return {
        prompt: { x1: normX1, x2: normX2, y1: normY1, y2: normY2 },
        cancel: { x1: normCancelX1, x2: normCancelX2, y1: normCancelY1, y2: normCancelY2 },
        avatar: { x1: normAvatarX1, x2: normAvatarX2, y1: normAvatarY1, y2: normAvatarY2 },
        a11y: { x1: normA11yX1, x2: normA11yX2, y1: normA11yY1, y2: normA11yY2 },
        session: { x1: normSessionX1, x2: normSessionX2, y1: normSessionY1, y2: normSessionY2 },
        suspend: { x1: normSuspendX1, x2: normSuspendX2, y1: normSuspendY1, y2: normSuspendY2 },
        restart: { x1: normRestartX1, x2: normRestartX2, y1: normRestartY1, y2: normRestartY2 },
        powerOff: { x1: normPowerOffX1, x2: normPowerOffX2, y1: normPowerOffY1, y2: normPowerOffY2 },
    };
}

/**
 * Calculates target load dimensions for a wallpaper image based on source dimensions and sizing options.
 *
 * @param {object|null} fileInfo Source image file metadata { width, height }
 * @param {string} pictureOptions Picture sizing option ('zoom', 'scaled', 'stretched', etc.)
 * @param {number} monitorWidth Primary monitor width
 * @param {number} monitorHeight Primary monitor height
 * @returns {{targetW: number, targetH: number}}
 */
export function getWallpaperTargetDimensions(fileInfo, pictureOptions, monitorWidth = 1920, monitorHeight = 1080) {
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

    return { targetW, targetH };
}

/**
 * Computes the visible crop rectangle (offset and dimensions) of a wallpaper pixbuf
 * within the monitor viewport according to pictureOptions.
 *
 * @param {number} pbWidth Loaded pixbuf width
 * @param {number} pbHeight Loaded pixbuf height
 * @param {number} monitorWidth Monitor width
 * @param {number} monitorHeight Monitor height
 * @param {string} pictureOptions Sizing option ('zoom', 'scaled', etc.)
 * @returns {{visibleX: number, visibleY: number, visibleW: number, visibleH: number}}
 */
export function getVisibleCoverViewport(pbWidth, pbHeight, monitorWidth, monitorHeight, pictureOptions) {
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

    return { visibleX, visibleY, visibleW, visibleH };
}

/**
 * Maps a normalized screen rectangle [0, 1] to pixel crop bounds and normalized [0, 1]
 * bounds relative to the loaded pixbuf dimensions.
 *
 * @param {{x1: number, x2: number, y1: number, y2: number}} normBounds
 * @param {number} pbWidth
 * @param {number} pbHeight
 * @param {{visibleX: number, visibleY: number, visibleW: number, visibleH: number}} visibleViewport
 * @returns {{
 *   x1: number, x2: number, y1: number, y2: number,
 *   xStart: number, xEnd: number, yStart: number, yEnd: number
 * }}
 */
export function mapNormalizedBoundsToPixbuf(normBounds, pbWidth, pbHeight, visibleViewport) {
    const { visibleX, visibleY, visibleW, visibleH } = visibleViewport;

    const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normBounds.x1)));
    const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normBounds.x2)));
    const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normBounds.y1)));
    const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normBounds.y2)));

    return {
        x1: xStart / pbWidth,
        x2: xEnd / pbWidth,
        y1: yStart / pbHeight,
        y2: yEnd / pbHeight,
        xStart,
        xEnd,
        yStart,
        yEnd,
    };
}
