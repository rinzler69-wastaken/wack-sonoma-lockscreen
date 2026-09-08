import { rgbToHsl, isPixelColorful } from './colorUtils.js';
import { getPixbufSampleBounds } from './wallpaperUtils.js';

export function sampleChromaWeightedColor(pixbuf, bounds, centerCoords) {
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

    // Count colorful pixels in the region
    let colorfulCount = 0;
    for (let i = 0; i < pixelCache.length; i++) {
        const p = pixelCache[i];
        p.isColorful = isPixelColorful(p.r, p.g, p.b);
        if (p.isColorful) {
            colorfulCount++;
        }
    }

    // If actual colorful content exists, nerf whites/greys/neutrals in the region
    const colorfulThreshold = Math.max(5, Math.round(pixelCache.length * 0.01));
    const hasChroma = colorfulCount >= colorfulThreshold;
    if (hasChroma) {
        for (let i = 0; i < pixelCache.length; i++) {
            const p = pixelCache[i];
            if (!p.isColorful) {
                p.w *= 0.01;
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
            const weight = Math.max(0.00000001, p.w);
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
                const weight = Math.max(0.00000001, p.w);
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

export function samplePixbufDominantColor(pixbuf, bounds) {
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
