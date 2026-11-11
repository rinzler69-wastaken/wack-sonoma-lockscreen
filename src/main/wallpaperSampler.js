import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { _logError } from './mainUtils.js';
import {
    resolvePromptVisualState,
    applyPromptVisualState,
    parseHexColor,
    rgbToHsl,
    hslToRgb,
    PROMPT_SHADOW_FLOOR,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    clamp255,
} from './colorUtils.js';


/**
 * Samples a rectangular region from a source wallpaper pixbuf and computes its average color.
 *
 * @param {GdkPixbuf.Pixbuf} srcPixbuf Source wallpaper pixbuf
 * @param {object} bounds Normalized crop coordinates { x1, x2, y1, y2 }
 * @returns {{r: number, g: number, b: number}|null}
 */
export function sampleRegionAverageColor(srcPixbuf, bounds) {
    if (!srcPixbuf || !bounds)
        return null;

    const pbWidth = srcPixbuf.get_width();
    const pbHeight = srcPixbuf.get_height();

    const startX = Math.max(0, Math.min(pbWidth - 1, Math.floor(bounds.x1 * pbWidth)));
    const endX = Math.max(1, Math.min(pbWidth, Math.ceil(bounds.x2 * pbWidth)));
    const startY = Math.max(0, Math.min(pbHeight - 1, Math.floor(bounds.y1 * pbHeight)));
    const endY = Math.max(1, Math.min(pbHeight, Math.ceil(bounds.y2 * pbHeight)));

    const cropW = endX - startX;
    const cropH = endY - startY;
    if (cropW <= 0 || cropH <= 0)
        return null;

    const rawPix = srcPixbuf.new_subpixbuf(startX, startY, cropW, cropH);
    const pixels = rawPix.get_pixels();
    const nChannels = rawPix.get_n_channels();
    const stride = rawPix.get_rowstride();

    let sumR = 0, sumG = 0, sumB = 0;
    let diffSum = 0, diffCount = 0;
    const stepX = Math.max(1, Math.floor(cropW / 32));
    const stepY = Math.max(1, Math.floor(cropH / 32));
    let samples = 0;

    for (let y = 0; y < cropH; y += stepY) {
        const rowOff = y * stride;
        for (let x = 0; x < cropW; x += stepX) {
            const off = rowOff + x * nChannels;
            const r = pixels[off];
            const g = pixels[off + 1];
            const b = pixels[off + 2];
            sumR += r;
            sumG += g;
            sumB += b;
            samples++;

            if (x + stepX < cropW && y + stepY < cropH) {
                const offRight = rowOff + (x + stepX) * nChannels;
                const offDown = (y + stepY) * stride + x * nChannels;
                const rR = pixels[offRight], gR = pixels[offRight + 1], bR = pixels[offRight + 2];
                const rD = pixels[offDown], gD = pixels[offDown + 1], bD = pixels[offDown + 2];

                const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
                const lumR = (0.2126 * rR + 0.7152 * gR + 0.0722 * bR) / 255.0;
                const lumD = (0.2126 * rD + 0.7152 * gD + 0.0722 * bD) / 255.0;

                diffSum += (Math.abs(lum - lumR) + Math.abs(lum - lumD)) / 2.0;
                diffCount++;
            }
        }
    }

    if (samples === 0)
        return null;

    const noise = diffCount > 0 ? (diffSum / diffCount) : 0.0;

    return {
        r: clamp255(sumR / samples),
        g: clamp255(sumG / samples),
        b: clamp255(sumB / samples),
        noise: Math.max(0.0, noise),
    };
}

/**
 * Samples the clock region (upper center) of a wallpaper pixbuf for average RGB and local noise.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf Source wallpaper pixbuf
 * @param {string} pictureOptions Picture sizing option ('zoom', 'spanned', etc.)
 * @param {object|null} monitor Monitor geometry { width, height }
 * @returns {{bgR: number, bgG: number, bgB: number, bgNoise: number}}
 */
