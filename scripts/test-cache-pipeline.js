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
            clockAlpha: v.clockAlpha ?? null,
            promptColor: v.promptColor ?? null,
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
    variants: {
        light: {
            source_uri: 'file:///usr/share/backgrounds/gnome/adwaita-l.jxl',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-rinzler-light-1000.jpg',
            clockAlpha: 0.65,
            promptColor: {
                r: 230, g: 230, b: 230, useInverse: true,
                cancelColor: { r: 240, g: 240, b: 240 },
                a11yColor: { r: 235, g: 235, b: 235 },
                sessionColor: { r: 235, g: 235, b: 235 },
                avatarColor: { r: 230, g: 230, b: 230 },
            },
        },
        dark: {
            source_uri: 'file:///usr/share/backgrounds/gnome/adwaita-d.jxl',
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-rinzler-dark-1000.jpg',
            clockAlpha: 0.45,
            promptColor: {
                r: 35, g: 35, b: 40, useInverse: false,
                cancelColor: { r: 45, g: 45, b: 50 },
                a11yColor: { r: 40, g: 40, b: 45 },
                sessionColor: { r: 40, g: 40, b: 45 },
                avatarColor: { r: 35, g: 35, b: 40 },
            },
        },
    },
};

// Test Light Appearance Selection & Chrome State
const resolvedLight = resolveVariant(dualVariantMeta, 0);
assert(resolvedLight.uri.includes('light-1000.jpg'), 'Resolved variant for color_scheme=0 picks light URI');
assert(resolvedLight.clockAlpha === 0.65, 'Resolved light variant preserves light clockAlpha');
assert(resolvedLight.promptColor.useInverse === true, 'Resolved light variant preserves light inverse styling');
assert(resolvedLight.promptColor.cancelColor.r === 240, 'Resolved light variant has light cancel chrome color');
assert(resolvedLight.promptColor.a11yColor.r === 235, 'Resolved light variant has light a11y chrome color');
assert(resolvedLight.promptColor.sessionColor.r === 235, 'Resolved light variant has light session chrome color');

// Test Dark Appearance Selection & Chrome State
const resolvedDark = resolveVariant(dualVariantMeta, 1);
assert(resolvedDark.uri.includes('dark-1000.jpg'), 'Resolved variant for color_scheme=1 picks dark URI');
assert(resolvedDark.clockAlpha === 0.45, 'Resolved dark variant preserves dark clockAlpha');
assert(resolvedDark.promptColor.useInverse === false, 'Resolved dark variant preserves dark non-inverse styling');
assert(resolvedDark.promptColor.cancelColor.r === 45, 'Resolved dark variant has dark cancel chrome color');
assert(resolvedDark.promptColor.a11yColor.r === 40, 'Resolved dark variant has dark a11y chrome color');
assert(resolvedDark.promptColor.sessionColor.r === 40, 'Resolved dark variant has dark session chrome color');

// Test Round-Trip Transition (Dark -> Light -> Dark) Coherence
const roundTripLight = resolveVariant(dualVariantMeta, 0);
assert(roundTripLight.promptColor.cancelColor.r === 240, 'Transition back to light restores light cancel chrome');
assert(roundTripLight.promptColor.a11yColor.r === 235, 'Transition back to light restores light a11y chrome');

const roundTripDark = resolveVariant(dualVariantMeta, 1);
assert(roundTripDark.promptColor.cancelColor.r === 45, 'Transition back to dark restores dark cancel chrome');
assert(roundTripDark.promptColor.a11yColor.r === 40, 'Transition back to dark restores dark a11y chrome');

// Test Un-sampled Dark Variant Does Not Inherit Stale Light Chrome
const unSampledDarkMeta = {
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
        },
    },
};

