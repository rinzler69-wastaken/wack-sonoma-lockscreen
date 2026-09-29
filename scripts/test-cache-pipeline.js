import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    createClockAlphaIdentity,
    serializeClockAlphaIdentity,
    createPromptVibrancyIdentity,
    serializePromptVibrancyIdentity,
    computeSliceHash,
    resolveSlicePath,
    formatBoundsKey,
    formatProgressKey,
} from '../src/main/cacheIdentity.js';
import {
    setCache,
    getCache,
    hasCache,
    clearCache,
    flushAllCache,
    MAX_CACHE_ENTRIES,
    CacheMetrics,
} from '../src/main/alphaCache.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        print(`  ✓ ${testName}`);
    } else {
        failed++;
        printerr(`  ✗ FAIL: ${testName}`);
    }
}

print('Starting Cache Pipeline Unit Tests (GJS Environment)...');

// 1. Test Cache Identity Determinism
print('\n[1] Testing Cache Identity:');
const id1 = createClockAlphaIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    shadingType: 0,
    textLuminance: 1.0,
});
const key1 = serializeClockAlphaIdentity(id1);
const id2 = createClockAlphaIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    shadingType: 0,
    textLuminance: 1.0,
});
const key2 = serializeClockAlphaIdentity(id2);
assert(key1 === key2, 'Clock alpha canonical identity produces identical key strings');

const vId1 = createPromptVibrancyIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    boundsKey: formatBoundsKey(0.4, 0.6, 0.8, 0.9),
    vibrancyMode: 'acrylic',
});
const vKey1 = serializePromptVibrancyIdentity(vId1);
const sliceHash1 = computeSliceHash(vKey1);
assert(sliceHash1.length === 8, 'Slice hash is 8 characters hex');

const slicePath1 = resolveSlicePath('testuser', sliceHash1, false, null);
assert(slicePath1.targetDir === '/var/tmp/wack/vibrancy/general', 'Static slice target dir is general');
assert(slicePath1.filePath.endsWith(`wack-prompt-blur-testuser-${sliceHash1}.png`), 'Static slice path formatted correctly');

const xmlSlicePath = resolveSlicePath('testuser', sliceHash1, true, 'adwaita-d.xml');
assert(xmlSlicePath.targetDir === '/var/tmp/wack/vibrancy/adwaita-d.xml', 'Dynamic XML slice target dir sanitized');

const progKey = formatProgressKey({ isTransition: true, progress: 0.456 });
assert(progKey === '_prog0.46', 'Transition progress rounded to 2 decimal places');

// 2. Test In-Memory L1 LRU and Capacity
print('\n[2] Testing L1 Cache & LRU:');
clearCache();
CacheMetrics.reset();

setCache('key_alpha_1', 0.65);
assert(hasCache('key_alpha_1'), 'Cache has key_alpha_1');
assert(getCache('key_alpha_1') === 0.65, 'Retrieved value matches stored value');
assert(CacheMetrics.l1Hits === 1, 'L1 hit counter incremented');

// Fill up to capacity
for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) {
    setCache(`bulk_key_${i}`, 0.5 + (i * 0.001));
}
assert(!hasCache('key_alpha_1'), 'Oldest entry evicted when capacity exceeded');
assert(hasCache(`bulk_key_${MAX_CACHE_ENTRIES + 9}`), 'Newest entry present');
assert(CacheMetrics.evictions === 11, 'Eviction count equals excess entries');

// 3. Test Entry Validation
print('\n[3] Testing Cache Entry Validation:');
const invalidScalar = setCache('bad_scalar', 1.5); // Alpha must be <= 1.0
assert(!invalidScalar, 'Rejects invalid scalar alpha > 1.0');

const validVisualState = {
    r: 50, g: 60, b: 70,
    start: { r: 50, g: 60, b: 70 },
    end: { r: 40, g: 50, b: 60 },
    cancelColor: { r: 55, g: 65, b: 75 },
    avatarColor: { r: 55, g: 65, b: 75 },
    a11yColor: { r: 50, g: 60, b: 70 },
    sessionColor: { r: 50, g: 60, b: 70 },
    useInverse: false,
    shadowAlpha: 0.15,
};
assert(setCache('valid_visual', validVisualState), 'Accepts valid PromptVisualState object');

const invalidVisualState = {
    r: 300, g: 60, b: 70, // r > 255
    useInverse: false,
    shadowAlpha: 0.15,
};
assert(!setCache('invalid_visual', invalidVisualState), 'Rejects visual state with out-of-range RGB');

// 5. Test Tonal Vibrancy & Visual Policy Wiring
print('\n[5] Testing Tonal Vibrancy & Visual Policy Wiring:');
import {
    resolvePromptVisualState,
    applyPromptVisualState,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
} from '../src/main/colorUtils.js';

