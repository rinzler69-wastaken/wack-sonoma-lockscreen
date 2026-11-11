/**
 * Dual Kawase blur sampling mathematics and configuration calculations.
 * Pure JS module with zero native UI or display dependencies.
 */

/**
 * Calculates the number of downsampling/upsampling passes and fractional blend
 * factor for a given pixel blur radius.
 * @param {number} radius - Blur radius in pixels
 * @returns {{ passes: number, blend: number }}
 */
export function getKawaseConfiguration(radius) {
    const variance = (radius / 4) ** 2;
    const firstLevelVariance = 3 / 2;
    if (variance <= firstLevelVariance)
        return { passes: 1, blend: variance / firstLevelVariance };

    let accumulatedVariance = firstLevelVariance;
    let passes = 2;
    let levelVariance = 10;
    while (accumulatedVariance + levelVariance < variance) {
        accumulatedVariance += levelVariance;
        levelVariance *= 4;
        passes++;
    }

    return { passes, blend: (variance - accumulatedVariance) / levelVariance };
}

/**
 * Calculates aligned bounding boxes with padding for multi-level Kawase passes.
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {number} width - Actor logical width
 * @param {number} height - Actor logical height
 * @param {number} scale - Resource scale factor
 * @param {number} passes - Number of Kawase passes
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function getKawaseInputBounds(bounds, width, height, scale, passes) {
    const alignment = 2 ** passes;
    const padding = 4 * alignment;
    const left = Math.min(width * scale, Math.max(0,
        Math.floor((bounds.x * scale - padding) / alignment) * alignment));
    const top = Math.min(height * scale, Math.max(0,
        Math.floor((bounds.y * scale - padding) / alignment) * alignment));
    const right = Math.max(left, Math.min(width * scale,
        Math.ceil(((bounds.x + bounds.width) * scale + padding) / alignment) * alignment));
    const bottom = Math.max(top, Math.min(height * scale,
        Math.ceil(((bounds.y + bounds.height) * scale + padding) / alignment) * alignment));
    return {
        x: left / scale,
        y: top / scale,
        width: (right - left) / scale,
        height: (bottom - top) / scale,
    };
}