const resolvedUnsampledDark = resolveVariant(unSampledDarkMeta, 1);
assert(resolvedUnsampledDark.promptColor === null, 'Unsampled dark variant resolves promptColor as null instead of inheriting stale light color');
assert(resolvedUnsampledDark.clockAlpha === null, 'Unsampled dark variant resolves clockAlpha as null instead of inheriting stale light alpha');

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

// 10. Test Last-Known Per-Account Light/Dark Continuity & GDM Quick Settings Alignment
print('\n[10] Testing Last-Known Per-Account Light/Dark Continuity & GDM Quick Settings:');

const defaultGdmScheme = 0; // GDM greeter default is Light

function resolveVariantWithAccountHint(rawMeta, explicitColorScheme = null) {
    if (!rawMeta)
        return null;
    const scheme = explicitColorScheme ?? rawMeta.color_scheme ?? defaultGdmScheme;
    const variantKey = scheme === 1 ? 'dark' : 'light';
    if (rawMeta.variants && rawMeta.variants[variantKey]) {
        const v = rawMeta.variants[variantKey];
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
            clockAlpha: v.clockAlpha ?? null,
            promptColor: v.promptColor ?? null,
            active_color_scheme: scheme,
        };
    }
    return {
        ...rawMeta,
        active_color_scheme: scheme,
    };
}

const aliceMeta = {
    username: 'alice',
    color_scheme: 1, // Alice was last observed in Dark mode
    variants: {
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-light.jpg',
            clockAlpha: 0.65,
            promptColor: { r: 230, g: 230, b: 230, useInverse: true, cancelColor: { r: 230, g: 230, b: 230 } },
        },
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-dark.jpg',
            clockAlpha: 0.45,
            promptColor: { r: 35, g: 35, b: 40, useInverse: false, cancelColor: { r: 35, g: 35, b: 40 } },
        },
    },
};

const bobMeta = {
    username: 'bob',
    color_scheme: 0, // Bob was last observed in Light mode
    variants: {
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-light.jpg',
            clockAlpha: 0.60,
            promptColor: { r: 240, g: 240, b: 240, useInverse: true, cancelColor: { r: 240, g: 240, b: 240 } },
        },
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-dark.jpg',
            clockAlpha: 0.50,
            promptColor: { r: 30, g: 30, b: 35, useInverse: false, cancelColor: { r: 30, g: 30, b: 35 } },
        },
    },
};

const charlieMeta = {
    username: 'charlie',
    color_scheme: 1, // Charlie was last observed in Dark mode
    variants: {
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-charlie-light.jpg',
            clockAlpha: 0.60,
            promptColor: { r: 235, g: 235, b: 235, useInverse: true, cancelColor: { r: 235, g: 235, b: 235 } },
        },
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-charlie-dark.jpg',
            clockAlpha: 0.40,
            promptColor: { r: 25, g: 25, b: 30, useInverse: false, cancelColor: { r: 25, g: 25, b: 30 } },
        },
    },
};

// Case A: Alice (Dark account) initializes to Dark variant without explicit GDM override
const aliceDefault = resolveVariantWithAccountHint(aliceMeta);
assert(aliceDefault.uri.includes('alice-dark.jpg'), 'Case A: Dark account (Alice) initializes to Dark variant');
assert(aliceDefault.active_color_scheme === 1, 'Case A: Alice active_color_scheme is 1 (Dark)');
assert(aliceDefault.clockAlpha === 0.45, 'Case A: Alice clockAlpha is 0.45');
assert(aliceDefault.promptColor.useInverse === false, 'Case A: Alice promptColor is non-inverse');

// Case B: Bob (Light account) initializes to Light variant without explicit GDM override
const bobDefault = resolveVariantWithAccountHint(bobMeta);
assert(bobDefault.uri.includes('bob-light.jpg'), 'Case B: Light account (Bob) initializes to Light variant');
assert(bobDefault.active_color_scheme === 0, 'Case B: Bob active_color_scheme is 0 (Light)');
assert(bobDefault.clockAlpha === 0.60, 'Case B: Bob clockAlpha is 0.60');
assert(bobDefault.promptColor.useInverse === true, 'Case B: Bob promptColor is inverse');