export function sampleClockRegionLuminance(pixbuf, pictureOptions = 'zoom', monitor = null) {
    if (!pixbuf)
        return { bgR: 40, bgG: 40, bgB: 40, bgNoise: 0.0 };

    const pbWidth = pixbuf.get_width();
    const pbHeight = pixbuf.get_height();
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();

    const monitorWidth = monitor?.width ?? 1920;
    const monitorHeight = monitor?.height ?? 1080;
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

    let bgR = 40, bgG = 40, bgB = 40;
    let bgNoise = 0.0;

    if (count > 0) {
        bgR = rSum / count;
        bgG = gSum / count;
        bgB = bSum / count;
    }

    if (diffCount > 0) {
        bgNoise = diffSum / diffCount;
    }

    return { bgR, bgG, bgB, bgNoise };
}

/**
 * Computes sampled colors and visual state for solid colors and gradients (shadingType 0, 1, 2)
 * across Prompt chip, Cancel button, Avatar, A11y, and Session buttons.
 *
 * @param {object} params
 * @param {string} params.primaryColor Hex primary color string
 * @param {string} params.secondaryColor Hex secondary color string
 * @param {number} params.shadingType Shading type (0: solid, 1: vertical gradient, 2: horizontal gradient)
 * @param {object} params.normBounds Normalized bounds object { prompt, cancel, avatar, a11y, session }
 * @param {number} [params.whiteBlendAlpha] White overlay blend factor
 * @returns {{
 *   sampledStart: object,
 *   sampledEnd: object,
 *   sampledPrimary: object,
 *   sampledCancelColor: object,
 *   sampledAvatarColor: object,
 *   sampledA11yColor: object,
 *   sampledSessionColor: object,
 *   promptVisualState: object,
 *   shadowAlpha: number,
 *   direction: string
 * }}
 */