// Bright wallpaper sample (e.g., pure white or bright pastel)
const brightSample = { r: 245, g: 245, b: 245, noise: 0.01 };
const brightVisualState = resolvePromptVisualState(brightSample, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
assert(brightVisualState.useInverse === true, 'Bright sample resolves useInverse === true');
assert(brightVisualState.isBrightSample === true, 'Bright sample resolves isBrightSample === true');

const preblendedBright = applyPromptVisualState(brightSample, brightVisualState, { preblend: true });
assert(preblendedBright.useInverse === true, 'Preblended bright result retains useInverse === true');
assert(preblendedBright.r < 245 && preblendedBright.g < 245 && preblendedBright.b < 245, 'Preblended bright result is dark inverse blended');

// Dark wallpaper sample (e.g., dark night scene)
const darkSample = { r: 30, g: 35, b: 40, noise: 0.01 };
const darkVisualState = resolvePromptVisualState(darkSample, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
assert(darkVisualState.useInverse === false, 'Dark sample resolves useInverse === false');
assert(darkVisualState.isBrightSample === false, 'Dark sample resolves isBrightSample === false');

const preblendedDark = applyPromptVisualState(darkSample, darkVisualState, { preblend: true });
assert(preblendedDark.useInverse === false, 'Preblended dark result retains useInverse === false');
assert(preblendedDark.r > 30 && preblendedDark.g > 35 && preblendedDark.b > 40, 'Preblended dark result is white-frosted blended');

// 6. Test GDM Stack Key & Account Transition Differentiation
print('\n[6] Testing GDM Stack Key & Account Transition Differentiation:');

function testStackKey(theme) {
    const s = theme.slide;
    if (s !== null && s.isTransition)
        return `${s.from}>${s.to}`;
    if (theme.meta?.is_color)
        return `color:${theme.meta.primary_color}:${theme.meta.secondary_color}:${theme.meta.shading_type}`;
    return theme.image;
}

// Mock theme objects for two distinct users
const themeUserA = {
    userName: 'alice',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-1000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-1000.jpg',
    slide: null,
};

const themeUserB = {
    userName: 'bob',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    slide: null,
};

const themeUserASameAsB = {
    userName: 'charlie',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    slide: null,
};

const themeColorA = {
    userName: 'dave',
    meta: {
        is_color: true,
        primary_color: '#0000ff',
        secondary_color: '#000000',
        shading_type: 0,
    },
    image: '',
    slide: null,
};

const themeColorB = {
    userName: 'eve',
    meta: {
        is_color: true,
        primary_color: '#ff0000',
        secondary_color: '#000000',
        shading_type: 0,
    },
    image: '',
    slide: null,
};

assert(testStackKey(themeUserA) !== testStackKey(themeUserB), 'Different static wallpapers produce different stack keys (A != B)');
assert(testStackKey(themeUserB) === testStackKey(themeUserASameAsB), 'Identical wallpapers across accounts share stack key (B == Charlie)');
assert(testStackKey(themeColorA) !== testStackKey(themeColorB), 'Different solid/gradient colors produce distinct stack keys (Dave != Eve)');

print('\n[7] Testing Account-Specific Vibrancy Mode & GDM Palette Indexing:');
function getPaletteKey(image, mode, fallbackMode = 'tonal') {
    const effectiveMode = mode ?? fallbackMode;
    return `${image}|${effectiveMode}`;
}

const userAccountTonal = { promptVibrancyMode: 'tonal' };
const userAccountAcrylic = { promptVibrancyMode: 'translucent' };

const imageUri = 'file:///var/tmp/wack/shared/wack-shared-wallpaper.jpg';
const keyTonal = getPaletteKey(imageUri, userAccountTonal.promptVibrancyMode);
const keyAcrylic = getPaletteKey(imageUri, userAccountAcrylic.promptVibrancyMode);

assert(keyTonal === `${imageUri}|tonal`, 'Tonal account produces tonal palette key');
assert(keyAcrylic === `${imageUri}|translucent`, 'Acrylic account produces translucent palette key');
assert(keyTonal !== keyAcrylic, 'Tonal and Acrylic accounts do not collide in palette cache');

print('\n[8] Testing Aspect Ratio Scaling & Cover Viewport Calculations:');
function computeVisibleViewport(origW, origH, monitorW, monitorH, pictureOptions = 'zoom') {
    let targetW = monitorW;
    let targetH = monitorH;
    if (origW > 0 && origH > 0) {
        if (pictureOptions === 'stretched') {
            targetW = monitorW;
            targetH = monitorH;
        } else if (pictureOptions === 'scaled') {
            const scale = Math.min(monitorW / origW, monitorH / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
        } else {
            // zoom / cover
            const scale = Math.max(monitorW / origW, monitorH / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
        }
    }

    const pbAspect = targetW / targetH;
    const monitorAspect = monitorW / monitorH;
    let visibleX = 0, visibleY = 0, visibleW = targetW, visibleH = targetH;
    if (pictureOptions === 'zoom') {
        if (pbAspect > monitorAspect) {
            visibleW = targetH * monitorAspect;
            visibleX = (targetW - visibleW) / 2;
        } else if (pbAspect < monitorAspect) {
            visibleH = targetW / monitorAspect;
            visibleY = (targetH - visibleH) / 2;
        }
    }
    return { targetW, targetH, visibleX, visibleY, visibleW, visibleH };
}

// 16:10 image on 16:9 monitor (1920x1200 on 1920x1080)
const cover1610 = computeVisibleViewport(1920, 1200, 1920, 1080, 'zoom');
assert(cover1610.targetW === 1920 && cover1610.targetH === 1200, '16:10 image scaled to 1920x1200 cover');
assert(cover1610.visibleW === 1920 && cover1610.visibleH === 1080, '16:10 visible viewport is 1920x1080');
assert(cover1610.visibleY === 60, '16:10 center-crop visibleY offset is 60px');

// 21:9 ultrawide image on 16:9 monitor (2560x1080 on 1920x1080)
const cover219 = computeVisibleViewport(2560, 1080, 1920, 1080, 'zoom');
assert(cover219.targetW === 2560 && cover219.targetH === 1080, '21:9 image scaled to 2560x1080 cover');
assert(cover219.visibleW === 1920 && cover219.visibleH === 1080, '21:9 visible viewport is 1920x1080');
assert(cover219.visibleX === 320, '21:9 center-crop visibleX offset is 320px');

// 9. Test Light/Dark Wallpaper Set Metadata & GDM Variant Resolution
print('\n[9] Testing Light/Dark Wallpaper-Set & GDM Variant Resolution:');

function resolveVariant(rawMeta, colorScheme) {
    if (!rawMeta)
        return null;
    const variantKey = colorScheme === 1 ? 'dark' : 'light';
    if (rawMeta.variants && rawMeta.variants[variantKey]) {
        const v = rawMeta.variants[variantKey];
        const isSameSource = !v.source_uri || !rawMeta.source_uri || (v.source_uri === rawMeta.source_uri);
        return {
            ...rawMeta,
            source_uri: v.source_uri ?? rawMeta.source_uri,
            source_mtime: v.source_mtime ?? rawMeta.source_mtime,
            source_size: v.source_size ?? rawMeta.source_size,
            uri: v.uri ?? rawMeta.uri,
            slideshow_xml_text: v.slideshow_xml_text ?? rawMeta.slideshow_xml_text,
            resolved_slide_path: v.resolved_slide_path ?? rawMeta.resolved_slide_path,
            resolved_slide_progress: v.resolved_slide_progress ?? rawMeta.resolved_slide_progress,
            is_color: v.is_color ?? rawMeta.is_color,
            clockAlpha: v.clockAlpha ?? (isSameSource ? rawMeta.clockAlpha : null),
            promptColor: v.promptColor ?? (isSameSource ? rawMeta.promptColor : null),
            active_color_scheme: colorScheme,
        };
    }
    return {
        ...rawMeta,
        active_color_scheme: colorScheme,
    };
}

const dualVariantMeta = {
    username: 'rinzler',
    color_scheme: 0,
    source_uri: 'file:///usr/share/backgrounds/gnome/adwaita-l.jxl',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-rinzler-light-1000.jpg',
    clockAlpha: 0.65,
    promptColor: { r: 230, g: 230, b: 230, useInverse: true },
    variants: {
        light: {
            source_uri: 'file:///usr/share/backgrounds/gnome/adwaita-l.jxl',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-rinzler-light-1000.jpg',
            clockAlpha: 0.65,
            promptColor: { r: 230, g: 230, b: 230, useInverse: true },
        },
        dark: {
            source_uri: 'file:///usr/share/backgrounds/gnome/adwaita-d.jxl',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-rinzler-dark-1000.jpg',
            clockAlpha: 0.45,
            promptColor: { r: 35, g: 35, b: 40, useInverse: false },
        },
    },
};

const resolvedLight = resolveVariant(dualVariantMeta, 0);
assert(resolvedLight.uri.includes('light-1000.jpg'), 'Resolved variant for color_scheme=0 picks light URI');
assert(resolvedLight.clockAlpha === 0.65, 'Resolved light variant preserves light clockAlpha');
assert(resolvedLight.promptColor.useInverse === true, 'Resolved light variant preserves light inverse styling');

const resolvedDark = resolveVariant(dualVariantMeta, 1);
assert(resolvedDark.uri.includes('dark-1000.jpg'), 'Resolved variant for color_scheme=1 picks dark URI');
assert(resolvedDark.clockAlpha === 0.45, 'Resolved dark variant preserves dark clockAlpha');
assert(resolvedDark.promptColor.useInverse === false, 'Resolved dark variant preserves dark non-inverse styling');

// Test switching cycle: LIGHT -> DARK -> LIGHT
const switch1 = resolveVariant(dualVariantMeta, 0);
assert(switch1.uri.includes('light-1000.jpg') && switch1.promptColor.r === 230, 'Switch cycle step 1 (LIGHT) matches light wallpaper and prompt');
const switch2 = resolveVariant(dualVariantMeta, 1);
assert(switch2.uri.includes('dark-1000.jpg') && switch2.promptColor.r === 35, 'Switch cycle step 2 (DARK) matches dark wallpaper and prompt');
const switch3 = resolveVariant(dualVariantMeta, 0);
assert(switch3.uri.includes('light-1000.jpg') && switch3.promptColor.r === 230, 'Switch cycle step 3 (re-LIGHT) matches light wallpaper and prompt');

// Test Cache Identity non-collision between Light and Dark
const idLight = createClockAlphaIdentity({
    targetUri: resolvedLight.uri,
    mtime: 1000,
    size: 500000,
    isColor: false,
    textLuminance: 1.0,
});
const idDark = createClockAlphaIdentity({
    targetUri: resolvedDark.uri,
    mtime: 1000,
    size: 500000,
    isColor: false,
    textLuminance: 1.0,
});
assert(serializeClockAlphaIdentity(idLight) !== serializeClockAlphaIdentity(idDark), 'Light and Dark variant cache keys do not collide');

// Test: Distinct source variants without metadata do NOT leak root pre-GDM promptColor
const unpopulatedDistinctMeta = {
    username: 'bob',
    color_scheme: 1, // Pre-GDM session was DARK
    source_uri: 'file:///usr/share/backgrounds/dark-wallpaper.jpg',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-dark.jpg',
    clockAlpha: 0.4,
    promptColor: { r: 20, g: 20, b: 20, useInverse: false },
    variants: {
        dark: {
            source_uri: 'file:///usr/share/backgrounds/dark-wallpaper.jpg',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-dark.jpg',
            clockAlpha: 0.4,
            promptColor: { r: 20, g: 20, b: 20, useInverse: false },
        },
        light: {
            source_uri: 'file:///usr/share/backgrounds/light-wallpaper.jpg',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-light.jpg',
            clockAlpha: null,
            promptColor: null,
        },
    },
};
const resolvedUnpopulatedLight = resolveVariant(unpopulatedDistinctMeta, 0);
assert(resolvedUnpopulatedLight.uri.includes('bob-light.jpg'), 'Resolved unpopulated light picks light wallpaper URI');
assert(resolvedUnpopulatedLight.promptColor === null, 'Distinct light variant without metadata does NOT leak dark pre-GDM promptColor');
assert(resolvedUnpopulatedLight.clockAlpha === null, 'Distinct light variant without metadata does NOT leak dark pre-GDM clockAlpha');

// Test: Identical source variants MAY safely share root metadata
const sameSourceOmittedMeta = {
    username: 'alice',
    color_scheme: 1,
    source_uri: 'file:///usr/share/backgrounds/shared-wallpaper.jpg',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-dark.jpg',
    clockAlpha: 0.55,
    promptColor: { r: 200, g: 200, b: 200, useInverse: true },
    variants: {
        dark: {
            source_uri: 'file:///usr/share/backgrounds/shared-wallpaper.jpg',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-dark.jpg',
            clockAlpha: 0.55,
            promptColor: { r: 200, g: 200, b: 200, useInverse: true },
        },
        light: {
            source_uri: 'file:///usr/share/backgrounds/shared-wallpaper.jpg',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-light.jpg',
            // clockAlpha and promptColor omitted
        },
    },
};
const resolvedSameSourceLight = resolveVariant(sameSourceOmittedMeta, 0);
assert(resolvedSameSourceLight.promptColor !== null && resolvedSameSourceLight.promptColor.r === 200, 'Same source variant safely shares root metadata');
assert(resolvedSameSourceLight.clockAlpha === 0.55, 'Same source variant safely shares root clockAlpha');

// Test backward compatibility fallback for legacy metadata without variants
const legacyMeta = {
    username: 'legacyuser',
    color_scheme: 0,
    source_uri: 'file:///usr/share/backgrounds/old.jpg',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-legacyuser-500.jpg',
    clockAlpha: 0.6,
};
const resolvedLegacy = resolveVariant(legacyMeta, 1);
assert(resolvedLegacy.uri === legacyMeta.uri, 'Legacy metadata without variants gracefully falls back to root fields');

print(`\n========================================`);
print(`Test Results: ${passed} Passed, ${failed} Failed`);
print(`========================================\n`);

if (failed > 0) {
    throw new Error(`${failed} tests failed`);
}