// Case C: Switching Alice -> Bob -> Alice does not leak account state
const switchBob = resolveVariantWithAccountHint(bobMeta);
assert(switchBob.active_color_scheme === 0, 'Case C: Bob remains Light after Alice');
const switchAlice = resolveVariantWithAccountHint(aliceMeta);
assert(switchAlice.active_color_scheme === 1, 'Case C: Alice remains Dark after Bob');

// Case D: Missing color_scheme falls back to GDM greeter default
const missingSchemeMeta = {
    username: 'carol',
    variants: {
        light: { uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-carol-light.jpg' },
        dark: { uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-carol-dark.jpg' },
    },
};
const carolResolved = resolveVariantWithAccountHint(missingSchemeMeta);
assert(carolResolved.active_color_scheme === defaultGdmScheme, 'Case D: Missing color_scheme falls back to GDM greeter default');
assert(carolResolved.uri.includes('carol-light.jpg'), 'Case D: Resolves light variant for default greeter');

// Case E: Explicit GDM Quick Settings Override (e.g. user manually toggled Light on GDM screen)
const aliceGdmOverrideLight = resolveVariantWithAccountHint(aliceMeta, 0); // User forced Light at GDM
assert(aliceGdmOverrideLight.active_color_scheme === 0, 'Case E: Explicit GDM Quick Settings override (0) overrides Alice hint');
assert(aliceGdmOverrideLight.uri.includes('alice-light.jpg'), 'Case E: Alice resolves to Light variant under explicit GDM override');

const bobGdmOverrideDark = resolveVariantWithAccountHint(bobMeta, 1); // User forced Dark at GDM
assert(bobGdmOverrideDark.active_color_scheme === 1, 'Case E: Explicit GDM Quick Settings override (1) overrides Bob hint');
assert(bobGdmOverrideDark.uri.includes('bob-dark.jpg'), 'Case E: Bob resolves to Dark variant under explicit GDM override');

// Case F: GDM Quick Settings Appearance Alignment & Account Switch Lifecycle
class MockGdmInterfaceSettings {
    constructor(initialScheme = 0) {
        this._scheme = initialScheme;
    }
    get_enum(key) {
        if (key === 'color-scheme')
            return this._scheme;
        return 0;
    }
    set_enum(key, val) {
        if (key === 'color-scheme')
            this._scheme = val;
    }
}

class MockGdmThemePipeline {
    constructor(initialScheme = 0) {
        this.settings = new MockGdmInterfaceSettings(initialScheme);
        this.themes = new Map();
        this.presentedTheme = null;
        this.presentedUser = null;
    }

    loadUser(rawMeta) {
        const theme = {
            userName: rawMeta.username,
            rawMeta,
            meta: resolveVariantWithAccountHint(rawMeta, this.getColorScheme()),
        };
        this.themes.set(rawMeta.username, theme);
    }

    getColorScheme() {
        return this.settings.get_enum('color-scheme');
    }

    setColorScheme(scheme) {
        if (this.getColorScheme() !== scheme) {
            this.settings.set_enum('color-scheme', scheme);
            this._onColorSchemeChanged();
        }
    }

    peek(userName) {
        return this.themes.get(userName) ?? null;
    }

    _onColorSchemeChanged() {
        const scheme = this.getColorScheme();
        for (const [, theme] of this.themes) {
            theme.meta = resolveVariantWithAccountHint(theme.rawMeta, scheme);
        }
        if (this.presentedUser) {
            this.applyWallpaper(this.presentedUser, false, false);
        }
    }

    manualToggleQuickSettings(newScheme) {
        this.setColorScheme(newScheme);
    }

    applyWallpaper(userName, animate = true, syncColorScheme = true) {
        let theme = this.peek(userName);
        if (!theme)
            return;

        if (syncColorScheme) {
            const raw = theme.rawMeta ?? theme.meta;
            const targetScheme = raw?.color_scheme ?? theme.meta?.active_color_scheme;
            if (targetScheme !== undefined && this.getColorScheme() !== targetScheme) {
                this.setColorScheme(targetScheme);
                const updated = this.peek(userName);
                if (updated)
                    theme = updated;
            }
        }

        this.presentedUser = userName;
        this.presentedTheme = theme;
    }
}

// 1. Remembered Dark account initializes GDM QS state to Dark
const gdmPipeline = new MockGdmThemePipeline(0); // Starts at default Light (0)
gdmPipeline.loadUser(aliceMeta);
gdmPipeline.loadUser(bobMeta);
gdmPipeline.applyWallpaper('alice', false, true);
assert(gdmPipeline.getColorScheme() === 1, 'Lifecycle: Remembered Dark account sets GDM QS state to Dark (1)');
assert(gdmPipeline.presentedTheme.meta.active_color_scheme === 1, 'Lifecycle: Remembered Dark account presents Dark active_color_scheme');
assert(gdmPipeline.presentedTheme.meta.uri.includes('alice-dark.jpg'), 'Lifecycle: Remembered Dark account presents Dark wallpaper');

// 2. Remembered Light account initializes GDM QS state to Light
const gdmPipelineLight = new MockGdmThemePipeline(1); // Starts at Dark (1)
gdmPipelineLight.loadUser(bobMeta);
gdmPipelineLight.applyWallpaper('bob', false, true);
assert(gdmPipelineLight.getColorScheme() === 0, 'Lifecycle: Remembered Light account sets GDM QS state to Light (0)');
assert(gdmPipelineLight.presentedTheme.meta.active_color_scheme === 0, 'Lifecycle: Remembered Light account presents Light active_color_scheme');
assert(gdmPipelineLight.presentedTheme.meta.uri.includes('bob-light.jpg'), 'Lifecycle: Remembered Light account presents Light wallpaper');

// 3. Switching Account A (Dark) -> Account B (Light): QS follows B
gdmPipeline.applyWallpaper('bob', true, true);
assert(gdmPipeline.getColorScheme() === 0, 'Lifecycle: Account A Dark -> Account B Light: QS follows B (0)');
assert(gdmPipeline.presentedTheme.meta.active_color_scheme === 0, 'Lifecycle: Account B presents Light active_color_scheme');
assert(gdmPipeline.presentedTheme.meta.uri.includes('bob-light.jpg'), 'Lifecycle: Account B presents Light wallpaper');

// 4. Account A Dark -> manual GDM toggle to Light -> wallpaper/QS remain Light
gdmPipeline.applyWallpaper('alice', true, true);
assert(gdmPipeline.getColorScheme() === 1, 'Lifecycle: Switching back to Alice restores Dark QS (1)');
assert(gdmPipeline.presentedTheme.meta.uri.includes('alice-dark.jpg'), 'Lifecycle: Alice presents Dark wallpaper');
assert(gdmPipeline.presentedTheme.meta.promptColor.useInverse === false, 'Lifecycle: Alice presents Dark non-inverse vibrancy before toggle');
gdmPipeline.manualToggleQuickSettings(0); // User manually clicks Light on GDM QS toggle
assert(gdmPipeline.getColorScheme() === 0, 'Lifecycle: Manual GDM QS toggle updates GDM QS to Light (0)');
assert(gdmPipeline.presentedTheme.meta.active_color_scheme === 0, 'Lifecycle: Manual GDM QS toggle updates presented wallpaper to Light');
assert(gdmPipeline.presentedTheme.meta.uri.includes('alice-light.jpg'), 'Lifecycle: Alice presents Light wallpaper after manual toggle');
assert(gdmPipeline.presentedTheme.meta.promptColor.useInverse === true, 'Lifecycle: Alice presents Light inverse vibrancy after manual toggle');
assert(gdmPipeline.presentedTheme.meta.promptColor.cancelColor.r === 230, 'Lifecycle: Alice presents Light cancel chrome after manual toggle');
assert(gdmPipeline.presentedTheme.meta.clockAlpha === 0.65, 'Lifecycle: Alice presents Light clockAlpha after manual toggle');

// 5. Manual override -> switching to another account -> selected account remembered state is restored
gdmPipeline.loadUser(charlieMeta);
gdmPipeline.applyWallpaper('charlie', true, true); // Charlie remembered as Dark (1)
assert(gdmPipeline.getColorScheme() === 1, 'Lifecycle: Account switch after manual override restores Charlie remembered Dark QS (1)');
assert(gdmPipeline.presentedTheme.meta.active_color_scheme === 1, 'Lifecycle: Charlie presents Dark active_color_scheme');
assert(gdmPipeline.presentedTheme.meta.uri.includes('charlie-dark.jpg'), 'Lifecycle: Charlie presents Dark wallpaper');
assert(gdmPipeline.presentedTheme.meta.promptColor.useInverse === false, 'Lifecycle: Charlie presents Dark non-inverse vibrancy');
assert(gdmPipeline.presentedTheme.meta.promptColor.cancelColor.r === 25, 'Lifecycle: Charlie presents Dark cancel chrome');
assert(gdmPipeline.presentedTheme.meta.clockAlpha === 0.40, 'Lifecycle: Charlie presents Dark clockAlpha');

// 6. Cold-Boot First-Frame Presentation & Inactive Stack Opacity
class MockGdmWallpaperView {
    constructor() {
        this.stacks = new Map();
        this.topKey = null;
        this.topOpacity = 0;
        this.lastAnimated = null;
    }

    warm(theme) {
        const key = theme.userName;
        if (!this.stacks.has(key)) {
            // Warmed inactive stacks must initialize at opacity 0
            this.stacks.set(key, { opacity: 0, key });
        }
    }

    present(theme, animate) {
        const key = theme.userName;
        let stack = this.stacks.get(key);
        if (!stack) {
            stack = { opacity: 0, key };
            this.stacks.set(key, stack);
        }
        this.lastAnimated = animate;
        if (animate) {
            stack.opacity = 0;
            // Simulated ease to 255
            stack.opacity = 255;
        } else {
            stack.opacity = 255;
        }
        this.topKey = key;
        this.topOpacity = stack.opacity;
    }
}

class MockGdmWallpaperManager {
    constructor(themePipeline) {
        this.themePipeline = themePipeline;
        this.view = new MockGdmWallpaperView();
        this._initialized = false;
    }

    setup(activeUser = null) {
        this._initialized = false;
        // Warm all cached accounts
        for (const [name, theme] of this.themePipeline.themes) {
            this.view.warm(theme);
        }
        // Initial presentation MUST be immediate (animate = false)
        this.applyWallpaper(activeUser, false, true);
        this._initialized = true;
    }

    applyWallpaper(userName, animate = true, syncColorScheme = true) {
        const effectiveUser = userName ?? this.themePipeline.defaultUser;
        const theme = this.themePipeline.peek(effectiveUser);
        if (!theme) return;

        if (syncColorScheme) {
            const raw = theme.rawMeta ?? theme.meta;
            const targetScheme = raw?.color_scheme ?? theme.meta?.active_color_scheme;
            if (targetScheme !== undefined && this.themePipeline.getColorScheme() !== targetScheme) {
                this.themePipeline.setColorScheme(targetScheme);
            }
        }
        this.view.present(theme, animate);
    }
}

const coldBootPipeline = new MockGdmThemePipeline(0); // GDM starts at 0 (Light)
coldBootPipeline.defaultUser = 'alice'; // Alice is newest
coldBootPipeline.loadUser(aliceMeta);   // Alice is Dark (1)
coldBootPipeline.loadUser(bobMeta);     // Bob is Light (0)

const coldBootManager = new MockGdmWallpaperManager(coldBootPipeline);
coldBootManager.setup(null);

assert(coldBootManager.view.lastAnimated === false, 'Cold-boot: Initial presentation adopts immediately (animate = false)');
assert(coldBootManager.view.topKey === 'alice', 'Cold-boot: Selected default user is presented as top stack');
assert(coldBootManager.view.topOpacity === 255, 'Cold-boot: Active top stack is fully opaque (opacity = 255)');
assert(coldBootManager.view.stacks.get('bob').opacity === 0, 'Cold-boot: Warmed inactive user stack remains hidden (opacity = 0)');
assert(coldBootPipeline.getColorScheme() === 1, 'Cold-boot: GDM color-scheme synchronized to active user hint without flash');

// Live user switch after initialization uses animated crossfade
coldBootManager.applyWallpaper('bob', true, true);
assert(coldBootManager.view.lastAnimated === true, 'Live switch: Account switch performs animated transition (animate = true)');
assert(coldBootManager.view.topKey === 'bob', 'Live switch: Bob becomes active top stack');
assert(coldBootManager.view.topOpacity === 255, 'Live switch: Bob top stack is fully opaque');

// 11. Counterpart Vibrancy Pending-Palette Regression Tests
// Covers the DARK → LIGHT toggle regression where the Light counterpart has
// promptColor = null (never sampled in the active session).  The pendingPalette
// flag must prevent destructive clearing while sampling is queued, and the full
// palette must be applied once _drainOne() delivers it.
print('\n[11] Testing Counterpart Vibrancy Pending-Palette (Light/Dark Toggle Regression):');

// ---- mock helpers that mirror the real _install / _drainOne / _onChanged
//      state machine, minus actual pixel sampling -------------------------------

function mockInstall(rawMeta, explicitScheme, paletteCache, previousTheme) {
    const scheme = explicitScheme ?? rawMeta.color_scheme ?? 0;
    const variantKey = scheme === 1 ? 'dark' : 'light';
    const v = rawMeta.variants?.[variantKey] ?? {};
    const meta = {
        ...rawMeta,
        uri: v.uri ?? rawMeta.uri,
        clockAlpha: v.clockAlpha ?? null,
        promptColor: v.promptColor ?? null,
        active_color_scheme: scheme,
    };
    const image = meta.uri ?? '';
    const mode = 'tonal';
    const paletteKey = `${image}|${mode}`;

    // Prefer cache > shipped promptColor > nothing
    let palette = paletteCache.get(paletteKey) ?? null;
    if (palette === null && meta.promptColor) {
        palette = { mode, image, isShipped: true, value: meta.promptColor };
        paletteCache.set(paletteKey, palette);
    }

    const pendingPalette = palette === null;
    return Object.freeze({ userName: rawMeta.username, meta, rawMeta, image, palette, clockAlpha: meta.clockAlpha, pendingPalette });
}

function mockDrainComplete(theme, sampledValue, paletteCache) {
    // Simulate _drainOne() completing: write palette + explicitly clear flag
    const mode = 'tonal';
    const paletteKey = `${theme.image}|${mode}`;
    const palette = { mode, image: theme.image, isShipped: false, value: sampledValue };
    paletteCache.set(paletteKey, palette);
    return Object.freeze({ ...theme, palette, pendingPalette: false });
}

// Account with Dark variant shipped (promptColor populated) and Light variant
// unsampled (promptColor = null), mirroring the exact publication from CSM when
// the active session was Dark.
const daveMeta = {
    username: 'dave',
    color_scheme: 1, // Dave was last in Dark
    variants: {
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-dave-dark.jpg',
            clockAlpha: 0.45,
            promptColor: { r: 30, g: 30, b: 35, useInverse: false },
        },
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-dave-light.jpg',
            clockAlpha: null,      // NOT published — session never ran in Light
            promptColor: null,     // NOT published — counterpart unsampled
        },
    },
};

