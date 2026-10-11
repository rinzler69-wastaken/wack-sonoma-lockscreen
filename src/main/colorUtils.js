// Tuning range for the adaptive prompt-chip white-blend alpha.
// Calibrated against the real macOS Sonoma lockscreen:
//   At FLOOR (0.16): chip is 16% white on very dark wallpapers — keeps the chip dark.
//   At ROOF  (0.224): chip is 22.4% white on bright wallpapers — keeps the chip frosted-white.
export const PROMPT_ALPHA_FLOOR = 0.16;
export const PROMPT_ALPHA_ROOF = 0.224;
export const CUPERTINO_PROMPT_WHITE_BLEND_ALPHA = 0.16;

// Bright colorful samples should become a darker version of themselves, rather
// than getting muddied by blending toward black. This tunes the target lightness
// for that hue-preserving darken step.
export const PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR = 0.935;
export const PROMPT_BRIGHT_HUE_MIN_CHROMA = 0.08;
export const PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD = 0.72;
export const PROMPT_INVERSE_ALPHA_CEILING = 0.18;

// Tuning range for the dynamic password prompt box-shadow alpha.
//   At FLOOR (0.0175): subtle shadow on very dark wallpapers.
//   At ROOF  (0.1175): maximum shadow depth on bright wallpapers (like pink clouds).
export const PROMPT_SHADOW_FLOOR = 0.0175;
export const PROMPT_SHADOW_ROOF = 0.1175;

export const PROMPT_VISUAL_ALGORITHM_VERSION = 27;

export function clamp01(val) {
    if (typeof val !== 'number' || isNaN(val))
        return 0.0;
    return Math.max(0.0, Math.min(1.0, val));
}

export function clamp255(val) {
    if (typeof val !== 'number' || isNaN(val))
        return 0;
    return Math.max(0, Math.min(255, Math.round(val)));
}

export function rgbToHsl(r, g, b) {
    const rNorm = clamp01(r / 255);
    const gNorm = clamp01(g / 255);
    const bNorm = clamp01(b / 255);

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
        s: clamp01(s),
        l: clamp01(l),
    };
}

export function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    const sat = clamp01(s);
    const light = clamp01(l);

    if (sat === 0) {
        const value = clamp255(light * 255);
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

    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;

    return {
        r: clamp255(hueToRgb(p, q, hue + 1 / 3) * 255),
        g: clamp255(hueToRgb(p, q, hue) * 255),
        b: clamp255(hueToRgb(p, q, hue - 1 / 3) * 255),
    };
}

export function blendOverOpaque(base, overlay, alpha) {
    const a = clamp01(alpha);
    const invA = 1 - a;
    return {
        r: clamp255((base?.r ?? 0) * invA + (overlay?.r ?? 0) * a),
        g: clamp255((base?.g ?? 0) * invA + (overlay?.g ?? 0) * a),
        b: clamp255((base?.b ?? 0) * invA + (overlay?.b ?? 0) * a),
    };
}

export function parseHexColor(hex) {
    if (!hex)
        return { r: 0, g: 0, b: 0 };
    const cleaned = hex.replace('#', '');
    if (cleaned.length === 3) {
        return {
            r: parseInt(cleaned[0] + cleaned[0], 16) || 0,
            g: parseInt(cleaned[1] + cleaned[1], 16) || 0,
            b: parseInt(cleaned[2] + cleaned[2], 16) || 0,
        };
    } else if (cleaned.length === 6) {
        return {
            r: parseInt(cleaned.substring(0, 2), 16) || 0,
            g: parseInt(cleaned.substring(2, 4), 16) || 0,
            b: parseInt(cleaned.substring(4, 6), 16) || 0,
        };
    }
    return { r: 0, g: 0, b: 0 };
}