export function sampleSolidGradientPromptColors({
    primaryColor,
    secondaryColor,
    shadingType,
    normBounds,
    whiteBlendAlpha = CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
}) {
    const { prompt, cancel, avatar, a11y, session, suspend, restart, powerOff } = normBounds;
    const c1 = parseHexColor(primaryColor);
    const c2 = parseHexColor(secondaryColor);

    let sampledStart = null;
    let sampledEnd = null;
    let sampledPrimary = null;
    let direction = 'vertical';

    if (shadingType === 0) {
        const hsl = rgbToHsl(c1.r, c1.g, c1.b);
        const specularL = Math.min(1.0, hsl.l + 0.05);
        sampledStart = hslToRgb(hsl.h, hsl.s, specularL);
        sampledEnd = { ...c1 };
        sampledPrimary = { ...c1 };
    } else if (shadingType === 1) {
        const y1 = prompt.y1;
        const y2 = prompt.y2;
        const yt = (prompt.y1 + prompt.y2) / 2;
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
        direction = 'horizontal';
        const x1 = prompt.x1;
        const x2 = prompt.x2;
        const xt = (prompt.x1 + prompt.x2) / 2;
        sampledStart = {
            r: Math.round(c1.r + (c2.r - c1.r) * x1),
            g: Math.round(c1.g + (c2.g - c1.g) * x1),
            b: Math.round(c1.b + (c2.b - c1.b) * x1),
        };
        sampledEnd = {
            r: Math.round(c1.r + (c2.r - c1.r) * x2),
            g: Math.round(c1.g + (c2.g - c1.g) * x2),
            b: Math.round(c1.b + (c2.b - c1.b) * x2),
        };
        sampledPrimary = {
            r: Math.round(c1.r + (c2.r - c1.r) * xt),
            g: Math.round(c1.g + (c2.g - c1.g) * xt),
            b: Math.round(c1.b + (c2.b - c1.b) * xt),
        };
    }

    const promptVisualState = resolvePromptVisualState(sampledPrimary, whiteBlendAlpha);
    const shadowAlpha = promptVisualState.shadowAlpha;

    sampledStart = applyPromptVisualState(sampledStart, promptVisualState, { preblend: true });
    sampledEnd = applyPromptVisualState(sampledEnd, promptVisualState, { preblend: true });
    sampledPrimary = applyPromptVisualState(sampledPrimary, promptVisualState, { preblend: true });
    const sampledAvatarColor = applyPromptVisualState(
        { r: sampledPrimary.rawR, g: sampledPrimary.rawG, b: sampledPrimary.rawB },
        promptVisualState,
        { preblend: true }
    );

    let rawCancel;
    let rawA11y;
    let rawSession;
    let rawSuspend;
    let rawRestart;
    let rawPowerOff;
    if (shadingType === 0) {
        rawCancel = { ...c1 };
        rawA11y = { ...c1 };
        rawSession = { ...c1 };
        rawSuspend = { ...c1 };
        rawRestart = { ...c1 };
        rawPowerOff = { ...c1 };
    } else if (shadingType === 1) {
        const sampleY = (b) => {
            const yt = b ? (b.y1 + b.y2) / 2 : 0.5;
            return {
                r: Math.round(c1.r + (c2.r - c1.r) * yt),
                g: Math.round(c1.g + (c2.g - c1.g) * yt),
                b: Math.round(c1.b + (c2.b - c1.b) * yt),
            };
        };
        rawCancel = sampleY(cancel);
        rawA11y = sampleY(a11y);
        rawSession = sampleY(session);
        rawSuspend = sampleY(suspend);
        rawRestart = sampleY(restart);
        rawPowerOff = sampleY(powerOff);
    } else {
        const sampleX = (b) => {
            const xt = b ? (b.x1 + b.x2) / 2 : 0.5;
            return {
                r: Math.round(c1.r + (c2.r - c1.r) * xt),
                g: Math.round(c1.g + (c2.g - c1.g) * xt),
                b: Math.round(c1.b + (c2.b - c1.b) * xt),
            };
        };
        rawCancel = sampleX(cancel);
        rawA11y = sampleX(a11y);
        rawSession = sampleX(session);
        rawSuspend = sampleX(suspend);
        rawRestart = sampleX(restart);
        rawPowerOff = sampleX(powerOff);
    }

    const sampledCancelColor = applyPromptVisualState(
        rawCancel,
        promptVisualState,
        { preblend: true }
    );
    const sampledA11yColor = applyPromptVisualState(
        rawA11y,
        resolvePromptVisualState(rawA11y, whiteBlendAlpha),
        { preblend: true }
    );
    const sampledSessionColor = applyPromptVisualState(
        rawSession,
        resolvePromptVisualState(rawSession, whiteBlendAlpha),
        { preblend: true }
    );
    const sampledSuspendColor = applyPromptVisualState(
        rawSuspend,
        resolvePromptVisualState(rawSuspend, whiteBlendAlpha),
        { preblend: true }
    );
    const sampledRestartColor = applyPromptVisualState(
        rawRestart,
        resolvePromptVisualState(rawRestart, whiteBlendAlpha),
        { preblend: true }
    );
    const sampledPowerOffColor = applyPromptVisualState(
        rawPowerOff,
        resolvePromptVisualState(rawPowerOff, whiteBlendAlpha),
        { preblend: true }
    );

    return {
        sampledStart,
        sampledEnd,
        sampledPrimary,
        sampledCancelColor,
        sampledAvatarColor,
        sampledA11yColor,
        sampledSessionColor,
        sampledSuspendColor,
        sampledRestartColor,
        sampledPowerOffColor,
        promptVisualState,
        shadowAlpha,
        direction,
    };
}