// Account with Light variant already cached (simulates a previous sampling run)
const eveMeta = {
    username: 'eve',
    color_scheme: 0, // Eve was last in Light
    variants: {
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-eve-light.jpg',
            clockAlpha: 0.60,
            promptColor: { r: 230, g: 230, b: 230, useInverse: true },
        },
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-eve-dark.jpg',
            clockAlpha: 0.50,
            promptColor: { r: 40, g: 40, b: 45, useInverse: false },
        },
    },
};

const paletteCache11 = new Map();

// --- Test 1: Initial DARK boot for Dave --- palette ships from dark variant
const daveInitial = mockInstall(daveMeta, null, paletteCache11, undefined);
assert(daveInitial.pendingPalette === false, '[11] Dave (Dark init): shipped Dark palette → pendingPalette is false');
assert(daveInitial.palette !== null, '[11] Dave (Dark init): palette is populated from shipped Dark promptColor');
assert(daveInitial.meta.uri.includes('dave-dark.jpg'), '[11] Dave (Dark init): dark URI resolved');

// --- Test 2: Manual GDM toggle DARK → LIGHT for Dave (unsampled counterpart) ---
const daveLight = mockInstall(daveMeta, 0, paletteCache11, daveInitial);
assert(daveLight.pendingPalette === true, '[11] Dave (DARK→LIGHT toggle): unsampled Light → pendingPalette is true');
assert(daveLight.palette === null, '[11] Dave (DARK→LIGHT toggle): palette is null while sampling is pending');
assert(daveLight.meta.uri.includes('dave-light.jpg'), '[11] Dave (DARK→LIGHT toggle): light URI selected');
assert(daveLight.clockAlpha === null, '[11] Dave (DARK→LIGHT toggle): clockAlpha is null while pending');