export function rgbToHex(r, g, b) {
    const toHex = c => clamp255(c).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function getRelativeLuminance(color) {
    const r = clamp255(color?.r ?? 0);
    const g = clamp255(color?.g ?? 0);
    const b = clamp255(color?.b ?? 0);

    const channelLum = (val) => {
        const s = val / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return clamp01(0.2126 * channelLum(r) +
        0.7152 * channelLum(g) +
        0.0722 * channelLum(b));
}

// WCAG relative luminance is gamma-linear, not perceptually linear (mid-gray sits
// at ~0.18-0.22 relative luminance, not 0.5). Convert to CIE L* so the adaptive
// alpha responds to how bright the sample actually LOOKS, not the raw light value.
export function getPerceptualLightness(luminance) {
    const lum = clamp01(luminance);
    const lStar = lum <= 0.008856
        ? lum * 9.033
        : Math.pow(lum, 1 / 3) * 1.16 - 0.16;
    return clamp01(lStar);
}

export function getApcaContrast(txtR, txtG, txtB, bgR, bgG, bgB) {
    const simpleExp = (chan) => Math.pow(clamp255(chan) / 255.0, 2.4);

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
 * Canonical perceptual analysis of a sampled color region.
 * Single source of truth for color metrics across the extension.
 *
 * @param {{r: number, g: number, b: number}} color
 * @param {number} [noise=0.0]
 * @returns {{r: number, g: number, b: number, luminance: number, perceptualLightness: number, chroma: number, noise: number}}
 */
export function analyzePerceptualColor(color, noise = 0.0) {
    const r = clamp255(color?.r ?? 0);
    const g = clamp255(color?.g ?? 0);
    const b = clamp255(color?.b ?? 0);
    const safeNoise = Math.max(0.0, typeof noise === 'number' && !isNaN(noise) ? noise : 0.0);

    const luminance = getRelativeLuminance({ r, g, b });
    const perceptualLightness = getPerceptualLightness(luminance);
    const maxVal = Math.max(r, g, b);
    const minVal = Math.min(r, g, b);
    const chroma = clamp01((maxVal - minVal) / 255.0);

    return {
        r,
        g,
        b,
        luminance,
        perceptualLightness,
        chroma,
        noise: safeNoise,
    };
}

/**
 * Computes the adaptive white-blend alpha for the Cupertino prompt chip based on
 * the sampled backdrop color's perceptual lightness and saturation.
 *
 * @param {{r: number, g: number, b: number}} sampled
 * @returns {number} alpha between PROMPT_ALPHA_FLOOR and PROMPT_ALPHA_ROOF
 */
export function getPromptBlendAlpha(sampled) {
    const analysis = analyzePerceptualColor(sampled);
    let alpha = PROMPT_ALPHA_FLOOR + (PROMPT_ALPHA_ROOF - PROMPT_ALPHA_FLOOR) * analysis.perceptualLightness;
    const vibrancyProduct = Math.min(0.75, analysis.chroma * analysis.perceptualLightness);
    alpha = alpha + (PROMPT_ALPHA_ROOF - alpha) * vibrancyProduct;

    return Math.max(PROMPT_ALPHA_FLOOR, Math.min(PROMPT_ALPHA_ROOF, alpha));
}

export function getPromptDarkenedHueColor(sampled) {
    const r = clamp255(sampled?.r ?? 0);
    const g = clamp255(sampled?.g ?? 0);
    const b = clamp255(sampled?.b ?? 0);
    const hsl = rgbToHsl(r, g, b);
    return hslToRgb(
        hsl.h,
        hsl.s,
        clamp01(hsl.l * PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR)
    );
}

/**
 * Resolves the base visual policy from perceptual analysis.
 *
 * @param {object} analysis Analyzed perceptual characteristics
 * @param {object} [options]
 * @param {number|null} [options.whiteBlendAlpha=null]
 * @returns {object} Base visual policy decision
 */
export function resolveBaseVisualPolicy(analysis, options = {}) {
    const whiteBlendAlpha = options.whiteBlendAlpha ?? null;
    const { r, g, b, luminance, perceptualLightness, chroma, noise } = analysis;

    const isBrightSample = perceptualLightness > PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD;
    const isBrightHue = isBrightSample && chroma >= PROMPT_BRIGHT_HUE_MIN_CHROMA;
    const useInverse = isBrightSample;

    const adaptiveAlpha = getPromptBlendAlpha({ r, g, b });
    const baseAlpha = whiteBlendAlpha !== null && whiteBlendAlpha !== undefined
        ? clamp01(whiteBlendAlpha)
        : adaptiveAlpha;

    let overlayR, overlayG, overlayB, blendAlpha, treatment;

    if (isBrightHue) {
        treatment = 'darkened-hue';
        const darkened = getPromptDarkenedHueColor({ r, g, b });
        overlayR = darkened.r;
        overlayG = darkened.g;
        overlayB = darkened.b;
        blendAlpha = 0.55;
    } else if (isBrightSample) {
        treatment = 'inverse-neutral';
        overlayR = 0;
        overlayG = 0;
        overlayB = 0;
        const t = clamp01(
            (perceptualLightness - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD) /
            (1.0 - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD)
        );
        blendAlpha = PROMPT_INVERSE_ALPHA_CEILING * t;
    } else {
        treatment = 'normal';
        overlayR = 255;
        overlayG = 255;
        overlayB = 255;
        blendAlpha = baseAlpha;
    }

    const overlay = {
        r: overlayR,
        g: overlayG,
        b: overlayB,
        alpha: blendAlpha,
        rgba: `rgba(${overlayR}, ${overlayG}, ${overlayB}, ${blendAlpha.toFixed(4)})`,
    };

    const finalColor = isBrightHue
        ? getPromptDarkenedHueColor({ r, g, b })
        : blendOverOpaque({ r, g, b }, { r: overlayR, g: overlayG, b: overlayB }, blendAlpha);

    const shadowAlpha = getPromptShadowAlpha(analysis);

    return {
        treatment,
        isBrightSample,
        isBrightHue,
        useInverse,
        overlay,
        finalColor,
        shadowAlpha,
        blendAlpha,
    };
}

/**
 * Single authoritative owner of password-prompt and button visual decisions.
 * Sampled wallpaper color in -> complete PromptVisualState out.
 *
 * @param {{r: number, g: number, b: number, noise?: number}} sampledColor
 * @param {number|null} [whiteBlendAlpha=null] Optional override used by the prompt chip path
 * @returns {object} PromptVisualState
 */
export function resolvePromptVisualState(sampledColor, whiteBlendAlpha = null) {
    const analysis = analyzePerceptualColor(sampledColor, sampledColor?.noise ?? 0.0);
    const policy = resolveBaseVisualPolicy(analysis, { whiteBlendAlpha });

    const sourceColor = {
        r: analysis.r,
        g: analysis.g,
        b: analysis.b,
    };

    return {
        sourceColor,
        r: policy.finalColor.r,
        g: policy.finalColor.g,
        b: policy.finalColor.b,
        luminance: analysis.luminance,
        perceptualL: analysis.perceptualLightness,
        perceptualLightness: analysis.perceptualLightness,
        chroma: analysis.chroma,
        noise: analysis.noise,
        treatment: policy.treatment,
        isBrightSample: policy.isBrightSample,
        isBrightHue: policy.isBrightHue,
        useInverse: policy.useInverse,
        isInverse: policy.useInverse,
        overlay: policy.overlay,
        finalColor: policy.finalColor,
        shadowAlpha: policy.shadowAlpha,
        blendAlpha: policy.blendAlpha,
    };
}

export function ensurePromptVisualState(color, whiteBlendAlpha = CUPERTINO_PROMPT_WHITE_BLEND_ALPHA) {
    if (color?.visualState?.overlay)
        return color.visualState;
    return resolvePromptVisualState(
        { r: color?.r ?? 0, g: color?.g ?? 0, b: color?.b ?? 0, noise: color?.noise ?? color?.visualState?.noise ?? 0.0 },
        whiteBlendAlpha
    );
}

/**
 * Apply an already-resolved prompt visual policy to a locally sampled base color.
 *
 * @param {{r: number, g: number, b: number, noise?: number}} sourceColor
 * @param {object} visualState
 * @param {{preblend?: boolean}} [options]
 */
export function applyPromptVisualState(sourceColor, visualState, options = {}) {
    const overlay = visualState?.overlay;
    const isSameColor = sourceColor.r === visualState?.sourceColor?.r &&
        sourceColor.g === visualState?.sourceColor?.g &&
        sourceColor.b === visualState?.sourceColor?.b;

    let blended;
    if (isSameColor && visualState?.finalColor) {
        blended = visualState.finalColor;
    } else if (visualState?.isBrightHue) {
        blended = getPromptDarkenedHueColor(sourceColor);
    } else if (overlay) {
        blended = blendOverOpaque(
            sourceColor,
            { r: overlay.r, g: overlay.g, b: overlay.b },
            overlay.alpha
        );
    } else {
        blended = sourceColor;
    }
    const display = options.preblend ? blended : sourceColor;

    return {
        r: display.r,
        g: display.g,
        b: display.b,
        rawR: sourceColor.r,
        rawG: sourceColor.g,
        rawB: sourceColor.b,
        noise: visualState?.noise ?? sourceColor?.noise ?? 0.0,
        rgba: `rgba(${display.r}, ${display.g}, ${display.b}, 1.0)`,
        hex: rgbToHex(display.r, display.g, display.b),
        overlayR: overlay?.r ?? 255,
        overlayG: overlay?.g ?? 255,
        overlayB: overlay?.b ?? 255,
        overlayAlpha: overlay?.alpha ?? 0.18,
        overlayRgba: overlay?.rgba ?? 'rgba(255, 255, 255, 0.1800)',
        shadowAlpha: visualState?.shadowAlpha,
        useInverse: visualState?.useInverse ?? false,
        isBrightSample: visualState?.isBrightSample ?? false,
        isBrightHue: visualState?.isBrightHue ?? false,
        visualState,
    };
}

export function getPromptBlendOverlay(sampledColor, whiteBlendAlpha = null) {
    const state = resolvePromptVisualState(sampledColor, whiteBlendAlpha);
    return {
        overlayR: state.overlay.r,
        overlayG: state.overlay.g,
        overlayB: state.overlay.b,
        blendAlpha: state.overlay.alpha,
        perceptualL: state.perceptualL,
        isBrightSample: state.isBrightSample,
        isBrightHue: state.isBrightHue,
        useInverse: state.useInverse,
    };
}

/**
 * Computes dynamic shadow alpha for the User Label based on backdrop lightness and texture noisiness.
 * Consistently stronger than hint shadow alpha to maintain clear visual hierarchy.
 * Range: 0.15 (dark smooth wallpapers) to 0.675 (bright/noisy wallpapers).
 *
 * @param {number|object} visualStateOrLightness
 * @returns {number}
 */
export function getUserLabelShadowAlpha(visualStateOrLightness) {
    let pL = 0.5;
    let noise = 0.0;
    if (typeof visualStateOrLightness === 'number') {
        pL = visualStateOrLightness <= 1.0 && visualStateOrLightness >= 0.0
            ? visualStateOrLightness
            : clamp01((visualStateOrLightness - 0.60) / 0.25);
    } else if (visualStateOrLightness) {
        pL = visualStateOrLightness.visualState?.perceptualL ??
            visualStateOrLightness.visualState?.perceptualLightness ??
            visualStateOrLightness.perceptualL ??
            visualStateOrLightness.perceptualLightness ??
            (visualStateOrLightness.luminance != null ? getPerceptualLightness(visualStateOrLightness.luminance) : 0.5);
        noise = visualStateOrLightness.visualState?.noise ??
            visualStateOrLightness.noise ??
            0.0;
    }
    const clampedL = clamp01(pL);
    let shadowAlpha = 0.10 + 0.70 * clampedL;
    if (noise > 0.0) {
        const noiseBoost = Math.min(1.0, noise * 25.0) * 0.10;
        shadowAlpha += noiseBoost;
    }
    return clamp01(Math.max(0.10, Math.min(0.80, shadowAlpha)));
}

/**
 * Computes dynamic shadow alpha for the password prompt chip derived from the user label shadow decision-making.
 * Uses a two-zone curve:
 *   - Zone 1 (t <= 0.5): subtle ambient occlusion for dark wallpapers (0.0175 to 0.045)
 *   - Zone 2 (t > 0.5): gentle elevation lift for bright / textured wallpapers (0.045 to 0.1175)
 *
 * @param {number|object} visualStateOrLightness
 * @returns {number}
 */
export function getPromptShadowAlpha(visualStateOrLightness) {
    const userLabelAlpha = getUserLabelShadowAlpha(visualStateOrLightness);
    const t = clamp01((userLabelAlpha - 0.10) / 0.70);

    const midAlpha = 0.045;
    let shadowAlpha;
    if (t <= 0.5) {
        shadowAlpha = PROMPT_SHADOW_FLOOR + (midAlpha - PROMPT_SHADOW_FLOOR) * (t / 0.5);
    } else {
        shadowAlpha = midAlpha + (PROMPT_SHADOW_ROOF - midAlpha) * ((t - 0.5) / 0.5);
    }

    return clamp01(Math.max(PROMPT_SHADOW_FLOOR, Math.min(PROMPT_SHADOW_ROOF, shadowAlpha)));
}

export function getUserLabelStyle(visualStateOrLightness) {
    const shadowAlpha = getUserLabelShadowAlpha(visualStateOrLightness);
    return `text-shadow: 0 1px 10px rgba(0, 0, 0, ${shadowAlpha.toFixed(3)}) !important;`;
}

/**
 * Computes dynamic shadow alpha for hint text based on backdrop lightness and texture noisiness.
 * Range: 0.10 (dark smooth wallpapers) to 0.50 (bright/noisy wallpapers).
 *
 * @param {number|object} visualStateOrLightness
 * @returns {number}
 */
export function getHintTextShadowAlpha(visualStateOrLightness) {
    let pL = 0.5;
    let noise = 0.0;
    if (typeof visualStateOrLightness === 'number') {
        pL = visualStateOrLightness <= 1.0 && visualStateOrLightness >= 0.0
            ? visualStateOrLightness
            : clamp01((visualStateOrLightness - 0.60) / 0.25);
    } else if (visualStateOrLightness) {
        pL = visualStateOrLightness.visualState?.perceptualL ??
            visualStateOrLightness.visualState?.perceptualLightness ??
            visualStateOrLightness.perceptualL ??
            visualStateOrLightness.perceptualLightness ??
            (visualStateOrLightness.luminance != null ? getPerceptualLightness(visualStateOrLightness.luminance) : 0.5);
        noise = visualStateOrLightness.visualState?.noise ??
            visualStateOrLightness.noise ??
            0.0;
    }
    const clampedL = clamp01(pL);
    let shadowAlpha = 0.10 + 0.275 * clampedL;
    if (noise > 0.0) {
        const noiseBoost = Math.min(1.0, noise * 25.0) * 0.15;
        shadowAlpha += noiseBoost;
    }
    return clamp01(Math.max(0.10, Math.min(0.375, shadowAlpha)));
}

/**
 * Computes dynamic color alpha for hint text based on backdrop lightness / wallpaper alpha and noisiness.
 * Range: 0.60 (dark smooth wallpapers) to 0.95 (bright/noisy wallpapers).
 *
 * @param {number|object} visualStateOrLightness
 * @param {number|null} [wallpaperAlpha=null]
 * @returns {number}
 */
export function getHintTextColorAlpha(visualStateOrLightness, wallpaperAlpha = null) {
    let noise = 0.0;
    if (visualStateOrLightness && typeof visualStateOrLightness === 'object') {
        noise = visualStateOrLightness.visualState?.noise ??
            visualStateOrLightness.noise ??
            0.0;
    }

    let baseAlpha = 0.60;
    if (wallpaperAlpha != null && typeof wallpaperAlpha === 'number') {
        const t = clamp01((wallpaperAlpha - 0.60) / 0.25);
        baseAlpha = 0.60 + 0.30 * t;
    } else {
        let pL = 0.5;
        if (typeof visualStateOrLightness === 'number') {
            pL = visualStateOrLightness <= 1.0 && visualStateOrLightness >= 0.0
                ? visualStateOrLightness
                : clamp01((visualStateOrLightness - 0.60) / 0.25);
        } else if (visualStateOrLightness) {
            pL = visualStateOrLightness.visualState?.perceptualL ??
                visualStateOrLightness.perceptualL ??
                (visualStateOrLightness.luminance != null ? getPerceptualLightness(visualStateOrLightness.luminance) : 0.5);
        }
        const clampedL = clamp01(pL);
        baseAlpha = 0.60 + 0.30 * clampedL;
    }

    if (noise > 0.0) {
        const noiseBoost = Math.min(1.0, noise * 25.0) * 0.30;
        baseAlpha = Math.max(baseAlpha, 0.60 + noiseBoost);
    }

    return clamp01(Math.max(0.60, Math.min(0.95, baseAlpha)));
}

export function getHintTextStyle(visualStateOrLightness, wallpaperAlpha = null) {
    const colorAlpha = getHintTextColorAlpha(visualStateOrLightness, wallpaperAlpha);
    const shadowAlpha = getHintTextShadowAlpha(visualStateOrLightness);
    return `color: rgba(255, 255, 255, ${colorAlpha.toFixed(3)}) !important; text-shadow: 0 1px 7px rgba(0, 0, 0, ${shadowAlpha.toFixed(3)}) !important;`;
}

/**
 * Light, softly saturated shade of the wallpaper hue for the lockscreen clock.
 * @param {object|null} promptColor Result of getWallpaperPromptColor()
 * @returns {{r: number, g: number, b: number}|null}
 */
export function getClockTintColor(promptColor) {
    if (!promptColor)
        return null;
    // Raw wallpaper sample; promptColor.r/g/b is already blended for the chip.
    const source = promptColor.visualState?.sourceColor ?? promptColor;
    const { h, s } = rgbToHsl(source.r ?? 255, source.g ?? 255, source.b ?? 255);
    const tint = hslToRgb(h, Math.min(s, 0.55), 0.88);
    return { r: Math.round(tint.r), g: Math.round(tint.g), b: Math.round(tint.b) };
}

export function getPromptMessageStyle(visualStateOrLightness, wallpaperAlpha = null) {
    return getHintTextStyle(visualStateOrLightness, wallpaperAlpha);
}


/**
 * Calculates adaptive white chrome alpha for Lockscreen interactive controls
 * (Cancel, Accessibility, Session selector) based on the resolved visual state.
 *
 * Fundamental invariant:
 * - The interaction chrome is ALWAYS strictly WHITE.
 * - Darker / more inverted visual backdrops -> higher/stronger white chrome alpha.
 * - Lighter / softer backdrops -> lower/subtler chrome alpha.
 * - Continuous, bounded, monotonic mapping with zero discontinuities.
 *
 * @param {object|number} visualStateOrLightness
 * @param {'base'|'hover'|'focus'|'active'} state
 * @returns {number} alpha value between 0.0 and 1.0
 */
export function getChromeAlpha(visualStateOrLightness, state = 'base') {
    let pL = 0.5;
    let noise = 0.0;

    if (typeof visualStateOrLightness === 'number') {
        pL = visualStateOrLightness <= 1.0 && visualStateOrLightness >= 0.0
            ? visualStateOrLightness
            : clamp01((visualStateOrLightness - 0.60) / 0.25);
    } else if (visualStateOrLightness) {
        const vs = visualStateOrLightness.visualState ?? visualStateOrLightness;
        pL = vs.perceptualLightness ?? vs.perceptualL ??
            (vs.luminance != null ? getPerceptualLightness(vs.luminance) : 0.5);
        noise = vs.noise ?? 0.0;
    }

    const clampedL = clamp01(pL);

    switch (state) {
        case 'hover':
            return clamp01(0.18 - 0.04 * clampedL);

        case 'focus':
            return clamp01(0.20 - 0.04 * clampedL);

        case 'active':
            return clamp01(0.28 - 0.04 * clampedL);

        case 'base':
        default: {
            let baseAlpha = 0.18 - 0.05 * clampedL;
            if (noise > 0.0) {
                baseAlpha += Math.min(0.04, noise * 2.0);
            }
            return clamp01(Math.max(0.12, Math.min(0.25, baseAlpha)));
        }
    }
}

/**
 * Calculates adaptive dim veil alpha for unfocused prompt background (Acrylic & Tonal)
 * based on APCA / perceptual lightness sensibilities.
 *
 * Sensibilities:
 * - On dark backdrops: slightly deeper dark veil (0.25 - 0.35) creates distinct unfocused depth.
 * - On bright/inverse backdrops: gentle, subtle dark veil (0.10 - 0.16) avoids muddy black blotches
 *   and maintains clean macOS-style frosted aesthetic.
 * - Monotonic mapping bounded between 0.10 and 0.35.
 *
 * @param {object|number} visualStateOrLightness
 * @returns {number} veil alpha between 0.10 and 0.35
 */
export function getPromptDimVeilAlpha(visualStateOrLightness) {
    let pL = 0.5;
    let isInverse = false;
    let noise = 0.0;

    if (typeof visualStateOrLightness === 'number') {
        pL = visualStateOrLightness <= 1.0 && visualStateOrLightness >= 0.0
            ? visualStateOrLightness
            : clamp01((visualStateOrLightness - 0.60) / 0.25);
    } else if (visualStateOrLightness) {
        const vs = visualStateOrLightness.visualState ?? visualStateOrLightness;
        pL = vs.perceptualLightness ?? vs.perceptualL ??
            (vs.luminance != null ? getPerceptualLightness(vs.luminance) : 0.5);
        isInverse = vs.useInverse ?? vs.isBrightSample ?? false;
        noise = vs.noise ?? 0.0;
    }

    const clampedL = clamp01(pL);

    let veilAlpha;
    if (isInverse) {
        // Reduced by 25%: range 0.075 - 0.1125
        veilAlpha = 0.1125 - 0.0375 * clampedL;
    } else {
        // Reduced by 50%: range 0.100 - 0.175
        veilAlpha = 0.175 - 0.075 * clampedL;
    }

    if (noise > 0.0) {
        veilAlpha += Math.min(0.02, noise * 1.0);
    }

    return clamp01(Math.max(0.075, Math.min(0.175, veilAlpha)));
}

/**
 * Calculates adaptive background styling for notification and media cards on the lockscreen.
 * Adapts opacity and hue overlay to match prompt vibrancy and prevent wash-out on bright wallpapers.
 *
 * @param {object|null} color
 * @param {boolean} [useInverse=false]
 * @returns {{style: string, isInverseClass: boolean}}
 */
export function getNotifCardBackground(color, useInverse = false) {
    if (!color) {
        return { style: '', isInverseClass: useInverse };
    }

    const vs = color.visualState ?? color;
    const isBrightHue = color.isBrightHue ?? vs.isBrightHue ?? false;
    const isInv = useInverse || (vs.useInverse ?? vs.isBrightSample ?? false);
    const darkened = vs.finalColor ?? color.start ?? (color.r != null ? color : null);

    const pL = vs.perceptualLightness ?? vs.perceptualL ??
        (vs.luminance != null ? getPerceptualLightness(vs.luminance) : 0.5);
    const noise = vs.noise ?? 0.0;
    const clampedL = clamp01(pL);

    if (isInv && isBrightHue && darkened && darkened.r != null) {
        let alpha = 0.58 + 0.12 * clampedL;
        if (noise > 0.0) {
            alpha += Math.min(0.025, noise * 1.5);
        }
        alpha = clamp01(Math.max(0.55, Math.min(0.70, alpha)));

        return {
            style: `background-color: rgba(${darkened.r}, ${darkened.g}, ${darkened.b}, ${alpha.toFixed(3)}) !important;`,
            isInverseClass: false,
        };
    } else if (isInv) {
        let blendAlpha = vs.overlay?.alpha ?? vs.blendAlpha;
        if (blendAlpha == null) {
            const t = clamp01((clampedL - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD) / (1.0 - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD));
            blendAlpha = PROMPT_INVERSE_ALPHA_CEILING * t;
        }
        let darkAlpha = Math.max(0.04, Math.min(PROMPT_INVERSE_ALPHA_CEILING, blendAlpha));
        if (noise > 0.0) {
            darkAlpha += Math.min(0.02, noise * 1.0);
        }
        return {
            style: `background-color: rgba(0, 0, 0, ${darkAlpha.toFixed(3)}) !important;`,
            isInverseClass: false,
        };
    }

    return {
        style: '',
        isInverseClass: false,
    };
}

