import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import {
    getRelativeLuminance,
    getPerceptualLightness,
    getPromptBlendAlpha,
    PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD,
    PROMPT_BRIGHT_HUE_MIN_CHROMA,
    PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR,
    PROMPT_INVERSE_ALPHA_CEILING,
    PROMPT_SHADOW_FLOOR,
    PROMPT_SHADOW_ROOF,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
} from './colorUtils.js';

function fastBoxBlur(srcPixels, w, h, stride, channels, r) {
    if (r <= 0 || w <= 0 || h <= 0)
        return srcPixels;

    const total = w * h * channels;
    const temp = new Uint8Array(total);
    const out = new Uint8Array(total);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
        const rowOffset = y * stride;
        const tempRowOffset = y * w * channels;
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let x = -r; x <= r; x++) {
                const sx = Math.max(0, Math.min(w - 1, x));
                sum += srcPixels[rowOffset + sx * channels + c];
            }
            const count = 2 * r + 1;
            temp[tempRowOffset + c] = Math.round(sum / count);

            for (let x = 1; x < w; x++) {
                const addX = Math.min(w - 1, x + r);
                const subX = Math.max(0, x - r - 1);
                sum += srcPixels[rowOffset + addX * channels + c] - srcPixels[rowOffset + subX * channels + c];
                temp[tempRowOffset + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    // Vertical pass
    for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let y = -r; y <= r; y++) {
                const sy = Math.max(0, Math.min(h - 1, y));
                sum += temp[sy * w * channels + x * channels + c];
            }
            const count = 2 * r + 1;
            out[x * channels + c] = Math.round(sum / count);

            for (let y = 1; y < h; y++) {
                const addY = Math.min(h - 1, y + r);
                const subY = Math.max(0, y - r - 1);
                sum += temp[addY * w * channels + x * channels + c] - temp[subY * w * channels + x * channels + c];
                out[y * w * channels + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    return out;
}

/**
 * Creates a blurred wallpaper slice matching the password prompt chip bounds,
 * with dynamic downsampling and adaptive frosted glass white/dark blend.
 *
 * @param {GdkPixbuf.Pixbuf} srcPixbuf Source wallpaper pixbuf
 * @param {object} bounds Normalized crop coordinates { x1, x2, y1, y2 }
 * @param {number} destWidth Target prompt chip width in pixels
 * @param {number} destHeight Target prompt chip height in pixels
 * @param {number} blurRadius Blur radius in screen pixels
 * @param {number} brightness Brightness multiplier factor
 * @param {number} highlightAlpha Optional overlay highlight/tint alpha (0.0 - 1.0)
 * @param {number|null} whiteBlendAlpha Frosted glass white overlay alpha (defaults to CUPERTINO_PROMPT_WHITE_BLEND_ALPHA)
 * @returns {{pixbuf: GdkPixbuf.Pixbuf, avgColor: {r: number, g: number, b: number}, shadowAlpha: number}|null}
 */
export function createBlurredPromptSlice(
    srcPixbuf,
    bounds,
    destWidth = 320,
    destHeight = 40,
    blurRadius = 40,
    brightness = 1.0,
    highlightAlpha = 0.0,
    whiteBlendAlpha = CUPERTINO_PROMPT_WHITE_BLEND_ALPHA
) {
    if (!srcPixbuf)
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

    if (blurRadius <= 0) {
        const rawPix = srcPixbuf.new_subpixbuf(startX, startY, cropW, cropH);
        let scaledPix = (cropW !== destWidth || cropH !== destHeight)
            ? rawPix.scale_simple(destWidth, destHeight, GdkPixbuf.InterpType.BILINEAR)
            : rawPix.copy();
        const pixels = scaledPix.get_pixels();
        const nChannels = scaledPix.get_n_channels();
        const stride = scaledPix.get_rowstride();
        const w = scaledPix.get_width();
        const h = scaledPix.get_height();
        const bFactor = Math.max(0, brightness);
        const baseAlpha = (whiteBlendAlpha !== null && whiteBlendAlpha !== undefined)
            ? whiteBlendAlpha
            : 0.0;
        const totalOverlayAlpha = Math.min(1.0, baseAlpha + highlightAlpha);
        const oInv = 1.0 - totalOverlayAlpha;

        let sumR = 0, sumG = 0, sumB = 0;
        const total = w * h;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = y * stride + x * nChannels;
                let r = pixels[off];
                let g = pixels[off + 1];
                let b = pixels[off + 2];

                if (bFactor !== 1.0) {
                    r = Math.max(0, Math.min(255, Math.round(r * bFactor)));
                    g = Math.max(0, Math.min(255, Math.round(g * bFactor)));
                    b = Math.max(0, Math.min(255, Math.round(b * bFactor)));
                }

                if (totalOverlayAlpha > 0) {
                    r = Math.max(0, Math.min(255, Math.round(r * oInv + 255 * totalOverlayAlpha)));
                    g = Math.max(0, Math.min(255, Math.round(g * oInv + 255 * totalOverlayAlpha)));
                    b = Math.max(0, Math.min(255, Math.round(b * oInv + 255 * totalOverlayAlpha)));
                }

                pixels[off] = r;
                pixels[off + 1] = g;
                pixels[off + 2] = b;

                sumR += r;
                sumG += g;
                sumB += b;
            }
        }
        const avgColor = {
            r: Math.round(sumR / total),
            g: Math.round(sumG / total),
            b: Math.round(sumB / total),
        };
        return {
            pixbuf: scaledPix,
            avgColor,
            shadowAlpha: PROMPT_SHADOW_FLOOR,
        };
    }

    try {
        // Calculate padding in pixbuf coordinates equivalent to blurRadius screen pixels
        const rInPixbuf = Math.round(blurRadius * (cropW / destWidth));

        const padStartX = Math.max(0, startX - rInPixbuf);
        const padEndX = Math.min(pbWidth, endX + rInPixbuf);
        const padStartY = Math.max(0, startY - rInPixbuf);
        const padEndY = Math.min(pbHeight, endY + rInPixbuf);

        const padW = padEndX - padStartX;
        const padH = padEndY - padStartY;
        if (padW <= 0 || padH <= 0)
            return null;

        const padCrop = srcPixbuf.new_subpixbuf(padStartX, padStartY, padW, padH);

        const scaleX = destWidth / cropW;
        const scaleY = destHeight / cropH;
        const workW = Math.max(2, Math.round(padW * scaleX));
        const workH = Math.max(2, Math.round(padH * scaleY));

        // Dynamic downsampling:
        // Use 1x for small blur radii (<16px) to avoid destroying fine details.
        // Use 2x for standard/large radii (>=16px) for optimal performance.
        const dsFactor = blurRadius >= 16 ? 2 : 1;
        const dsW = Math.max(2, Math.round(workW / dsFactor));
        const dsH = Math.max(2, Math.round(workH / dsFactor));
        const dsPix = dsFactor > 1
            ? padCrop.scale_simple(dsW, dsH, GdkPixbuf.InterpType.BILINEAR)
            : padCrop.scale_simple(workW, workH, GdkPixbuf.InterpType.BILINEAR);
        if (!dsPix)
            return null;

        const dsPixels = dsPix.get_pixels();
        const dsStride = dsPix.get_rowstride();
        const dsChannels = dsPix.get_n_channels();

        // 2 passes of box blur approximate a true Gaussian blur of the target radius
        const dsRadius = Math.max(1, Math.round((blurRadius / dsFactor) * 0.7));
        const pass1 = fastBoxBlur(dsPixels, dsW, dsH, dsStride, dsChannels, dsRadius);
        const pass2 = fastBoxBlur(pass1, dsW, dsH, dsW * dsChannels, dsChannels, dsRadius);

        // Crop the central prompt chip at downsampled scale
        const dsOffX = Math.round((startX - padStartX) * scaleX / dsFactor);
        const dsOffY = Math.round((startY - padStartY) * scaleY / dsFactor);
        const dsCropW = Math.round(destWidth / dsFactor);
        const dsCropH = Math.round(destHeight / dsFactor);

        const dsChipBytes = new Uint8Array(dsCropW * dsCropH * dsChannels);

        // Calculate chip average color to determine a uniform white/dark frosted glass blend
        let sumR = 0, sumG = 0, sumB = 0;
        const totalSamples = dsCropW * dsCropH;
        for (let y = 0; y < dsCropH; y++) {
            const clampedY = Math.max(0, Math.min(dsH - 1, y + dsOffY));
            for (let x = 0; x < dsCropW; x++) {
                const clampedX = Math.max(0, Math.min(dsW - 1, x + dsOffX));
                const srcOff = (clampedY * dsW + clampedX) * dsChannels;
                sumR += pass2[srcOff];
                sumG += pass2[srcOff + 1];
                sumB += pass2[srcOff + 2];
            }
        }
        const avgColor = {
            r: Math.round(sumR / totalSamples),
            g: Math.round(sumG / totalSamples),
            b: Math.round(sumB / totalSamples),
        };

        const luminance = Math.max(0, Math.min(1, getRelativeLuminance(avgColor)));
        const perceptualL = getPerceptualLightness(luminance);
        const maxVal = Math.max(avgColor.r, avgColor.g, avgColor.b);
        const minVal = Math.min(avgColor.r, avgColor.g, avgColor.b);
        const chroma = (maxVal - minVal) / 255.0;
        const isBrightSample = perceptualL > PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD;
        const isBrightHue = isBrightSample && chroma >= PROMPT_BRIGHT_HUE_MIN_CHROMA;

        let overlayR, overlayG, overlayB, blendAlpha;
        const baseAlpha = (whiteBlendAlpha !== null && whiteBlendAlpha !== undefined)
            ? whiteBlendAlpha
            : getPromptBlendAlpha(avgColor);

        if (isBrightHue) {
            overlayR = 0; overlayG = 0; overlayB = 0;
            blendAlpha = (whiteBlendAlpha !== null && whiteBlendAlpha !== undefined)
                ? whiteBlendAlpha
                : (1 - PROMPT_BRIGHT_HUE_LIGHTNESS_FACTOR);
        } else if (isBrightSample) {
            overlayR = 0; overlayG = 0; overlayB = 0;
            const t = Math.max(0, Math.min(
                1,
                (perceptualL - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD) /
                (1 - PROMPT_BRIGHT_HUE_LIGHTNESS_THRESHOLD)
            ));
            blendAlpha = baseAlpha + (PROMPT_INVERSE_ALPHA_CEILING - baseAlpha) * t;
        } else {
            overlayR = 255; overlayG = 255; overlayB = 255;
            blendAlpha = baseAlpha;
        }

        let shadowAlpha = PROMPT_SHADOW_FLOOR + (PROMPT_SHADOW_ROOF - PROMPT_SHADOW_FLOOR) * perceptualL;
        if (isBrightSample) {
            shadowAlpha = PROMPT_SHADOW_FLOOR;
        }

        const bFactor = Math.max(0, brightness);
        const invAlpha = 1 - blendAlpha;
        const hInv = highlightAlpha > 0 ? (1 - highlightAlpha) : 1;
        const hR = isBrightSample ? 0 : 255;
        const hG = isBrightSample ? 0 : 255;
        const hB = isBrightSample ? 0 : 255;

        for (let y = 0; y < dsCropH; y++) {
            const clampedY = Math.max(0, Math.min(dsH - 1, y + dsOffY));
            for (let x = 0; x < dsCropW; x++) {
                const clampedX = Math.max(0, Math.min(dsW - 1, x + dsOffX));
                const srcOff = (clampedY * dsW + clampedX) * dsChannels;
                const dstOff = (y * dsCropW + x) * dsChannels;

                let r = (pass2[srcOff] * invAlpha + overlayR * blendAlpha) * bFactor;
                let g = (pass2[srcOff + 1] * invAlpha + overlayG * blendAlpha) * bFactor;
                let b = (pass2[srcOff + 2] * invAlpha + overlayB * blendAlpha) * bFactor;

                if (highlightAlpha > 0) {
                    r = r * hInv + hR * highlightAlpha;
                    g = g * hInv + hG * highlightAlpha;
                    b = b * hInv + hB * highlightAlpha;
                }

                dsChipBytes[dstOff] = Math.max(0, Math.min(255, Math.round(r)));
                dsChipBytes[dstOff + 1] = Math.max(0, Math.min(255, Math.round(g)));
                dsChipBytes[dstOff + 2] = Math.max(0, Math.min(255, Math.round(b)));
                if (dsChannels === 4)
                    dsChipBytes[dstOff + 3] = pass2[srcOff + 3];
            }
        }

        const dsBytesObj = GLib.Bytes.new(dsChipBytes);
        const dsChipPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            dsBytesObj,
            GdkPixbuf.Colorspace.RGB,
            dsChannels === 4,
            8,
            dsCropW,
            dsCropH,
            dsCropW * dsChannels
        );

        const finalPixbuf = dsFactor > 1
            ? dsChipPixbuf.scale_simple(destWidth, destHeight, GdkPixbuf.InterpType.BILINEAR)
            : dsChipPixbuf;

        return {
            pixbuf: finalPixbuf,
            avgColor,
            shadowAlpha,
        };
    } catch (e) {
        console.error(`[WACK/WallpaperSampler] createBlurredPromptSlice error: ${e}`);
        return null;
    }
}