// --- Test 3: Verify applyTheme guard semantics on pending theme ---
// (Simulated: applyTheme must return early when pendingPalette is true)
let applyThemeCalled = false;
function simulateApplyTheme(theme) {
    if (!theme) return;
    if (theme.pendingPalette) return;   // <-- the actual guard added to applyTheme()
    applyThemeCalled = true;
}
simulateApplyTheme(daveLight);
assert(applyThemeCalled === false, '[11] Dave (DARK→LIGHT toggle): applyTheme skipped while pendingPalette is true');

// --- Test 4: _drainOne() completes — pendingPalette cleared, palette set ---
const sampledLightValue = { r: 225, g: 225, b: 228, useInverse: true };
const daveLightResolved = mockDrainComplete(daveLight, sampledLightValue, paletteCache11);
assert(daveLightResolved.pendingPalette === false, '[11] Dave (after drain): pendingPalette cleared to false');
assert(daveLightResolved.palette !== null, '[11] Dave (after drain): palette is now populated');
assert(daveLightResolved.palette.value.r === 225, '[11] Dave (after drain): sampled Light palette value matches drain result');
simulateApplyTheme(daveLightResolved);
assert(applyThemeCalled === true, '[11] Dave (after drain): applyTheme proceeds normally after drain');

// --- Test 5: Subsequent LIGHT → DARK toggle hits paletteCache immediately ---
const daveDarkToggle = mockInstall(daveMeta, 1, paletteCache11, daveLightResolved);
assert(daveDarkToggle.pendingPalette === false, '[11] Dave (LIGHT→DARK re-toggle): cached Dark palette → pendingPalette false');
assert(daveDarkToggle.palette !== null, '[11] Dave (LIGHT→DARK re-toggle): Dark palette retrieved from cache');