/**
 * Samples wallpaper region average colors and applies visual state for chrome buttons (Cancel, Avatar, A11y, Session, CSA Power Buttons).
 *
 * @param {object} params
 * @param {GdkPixbuf.Pixbuf} params.pixbuf Loaded wallpaper pixbuf
 * @param {object} params.mappedBoundsMap Map of normalized bounds relative to pixbuf { cancel, avatar, a11y, session, suspend, restart, powerOff }
 * @param {object|null} params.promptVisualState Visual state to apply (or derive for buttons)
 * @param {object|null} [params.fallbackPrimaryColor] Fallback color if sample fails
 * @param {number} [params.whiteBlendAlpha] White overlay blend factor
 * @returns {{
 *   cancelColor: object|null,
 *   avatarColor: object,
 *   a11yColor: object,
 *   sessionColor: object,
 *   suspendColor: object,
 *   restartColor: object,
 *   powerOffColor: object,
 *   effectivePromptVisualState: object
 * }}
 */
export function sampleWallpaperChromeColors({
    pixbuf,
    mappedBoundsMap,
    promptVisualState,
    fallbackPrimaryColor = null,
    whiteBlendAlpha = CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
}) {
    const {
        cancel: cancelMappedBounds,
        avatar: avatarMappedBounds,
        a11y: a11yMappedBounds,
        session: sessionMappedBounds,
        suspend: suspendMappedBounds,
        restart: restartMappedBounds,
        powerOff: powerOffMappedBounds,
    } = mappedBoundsMap;

    const fallback = fallbackPrimaryColor || { r: 40, g: 40, b: 40 };

    // Cancel
    let sampledCancelColor = null;
    if (cancelMappedBounds) {
        const rawCancel = sampleRegionAverageColor(pixbuf, cancelMappedBounds) || fallback;
        sampledCancelColor = applyPromptVisualState(rawCancel, promptVisualState, { preblend: true });
    }

    // Avatar
    const rawAvatar = (avatarMappedBounds ? sampleRegionAverageColor(pixbuf, avatarMappedBounds) : null) || fallback;
    const effectivePromptVisualState = promptVisualState ?? resolvePromptVisualState(rawAvatar, whiteBlendAlpha);
    const sampledAvatarColor = applyPromptVisualState(rawAvatar, effectivePromptVisualState, { preblend: true });

    // A11y
    const rawA11y = (a11yMappedBounds ? sampleRegionAverageColor(pixbuf, a11yMappedBounds) : null) || fallback;
    const sampledA11yColor = applyPromptVisualState(
        rawA11y,
        resolvePromptVisualState(rawA11y, whiteBlendAlpha),
        { preblend: true }
    );

    // Session
    const rawSession = (sessionMappedBounds ? sampleRegionAverageColor(pixbuf, sessionMappedBounds) : null) || fallback;
    const sampledSessionColor = applyPromptVisualState(
        rawSession,
        resolvePromptVisualState(rawSession, whiteBlendAlpha),
        { preblend: true }
    );

    // CSA Suspend
    const rawSuspend = (suspendMappedBounds ? sampleRegionAverageColor(pixbuf, suspendMappedBounds) : null) || fallback;
    const sampledSuspendColor = applyPromptVisualState(
        rawSuspend,
        resolvePromptVisualState(rawSuspend, whiteBlendAlpha),
        { preblend: true }
    );

    // CSA Restart
    const rawRestart = (restartMappedBounds ? sampleRegionAverageColor(pixbuf, restartMappedBounds) : null) || fallback;
    const sampledRestartColor = applyPromptVisualState(
        rawRestart,
        resolvePromptVisualState(rawRestart, whiteBlendAlpha),
        { preblend: true }
    );

    // CSA Power Off
    const rawPowerOff = (powerOffMappedBounds ? sampleRegionAverageColor(pixbuf, powerOffMappedBounds) : null) || fallback;
    const sampledPowerOffColor = applyPromptVisualState(
        rawPowerOff,
        resolvePromptVisualState(rawPowerOff, whiteBlendAlpha),
        { preblend: true }
    );

    return {
        cancelColor: sampledCancelColor,
        avatarColor: sampledAvatarColor,
        a11yColor: sampledA11yColor,
        sessionColor: sampledSessionColor,
        suspendColor: sampledSuspendColor,
        restartColor: sampledRestartColor,
        powerOffColor: sampledPowerOffColor,
        effectivePromptVisualState,
    };
}

