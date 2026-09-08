// Tuning range for the adaptive prompt-chip white-blend alpha.
// Calibrated against the real macOS Sonoma lockscreen:
//   At FLOOR (0.16): chip is 16% white on very dark wallpapers — keeps the chip dark.
//   At ROOF  (0.224): chip is 22.4% white on bright wallpapers — keeps the chip frosted-white.
export const PROMPT_ALPHA_FLOOR = 0.16;
export const PROMPT_ALPHA_ROOF = 0.224;

// Bright colorful samples should become a darker version of themselves, rather
// than getting muddied by blending toward black. This tunes the target lightness
// for that hue-preserving darken step.
export const PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR = 0.925;
export const PROMPT_BRIGHT_HUE_MIN_CHROMA = 0.08;
export const PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD = 0.8075;
export const PROMPT_INVERSE_ALPHA_CEILING = 0.125;

// Tuning range for the dynamic password prompt box-shadow alpha.
//   At FLOOR (0.0175): subtle shadow on very dark wallpapers.
//   At ROOF  (0.1175): maximum shadow depth on bright wallpapers (like pink clouds).
export const PROMPT_SHADOW_FLOOR = 0.0175;
export const PROMPT_SHADOW_ROOF = 0.1175;

export function rgbToHsl(r, g, b) {
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
        l: l,
    };
}

export function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;

    if (s === 0) {
        const value = Math.round(l * 255);
        return { r: value, g: value, b: value };
    }

    const hueToRgb = (p, q, t) => {
        let channel = t;
        if (channel < 0)
            channel += 1;
        if (channel > 1)
            channel -= 1;
        if (channel < 1 / 6)
            return p + (q - p) * 6 * channel;
        if (channel < 1 / 2)
            return q;
        if (channel < 2 / 3)
            return p + (q - p) * (2 / 3 - channel) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return {
        r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
        g: Math.round(hueToRgb(p, q, hue) * 255),
        b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
    };
}

export function isPixelColorful(r, g, b) {
    const maxVal = Math.max(r, g, b);
    const minVal = Math.min(r, g, b);
    const chroma = maxVal - minVal;
    const lightness = (maxVal + minVal) / 510;

    if (chroma < 25)
        return false;
    if (chroma < 45 && lightness > 0.75)
        return false;
    return true;
}

export function blendOverOpaque(base, overlay, alpha) {
    return {
        r: Math.round(base.r * (1 - alpha) + overlay.r * alpha),
        g: Math.round(base.g * (1 - alpha) + overlay.g * alpha),
        b: Math.round(base.b * (1 - alpha) + overlay.b * alpha),
    };
}

export function parseHexColor(hex) {
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

export function getRelativeLuminance(color) {
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
export function getPerceptualLightness(luminance) {
    return luminance <= 0.008856
        ? luminance * 9.033
        : Math.pow(luminance, 1 / 3) * 1.16 - 0.16; // 0.0-1.0 scale (CIE L* / 100)
}

export function getApcaContrast(txtR, txtG, txtB, bgR, bgG, bgB) {
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
export function getPromptBlendAlpha(sampled) {
    const luminance = Math.max(0, Math.min(1, getRelativeLuminance(sampled)));
    const perceptualL = getPerceptualLightness(luminance);

    let alpha = PROMPT_ALPHA_FLOOR + (PROMPT_ALPHA_ROOF - PROMPT_ALPHA_FLOOR) * perceptualL;

    const maxVal = Math.max(sampled.r, sampled.g, sampled.b);
    const minVal = Math.min(sampled.r, sampled.g, sampled.b);
    const chroma = (maxVal - minVal) / 255.0;
    const vibrancyProduct = Math.min(0.75, chroma * perceptualL);
    alpha = alpha + (PROMPT_ALPHA_ROOF - alpha) * vibrancyProduct;

    return Math.max(PROMPT_ALPHA_FLOOR, Math.min(PROMPT_ALPHA_ROOF, alpha));
}

export function getPromptDarkenedHueColor(sampled) {
    const hsl = rgbToHsl(sampled.r, sampled.g, sampled.b);
    return hslToRgb(
        hsl.h,
        hsl.s,
        Math.max(0, Math.min(1, hsl.l * PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR))
    );
}

export function getPromptInvertedNeutralColor(sampled, perceptualL) {
    const baseAlpha = getPromptBlendAlpha(sampled);
    const t = Math.max(0, Math.min(
        1,
        (perceptualL - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD) /
            (1 - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD)
    ));
    const alpha = baseAlpha + (PROMPT_INVERSE_ALPHA_CEILING - baseAlpha) * t;

    return blendOverOpaque(sampled, { r: 0, g: 0, b: 0 }, alpha);
}