// --- Test 6: Subsequent DARK → LIGHT toggle hits paletteCache immediately ---
const daveLightToggle2 = mockInstall(daveMeta, 0, paletteCache11, daveDarkToggle);
assert(daveLightToggle2.pendingPalette === false, '[11] Dave (DARK→LIGHT re-toggle after cache): pendingPalette false (cache hit)');
assert(daveLightToggle2.palette !== null, '[11] Dave (DARK→LIGHT re-toggle after cache): Light palette retrieved from cache');
assert(daveLightToggle2.palette.value.r === 225, '[11] Dave (DARK→LIGHT re-toggle after cache): correct Light palette value');

// --- Test 7: Account switching between Dave (unsampled Light) and Eve (shipped Light) ---
const eveInitial = mockInstall(eveMeta, null, paletteCache11, undefined);
assert(eveInitial.pendingPalette === false, '[11] Eve (Light init): shipped Light palette → pendingPalette false');
assert(eveInitial.palette !== null, '[11] Eve (Light init): palette populated from shipped Light promptColor');

// Switch to Dave (currently pending Light), then back to Eve
const daveForSwitch = mockInstall(daveMeta, 0, paletteCache11, daveLight);
// Dave Light is NOW in paletteCache11 (from drain above)
assert(daveForSwitch.pendingPalette === false, '[11] Dave after Eve switch: Light now in cache → pendingPalette false');
assert(daveForSwitch.palette !== null, '[11] Dave after Eve switch: Light palette resolved from cache');

