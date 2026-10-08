import GLib from 'gi://GLib';
import {
    PROMPT_VISUAL_ALGORITHM_VERSION,
} from './colorUtils.js';

const DEFAULT_BLUR_RADIUS = 50;
const DEFAULT_BLUR_BRIGHTNESS = 1.0;
const DEFAULT_CANCEL_HOVER_ALPHA = 0.12;
const DEFAULT_CANCEL_ACTIVE_ALPHA = 0.24;

/**
 * Normalizes floating-point bounds into a deterministic canonical string key.
 *
 * @param {number} x1
 * @param {number} x2
 * @param {number} y1
 * @param {number} y2
 * @returns {string}
 */
export function formatBoundsKey(x1, x2, y1, y2) {
    return `${x1.toFixed(4)}_${x2.toFixed(4)}_${y1.toFixed(4)}_${y2.toFixed(4)}`;
}

/**
 * Normalizes transition progress into a deterministic canonical string key.
 *
 * @param {object|null} transitionInfo
 * @returns {string}
 */
export function formatProgressKey(transitionInfo) {
    if (transitionInfo && transitionInfo.isTransition) {
        const rounded = Math.round(transitionInfo.progress * 100) / 100;
        return `_prog${rounded.toFixed(2)}`;
    }
    return '';
}

/**
 * Creates a structured canonical identity for Clock Alpha calculation.
 *
 * @param {object} params
 * @returns {object}
 */
export function createClockAlphaIdentity(params) {
    const {
        targetUri,
        mtime = 0,
        size = 0,
        isColor = false,
        primaryColor = '',
        secondaryColor = '',
        shadingType = 0,
        textLuminance = 1.0,
        transitionInfo = null,
    } = params;

    return {
        type: 'clock_alpha',
        targetUri: targetUri || '',
        mtime: Number(mtime) || 0,
        size: Number(size) || 0,
        isColor: Boolean(isColor),
        primaryColor: primaryColor || '',
        secondaryColor: secondaryColor || '',
        shadingType: Number(shadingType) || 0,
        textLuminance: Number(textLuminance) || 1.0,
        progressKey: formatProgressKey(transitionInfo),
    };
}

/**
 * Serializes a Clock Alpha identity into a canonical cache key.
 *
 * @param {object} id
 * @returns {string}
 */
export function serializeClockAlphaIdentity(id) {
    return `${id.targetUri}_${id.mtime}_${id.size}_${id.isColor}_${id.primaryColor}_${id.secondaryColor}_${id.shadingType}_${id.textLuminance}${id.progressKey}`;
}

/**
 * Creates a structured canonical identity for Prompt Vibrancy calculation.
 *
 * @param {object} params
 * @returns {object}
 */
export function createPromptVibrancyIdentity(params) {
    const {
        targetUri,
        mtime = 0,
        size = 0,
        isColor = false,
        primaryColor = '',
        secondaryColor = '',
        shadingType = 0,
        pictureOptions = 'zoom',
        monitorWidth = 1920,
        monitorHeight = 1080,
        boundsKey = '0.0000_1.0000_0.0000_1.0000',
        cancelBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        avatarBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        a11yBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        sessionBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        suspendBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        restartBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        powerOffBoundsKey = '0.0000_1.0000_0.0000_1.0000',
        blurRadius = DEFAULT_BLUR_RADIUS,
        blurBrightness = DEFAULT_BLUR_BRIGHTNESS,
        cancelHoverAlpha = DEFAULT_CANCEL_HOVER_ALPHA,
        cancelActiveAlpha = DEFAULT_CANCEL_ACTIVE_ALPHA,
        algorithmVersion = PROMPT_VISUAL_ALGORITHM_VERSION,
        vibrancyMode = 'tonal',
        transitionInfo = null,
    } = params;

    return {
        type: 'prompt_vibrancy',
        targetUri: targetUri || '',
        mtime: Number(mtime) || 0,
        size: Number(size) || 0,
        isColor: Boolean(isColor),
        primaryColor: primaryColor || '',
        secondaryColor: secondaryColor || '',
        shadingType: Number(shadingType) || 0,
        pictureOptions: pictureOptions || 'zoom',
        monitorWidth: Number(monitorWidth) || 1920,
        monitorHeight: Number(monitorHeight) || 1080,
        boundsKey,
        cancelBoundsKey,
        avatarBoundsKey,
        a11yBoundsKey,
        sessionBoundsKey,
        suspendBoundsKey,
        restartBoundsKey,
        powerOffBoundsKey,
        blurRadius: Number(blurRadius) || 50,
        blurBrightness: Number(blurBrightness) || 1.0,
        cancelHoverAlpha: Number(cancelHoverAlpha) || 0.12,
        cancelActiveAlpha: Number(cancelActiveAlpha) || 0.20,
        algorithmVersion: Number(algorithmVersion) || 27,
        vibrancyMode: vibrancyMode || 'tonal',
        progressKey: formatProgressKey(transitionInfo),
    };
}

/**
 * Serializes a Prompt Vibrancy identity into a canonical cache key.
 *
 * @param {object} id
 * @returns {string}
 */
export function serializePromptVibrancyIdentity(id) {
    const csaKey = (id.suspendBoundsKey && id.suspendBoundsKey !== '0.0000_1.0000_0.0000_1.0000') ||
                   (id.restartBoundsKey && id.restartBoundsKey !== '0.0000_1.0000_0.0000_1.0000') ||
                   (id.powerOffBoundsKey && id.powerOffBoundsKey !== '0.0000_1.0000_0.0000_1.0000')
        ? `_csa${id.suspendBoundsKey}_${id.restartBoundsKey}_${id.powerOffBoundsKey}`
        : '';
    return `prompt_grad_${id.targetUri}_${id.mtime}_${id.size}_${id.isColor}_${id.primaryColor}_${id.secondaryColor}_${id.shadingType}_${id.pictureOptions}_${id.monitorWidth}x${id.monitorHeight}_${id.boundsKey}_cb${id.cancelBoundsKey}_av${id.avatarBoundsKey}_a11y${id.a11yBoundsKey}_sess${id.sessionBoundsKey}${csaKey}_b${id.blurRadius}_pbr${id.blurBrightness}_chov${id.cancelHoverAlpha}_cact${id.cancelActiveAlpha}_cover_vis${id.algorithmVersion}_vm${id.vibrancyMode}${id.progressKey}`;
}

/**
 * Computes an 8-character cryptographic checksum hash for an identity or cache key.
 *
 * @param {string} cacheKey
 * @returns {string}
 */
export function computeSliceHash(cacheKey) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, cacheKey, -1).substring(0, 8);
}

/**
 * Resolves the destination directory and filename for a blurred PNG slice.
 *
 * @param {string} userName
 * @param {string} sliceHash
 * @param {boolean} isXml
 * @param {string|null} xmlName
 * @returns {{targetDir: string, filePath: string}}
 */
export function resolveSlicePath(userName, sliceHash, isXml = false, xmlName = null) {
    const BASE_VIBRANCY_DIR = '/var/tmp/wack/vibrancy';
    const GENERAL_DIR = `${BASE_VIBRANCY_DIR}/general`;

    let targetDir = GENERAL_DIR;
    if (isXml && xmlName) {
        const safeXmlName = xmlName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        targetDir = `${BASE_VIBRANCY_DIR}/${safeXmlName}`;
    }

    const filePath = `${targetDir}/wack-prompt-blur-${userName}-${sliceHash}.png`;
    return { targetDir, filePath };
}