// Switch back to Eve
const eveAfterDave = mockInstall(eveMeta, 0, paletteCache11, eveInitial);
assert(eveAfterDave.pendingPalette === false, '[11] Eve (after Dave): still not pending');
assert(eveAfterDave.palette !== null, '[11] Eve (after Dave): palette still intact');
assert(eveAfterDave.meta.uri.includes('eve-light.jpg'), '[11] Eve (after Dave): correct URI');

// --- Test 8: DARK-only account (no Light counterpart ever sampled) behaves
//             identically to Dave during first toggle --- pendingPalette true,
//             drain delivers palette, subsequent toggles hit cache. ---
const frankMeta = {
    username: 'frank',
    color_scheme: 1,
    variants: {
        dark: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-frank-dark.jpg',
            clockAlpha: 0.50,
            promptColor: { r: 20, g: 20, b: 25, useInverse: false },
        },
        light: {
            uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-frank-light.jpg',
            clockAlpha: null,
            promptColor: null,
        },
    },
};
const paletteCache11b = new Map();
const frankDark = mockInstall(frankMeta, 1, paletteCache11b, undefined);
assert(frankDark.pendingPalette === false, '[11] Frank (Dark-only init): Dark ships → pendingPalette false');
const frankLight = mockInstall(frankMeta, 0, paletteCache11b, frankDark);
assert(frankLight.pendingPalette === true, '[11] Frank (DARK→LIGHT first toggle): unsampled Light → pendingPalette true');
const frankLightResolved = mockDrainComplete(frankLight, { r: 218, g: 218, b: 220 }, paletteCache11b);
assert(frankLightResolved.pendingPalette === false, '[11] Frank (after drain): pendingPalette cleared');
const frankLightCached = mockInstall(frankMeta, 0, paletteCache11b, frankLightResolved);
assert(frankLightCached.pendingPalette === false, '[11] Frank (DARK→LIGHT second toggle): Light in cache → pendingPalette false');

// --- Test 9: Cold-boot behavior unchanged — pendingPalette true on first
//             install if no shipped palette, cleared when drain fires. ---
//             (mirrors the cold-boot tests from section [10])
const paletteCache11c = new Map();
const daveColdDark = mockInstall(daveMeta, 1, paletteCache11c, undefined);
// On cold boot with the shipped Dark palette the theme is NOT pending:
assert(daveColdDark.pendingPalette === false, '[11] Cold-boot Dave (Dark shipped): pendingPalette false — immediate present works');

print(`\n========================================`);
print(`Test Results: ${passed} Passed, ${failed} Failed`);
print(`========================================\n`);

if (failed > 0) {
    throw new Error(`${failed} tests failed`);
}
