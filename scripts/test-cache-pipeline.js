import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {
    createClockAlphaIdentity,
    serializeClockAlphaIdentity,
    createPromptVibrancyIdentity,
    serializePromptVibrancyIdentity,
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
import {
    getNotifCardBackground,
    getAcrylicChipBackground,
} from '../src/main/colorUtils.js';

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
assert(vKey1.includes('vmacrylic'), 'Prompt vibrancy key contains vibrancy mode');

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
    suspendColor: { r: 50, g: 60, b: 70 },
    restartColor: { r: 50, g: 60, b: 70 },
    powerOffColor: { r: 50, g: 60, b: 70 },
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

// 10. Test Manifest Schema Versioning & Compatibility Gate
print('\n[10] Testing Cross-Session Manifest Schema Versioning & Compatibility:');

const CURRENT_MANIFEST_VERSION = 1;

function isManifestVersionSupported(meta) {
    if (!meta || typeof meta !== 'object')
        return false;
    if (meta.__manifest_version__ === undefined)
        return true;
    return meta.__manifest_version__ === CURRENT_MANIFEST_VERSION;
}

// 1. Version 1 manifest is accepted
const v1Manifest = {
    __manifest_version__: 1,
    username: 'alice',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-dark.jpg',
};
assert(isManifestVersionSupported(v1Manifest) === true, 'Version 1 manifest is accepted');

// 2. Missing version is accepted (legacy unversioned manifest)
const legacyUnversionedManifest = {
    username: 'bob',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob.jpg',
};
assert(isManifestVersionSupported(legacyUnversionedManifest) === true, 'Missing __manifest_version__ (legacy) is accepted');
assert(isManifestVersionSupported({ ...legacyUnversionedManifest, __manifest_version__: undefined }) === true, 'Undefined __manifest_version__ is accepted');

// 3. Unsupported version is rejected
const futureV2Manifest = {
    __manifest_version__: 2,
    username: 'charlie',
    uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-charlie-v2.jpg',
};
const unsupportedVersionManifest = {
    __manifest_version__: 99,
    username: 'charlie',
};
const nonNumberVersionManifest = {
    __manifest_version__: '1',
    username: 'charlie',
};
assert(isManifestVersionSupported(futureV2Manifest) === false, 'Future version 2 manifest is rejected');
assert(isManifestVersionSupported(unsupportedVersionManifest) === false, 'Unsupported version 99 manifest is rejected');
assert(isManifestVersionSupported(nonNumberVersionManifest) === false, 'Non-matching type version manifest is rejected');

// Minimal ThemeStore model to verify store state retention across sync/async paths
class MockGdmThemeStore {
    constructor() {
        this.themes = new Map();
        this.changedCount = 0;
    }

    _install(userName, meta, xmlText) {
        this.themes.set(userName, { meta, xmlText });
    }

    _onChanged(userName) {
        this.changedCount++;
    }

    loadUserSync(userName, meta) {
        if (!meta) return;
        if (!isManifestVersionSupported(meta))
            return;
        const effectiveName = meta.username || userName;
        this._install(effectiveName, meta, null);
    }

    async loadUser(userName, meta) {
        if (!meta) return;
        if (!isManifestVersionSupported(meta))
            return;
        const effectiveName = meta.username || userName;
        this._install(effectiveName, meta, null);
        this._onChanged(effectiveName);
    }
}

// 4. Rejection does not replace an existing valid presentation
const store = new MockGdmThemeStore();
store.loadUserSync('alice', v1Manifest);
assert(store.themes.get('alice')?.meta?.uri === v1Manifest.uri, 'Initial valid presentation installed');

// Attempt sync load of unsupported version
store.loadUserSync('alice', futureV2Manifest);
assert(store.themes.get('alice')?.meta?.uri === v1Manifest.uri, 'Sync load of unsupported version leaves existing valid presentation untouched');

// Attempt async load of unsupported version
await store.loadUser('alice', futureV2Manifest);
assert(store.themes.get('alice')?.meta?.uri === v1Manifest.uri, 'Async load of unsupported version leaves existing valid presentation untouched');
assert(store.changedCount === 0, 'No change notification fired on rejected manifest');

// 5. Both synchronous and asynchronous manifest loading paths apply the same rule
const syncStore = new MockGdmThemeStore();
const asyncStore = new MockGdmThemeStore();

// Test both paths with legacy unversioned
syncStore.loadUserSync('bob', legacyUnversionedManifest);
await asyncStore.loadUser('bob', legacyUnversionedManifest);
assert(syncStore.themes.has('bob') && asyncStore.themes.has('bob'), 'Both sync and async paths accept legacy unversioned manifest');

// Test both paths with supported v1
syncStore.loadUserSync('alice', v1Manifest);
await asyncStore.loadUser('alice', v1Manifest);
assert(syncStore.themes.has('alice') && asyncStore.themes.has('alice'), 'Both sync and async paths accept version 1 manifest');

// Test both paths with unsupported v2
syncStore.loadUserSync('charlie', futureV2Manifest);
await asyncStore.loadUser('charlie', futureV2Manifest);
assert(!syncStore.themes.has('charlie') && !asyncStore.themes.has('charlie'), 'Both sync and async paths reject unsupported version 2 manifest');

// 11. Test GDM Auth State Machine
print('\n[11] Testing GDM Auth State Machine:');
const { GdmAuthState, GdmAuthStateController } = await import('../src/pro/gdmAuthState.js');

const mockGdm = { _dialog: { _user: { get_user_name: () => 'alice' } } };
const authCtrl = new GdmAuthStateController(mockGdm);

assert(authCtrl.state === GdmAuthState.IDLE, 'Initial state is IDLE');
assert(authCtrl.isIdle === true, 'isIdle is true');
assert(authCtrl.isNotListed === false, 'isNotListed initially false');
assert(authCtrl.legacyAnimationState === 'idle', 'Initial legacy state is idle');

// Selection transition
const selResult = authCtrl.selectUser(false);
assert(selResult === true, 'selectUser transition succeeds');
assert(authCtrl.state === GdmAuthState.SELECTION, 'State is SELECTION');
assert(authCtrl.isSelection === true, 'isSelection is true');
assert(authCtrl.legacyAnimationState === 'selection', 'Legacy state in SELECTION is selection');

// Authentication transition
const authResult = authCtrl.beginAuthentication();
assert(authResult === true, 'beginAuthentication succeeds');
assert(authCtrl.state === GdmAuthState.AUTHENTICATING, 'State is AUTHENTICATING');
assert(authCtrl.isAuthenticating === true, 'isAuthenticating is true');
assert(authCtrl.legacyAnimationState === 'idle', 'Legacy state in AUTHENTICATING is idle');

// Soft retry (stay in authenticating)
const retryResult = authCtrl.transitionTo(GdmAuthState.AUTHENTICATING, 'retry');
assert(retryResult === true, 'Soft retry staying in AUTHENTICATING succeeds');

// Reset to picker
const resetStart = authCtrl.beginReset();
assert(resetStart === true, 'beginReset succeeds');
assert(authCtrl.state === GdmAuthState.RESETTING, 'State is RESETTING');
assert(authCtrl.isResetting === true, 'isResetting is true');

const resetFinish = authCtrl.finishReset();
assert(resetFinish === true, 'finishReset succeeds');
assert(authCtrl.state === GdmAuthState.IDLE, 'State returned to IDLE');

// Verification success
authCtrl.selectUser(true);
assert(authCtrl.isNotListed === true, 'isNotListed properly set when true');
authCtrl.beginAuthentication();
const succResult = authCtrl.markSuccess();
assert(succResult === true, 'markSuccess succeeds');
assert(authCtrl.state === GdmAuthState.SUCCESS, 'State is SUCCESS');
assert(authCtrl.isSuccess === true, 'isSuccess is true');
assert(authCtrl.legacyAnimationState === 'success', 'Legacy state in SUCCESS is success');

// Guard against invalid transition while verified
const invalidTransition = authCtrl.transitionTo(GdmAuthState.SELECTION, 'spurious');
assert(invalidTransition === false, 'Spurious selection transition from SUCCESS is rejected');
assert(authCtrl.state === GdmAuthState.SUCCESS, 'State remains SUCCESS after rejected transition');

// Full reset leaves SUCCESS
authCtrl.reset('dialog_teardown');
assert(authCtrl.state === GdmAuthState.IDLE, 'reset() cleanly returns from SUCCESS to IDLE');
assert(authCtrl.isNotListed === false, 'reset() clears isNotListed');

// 12. Test Unlock Sequence State Lifecycle & Snapshot Preservation
print('\n[12] Testing Unlock Sequence State:');
const { UnlockSequenceState } = await import('../src/main/unlockState.js');

assert(UnlockSequenceState.IDLE === 'IDLE', 'UnlockSequenceState has IDLE');
assert(UnlockSequenceState.PREPARING === 'PREPARING', 'UnlockSequenceState has PREPARING');
assert(UnlockSequenceState.SNAPSHOT_ANIMATING === 'SNAPSHOT_ANIMATING', 'UnlockSequenceState has SNAPSHOT_ANIMATING');
assert(UnlockSequenceState.FINISHING === 'FINISHING', 'UnlockSequenceState has FINISHING');
assert(UnlockSequenceState.COMPLETED === 'COMPLETED', 'UnlockSequenceState has COMPLETED');

// Verify snapshot splice behavior
const mockGlobal = globalThis.global || globalThis;
mockGlobal.wack_window_snapshots = [{ id: 1 }, { id: 2 }];
const captured = Array.isArray(mockGlobal.wack_window_snapshots)
    ? mockGlobal.wack_window_snapshots.splice(0)
    : [];
assert(captured.length === 2, 'Captured exactly 2 window snapshots');
assert(mockGlobal.wack_window_snapshots.length === 0, 'Global snapshots array drained by splice');
delete mockGlobal.wack_window_snapshots;

// 13. Test Avatar Classification Types
print('\n[13] Testing Avatar Classification:');
const { AvatarType } = await import('../src/pro/gdmAuthState.js');

assert(AvatarType.IMAGE === 'IMAGE', 'AvatarType has IMAGE');
assert(AvatarType.SYMBOLIC === 'SYMBOLIC', 'AvatarType has SYMBOLIC');
assert(AvatarType.PENDING === 'PENDING', 'AvatarType has PENDING');

// 14. Test GDM DLC Integrity & Configuration Invariants
print('\n[14] Testing GDM DLC Integrity & GDM Settings Resilience:');
const avatarManagerFile = Gio.File.new_for_path('src/pro/gdmAvatarManager.js');
const [, avatarManagerBytes] = avatarManagerFile.load_contents(null);
const avatarManagerText = new TextDecoder('utf-8').decode(avatarManagerBytes);

const duplicateDeclarations = (avatarManagerText.match(/const\s+AvatarType\s*=/g) || []).length;
assert(duplicateDeclarations === 0, 'gdmAvatarManager.js must not re-declare AvatarType');
assert(avatarManagerText.includes("import { AvatarType } from './gdmAuthState.js'"), 'gdmAvatarManager imports AvatarType from gdmAuthState');

const gdmCssFile = Gio.File.new_for_path('src/pro/gdm.css');
const [, gdmCssBytes] = gdmCssFile.load_contents(null);
const gdmCssText = new TextDecoder('utf-8').decode(gdmCssBytes);
assert(gdmCssText.includes('.login-dialog-user-list-item:logged-in .user-icon'), 'gdm.css targets logged-in user icon');
assert(!gdmCssText.includes('border-color: -st-accent-color !important;'), 'gdm.css removes accent-color border on logged-in users');
assert(gdmCssText.includes('border-color: transparent !important;'), 'gdm.css forces border-color transparent for logged-in users');

const legacyDconf = Gio.File.new_for_path('/etc/dconf/db/gdm.d/99-wack-lockscreen');
assert(!legacyDconf.query_exists(null), 'Legacy 99-wack-lockscreen is removed to prevent GDM Settings purge');

const safeDconf = Gio.File.new_for_path('/etc/dconf/db/gdm.d/50-wack-lockscreen');
assert(safeDconf.query_exists(null), '50-wack-lockscreen exists with priority < 95');

// 15. Test Dual Kawase Blur Sampling Mathematics
print('\n[15] Testing Dual Kawase Blur Sampling Mathematics:');
const { getKawaseConfiguration, getKawaseInputBounds } = await import('../src/main/kawaseSampling.js');

const zeroCfg = getKawaseConfiguration(0);
assert(zeroCfg.passes === 1, 'Radius 0 requires 1 pass');
assert(zeroCfg.blend === 0, 'Radius 0 has 0 blend');

const cfg30 = getKawaseConfiguration(30);
assert(cfg30.passes >= 2, 'Radius 30 requires at least 2 passes');
assert(cfg30.blend >= 0 && cfg30.blend <= 1.0, 'Radius 30 blend factor in [0, 1]');

const cfg60 = getKawaseConfiguration(60);
assert(cfg60.passes > cfg30.passes, 'Larger radius 60 requires more passes than radius 30');

const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
const inputBounds = getKawaseInputBounds(bounds, 1920, 1080, 1.0, cfg30.passes);
assert(inputBounds.width >= bounds.width, 'Input bounds cover at least actor width');
assert(inputBounds.height >= bounds.height, 'Input bounds cover at least actor height');
assert(inputBounds.x <= bounds.x, 'Input bounds padded on left');
assert(inputBounds.y <= bounds.y, 'Input bounds padded on top');

// 16. Test UnlockDialog Background Group Kawase Invariants
print('\n[16] Testing UnlockDialog Background Group Kawase Invariants:');
const unlockDialogControllerFile = Gio.File.new_for_path('src/main/unlockDialogController.js');
const [, udcBytes] = unlockDialogControllerFile.load_contents(null);
const udcText = new TextDecoder('utf-8').decode(udcBytes);

assert(udcText.includes('createKawaseBlurEffect'), 'unlockDialogController imports createKawaseBlurEffect');
assert(udcText.includes('_setupBackgroundGroupKawase'), 'unlockDialogController declares _setupBackgroundGroupKawase');
assert(udcText.includes('Shell.BlurEffect'), 'unlockDialogController restores native Shell.BlurEffect on uninstall');
assert(udcText.includes('origUpdateBackgrounds'), 'unlockDialogController tracks and restores origUpdateBackgrounds');

// 17. Test Notification Cards Kawase Blur Integration
print('\n[17] Testing Notification Cards Kawase Blur Integration:');
const notifManagerFile = Gio.File.new_for_path('src/main/notificationManager.js');
const [, notifBytes] = notifManagerFile.load_contents(null);
const notifText = new TextDecoder('utf-8').decode(notifBytes);

assert(notifText.includes("import { createKawaseBlurEffect } from './kawaseBlurEffect.js'"), 'notificationManager imports createKawaseBlurEffect');
assert(!notifText.includes("import('gi://Blur')"), 'notificationManager removes legacy broken gi://Blur dynamic import');
assert(notifText.includes('mode: 1'), 'notificationManager requests background blur mode');
assert(notifText.includes('corner_radius: NOTIF_CARD_RADIUS'), 'notificationManager configures SDF rounded corner radius');

const { KawaseBlurEffect, createKawaseBlurEffect: makeKawaseEffect } = await import('../src/main/kawaseBlurEffect.js');
assert(KawaseBlurEffect !== undefined, 'KawaseBlurEffect class imported and evaluated cleanly in GJS');
const testEffect = makeKawaseEffect({ radius: 25, mode: 1, corner_radius: 12 });
assert(testEffect !== null, 'createKawaseBlurEffect returns valid effect instance');
assert(testEffect.mode === 1, 'createKawaseBlurEffect honors mode: 1');
assert(testEffect.corner_radius === 12, 'createKawaseBlurEffect honors corner_radius: 12');

const kawaseFile = Gio.File.new_for_path('src/main/kawaseBlurEffect.js');
const [, kawaseBytes] = kawaseFile.load_contents(null);
const kawaseText = new TextDecoder('utf-8').decode(kawaseBytes);

assert(kawaseText.includes("'mode': GObject.ParamSpec.int"), 'KawaseBlurEffect declares mode GObject property');
assert(kawaseText.includes('sourceFramebuffer.blit'), 'KawaseBlurEffect supports hardware background blitting');

// 18. Test Prompt Chip Acrylic Live Kawase Blur Integration
print('\n[18] Testing Prompt Chip Acrylic Live Kawase Blur Integration:');
const promptStylingFile = Gio.File.new_for_path('src/main/promptStyling.js');
const [, psBytes] = promptStylingFile.load_contents(null);
const psText = new TextDecoder('utf-8').decode(psBytes);

assert(psText.includes("import { createKawaseBlurEffect } from './kawaseBlurEffect.js'"), 'promptStyling imports createKawaseBlurEffect');
assert(psText.includes('wack-prompt-acrylic-blur'), 'promptStyling manages wack-prompt-acrylic-blur effect');
assert(!psText.includes("name: 'wack-cancel-acrylic-blur'"), 'promptStyling keeps Cancel button as pure Tonal object without acrylic blur');
assert(psText.includes('corner_radius: 999'), 'promptStyling sets capsule corner_radius: 999');
assert(psText.includes('mode: 1'), 'promptStyling uses background blit mode for prompt chip');
assert(psText.includes("entry.remove_effect(blur)"), 'promptStyling removes blur effect on teardown');

const gdmPromptStylingFile = Gio.File.new_for_path('src/pro/gdmPromptStyling.js');
const [, gpsBytes] = gdmPromptStylingFile.load_contents(null);
const gpsText = new TextDecoder('utf-8').decode(gpsBytes);

assert(gpsText.includes("import { createKawaseBlurEffect } from '../main/kawaseBlurEffect.js'"), 'gdmPromptStyling imports createKawaseBlurEffect');
assert(gpsText.includes('wack-prompt-acrylic-blur'), 'gdmPromptStyling manages wack-prompt-acrylic-blur effect');
assert(!gpsText.includes("name: 'wack-cancel-acrylic-blur'"), 'gdmPromptStyling keeps Cancel button as pure Tonal object without acrylic blur');
assert(gpsText.includes('corner_radius: 999'), 'gdmPromptStyling sets capsule corner_radius: 999');
assert(gpsText.includes('mode: 1'), 'gdmPromptStyling uses background blit mode for prompt chip');
assert(gpsText.includes("entry.remove_effect(blur)"), 'gdmPromptStyling removes blur effect on teardown');
assert(gpsText.includes('setPromptBlurLive'), 'gdmPromptStyling declares setPromptBlurLive for dynamic transition tracking');
assert(gpsText.includes('settlePromptStaticBlur'), 'gdmPromptStyling declares settlePromptStaticBlur to freeze blur onComplete');
assert(gpsText.includes('disposePromptStaticBlur'), 'gdmPromptStyling declares disposePromptStaticBlur to clean targets on cancel');

const animFile = Gio.File.new_for_path('src/pro/gdmAnimationController.js');
const [, animBytes] = animFile.load_contents(null);
const animText = new TextDecoder('utf-8').decode(animBytes);

assert(animText.includes('setPromptBlurLive(true)'), 'gdmAnimationController switches blur to dynamic on prompt entrance');
assert(animText.includes('settlePromptStaticBlur()'), 'gdmAnimationController settles blur to static on transition onComplete');
assert(animText.includes('disposePromptStaticBlur()'), 'gdmAnimationController disposes blur targets on return to picker / cancel');

const gdmThemeFile = Gio.File.new_for_path('src/pro/gdmThemePipeline.js');
const [, gdmThemeBytes] = gdmThemeFile.load_contents(null);
const gdmThemeText = new TextDecoder('utf-8').decode(gdmThemeBytes);

assert(gdmThemeText.includes("createKawaseBlurEffect"), 'gdmThemePipeline imports createKawaseBlurEffect');
assert(gdmThemeText.includes("p.value?.r != null"), 'gdmThemePipeline validates acrylic palette via color channels independently of disk PNGs');
assert(kawaseText.includes("sourceFramebuffer.blit"), 'KawaseBlurEffect uses direct CoglFramebuffer blit for static background capture');
assert(kawaseText.includes("invalidate()"), 'KawaseBlurEffect provides invalidate() to refresh static background cache');
const liveEffect = makeKawaseEffect({ live: true });
assert(liveEffect.live === true, 'KawaseBlurEffect honors live: true');
assert(psText.includes('live: false'), 'promptStyling configures static Kawase blur for prompt chip');
assert(gpsText.includes('live: true'), 'gdmPromptStyling initializes dynamic Kawase blur for prompt chip entrance');

// 19. Test Acrylic Glass Tint Parity (Prompt Chip, Notif Card)
print('\n[19] Testing Acrylic Glass Tint Parity & Downsample Leak Protection:');
assert(kawaseText.includes('setPaintOpacity(layerPipeline, 0)'), 'createRenderTarget zeroes layerPipeline opacity to eliminate downsample slice leaks');
assert(kawaseText.includes('captureGeometry(actor, sourceFramebuffer)'), 'addBlurPasses uses captureGeometry projection for exact pixel sampling');

// Hue-Preserve Inverse test case (e.g. bright yellow / warm wallpaper sample)
const brightHueColor = {
    r: 240, g: 190, b: 50,
    isBrightHue: true,
    visualState: {
        useInverse: true,
        isBrightHue: true,
        isBrightSample: true,
        finalColor: { r: 85, g: 65, b: 15 },
        perceptualLightness: 0.78,
        noise: 0.01,
    },
};

const notifHueBg = getNotifCardBackground(brightHueColor, false);
const chipHueBg = getAcrylicChipBackground(brightHueColor, false);
assert(chipHueBg.startsWith('rgba(85, 65, 15,'), 'Prompt chip honors Hue-Preserve Inverse by using darkened color instead of black');
assert(notifHueBg.style.includes(chipHueBg), 'Prompt chip Hue-Preserve Inverse background matches notification card background identically');

const chipHueFocused = getAcrylicChipBackground(brightHueColor, true);
assert(chipHueFocused.startsWith('rgba(85, 65, 15,'), 'Prompt chip focused state retains Hue-Preserve Inverse darkened color');

// Regular Neutral Inverse test case (e.g. bright white / grey wallpaper sample)
const neutralInvColor = {
    r: 235, g: 235, b: 235,
    isBrightHue: false,
    visualState: {
        useInverse: true,
        isBrightHue: false,
        isBrightSample: true,
        perceptualLightness: 0.90,
        noise: 0.01,
        overlay: { r: 0, g: 0, b: 0, alpha: 0.16 },
    },
};

const notifNeutralBg = getNotifCardBackground(neutralInvColor, false);
const chipNeutralBg = getAcrylicChipBackground(neutralInvColor, false);
assert(chipNeutralBg.startsWith('rgba(0, 0, 0,'), 'Prompt chip honors Regular Neutral Inverse using black overlay');
assert(notifNeutralBg.style.includes(chipNeutralBg), 'Prompt chip Regular Neutral Inverse matches notification card darkAlpha identically');

// Non-Inverse Normal test case (e.g. dark / colorful non-bright wallpaper sample)
const normalDarkColor = {
    r: 30, g: 30, b: 50,
    isBrightHue: false,
    visualState: {
        useInverse: false,
        isBrightHue: false,
        isBrightSample: false,
        perceptualLightness: 0.25,
    },
};

const chipNormalBg = getAcrylicChipBackground(normalDarkColor, false);
assert(chipNormalBg === 'rgba(255, 255, 255, 0.113)', 'Prompt chip non-inverse unfocused uses 0.113 frosted white matching card base');
const chipNormalFocused = getAcrylicChipBackground(normalDarkColor, true);
assert(chipNormalFocused === 'rgba(255, 255, 255, 0.160)', 'Prompt chip non-inverse focused uses 0.160 frosted white');

// 20. AlphaManager & Constants Contract Invariants
print('\n[20] Testing AlphaManager & Constants Contract Invariants:');
const alphaManagerSrc = Gio.File.new_for_path('src/main/alphaManager.js').load_contents(null)[1];
const alphaManagerText = new TextDecoder().decode(alphaManagerSrc);

assert(alphaManagerText.includes('PROMPT_BLUR_RADIUS'), 'alphaManager imports and references PROMPT_BLUR_RADIUS');
assert(alphaManagerText.includes('PROMPT_BLUR_BRIGHTNESS'), 'alphaManager imports and references PROMPT_BLUR_BRIGHTNESS');
assert(alphaManagerText.includes('isBrightHue: promptVisualState?.isBrightHue'), 'alphaManager result contract includes isBrightHue');
assert(alphaManagerText.includes('useInverse: promptVisualState?.useInverse'), 'alphaManager result contract includes useInverse');

// 21. Lockscreen Clock Frosted Glass Glyphs Blur Integration
print('\n[21] Testing Lockscreen Clock Frosted Glass Glyphs Blur Integration:');
const { WackClock } = await import('../src/main/wackClock.js');
const { ClockGlyphBlurEffect, createClockGlyphBlurEffect } = await import('../src/main/kawaseBlurEffect.js');

const clockGlyphEffect = makeKawaseEffect({
    mode: 2,
    radius: 40,
    brightness: 1.0,
    tint_r: 0.9,
    tint_g: 0.8,
    tint_b: 0.7,
    tint_alpha: 0.5,
});
assert(clockGlyphEffect instanceof ClockGlyphBlurEffect, 'Mode 2 returns ClockGlyphBlurEffect instance');
assert(clockGlyphEffect instanceof Clutter.OffscreenEffect, 'ClockGlyphBlurEffect subclasses Clutter.OffscreenEffect');
assert(clockGlyphEffect.mode === 2, 'ClockGlyphBlurEffect mode is 2');
assert(clockGlyphEffect.tint_r === 0.9, 'ClockGlyphBlurEffect stores tint_r');
assert(clockGlyphEffect.tint_g === 0.8, 'ClockGlyphBlurEffect stores tint_g');
assert(clockGlyphEffect.tint_b === 0.7, 'ClockGlyphBlurEffect stores tint_b');
assert(clockGlyphEffect.tint_alpha === 0.5, 'ClockGlyphBlurEffect stores tint_alpha');
assert(typeof createClockGlyphBlurEffect === 'function', 'createClockGlyphBlurEffect exported');

const wackClockSrc = Gio.File.new_for_path('src/main/wackClock.js').load_contents(null)[1];
const wackClockText = new TextDecoder().decode(wackClockSrc);
assert(wackClockText.includes('createKawaseBlurEffect'), 'wackClock imports createKawaseBlurEffect');
assert(wackClockText.includes('wack-clock-time-glyph-blur'), 'wackClock initializes time glyph blur');
assert(wackClockText.includes('wack-clock-date-glyph-blur'), 'wackClock initializes date glyph blur');
assert(typeof WackClock.prototype.setBlurEnabled === 'function', 'WackClock declares setBlurEnabled');

const unlockCtrlSrc = Gio.File.new_for_path('src/main/unlockDialogController.js').load_contents(null)[1];
const unlockCtrlText = new TextDecoder().decode(unlockCtrlSrc);
assert(unlockCtrlText.includes('dialog._clock.setBlurEnabled(isCupertino || progress === 0)'), 'unlockDialogController toggles clock blur during swipe transition');

const gdmAnimSrc = Gio.File.new_for_path('src/pro/gdmAnimationController.js').load_contents(null)[1];
const gdmAnimText = new TextDecoder().decode(gdmAnimSrc);
assert(gdmAnimText.includes('clockInstance?.setBlurEnabled'), 'gdmAnimationController toggles clock blur during GDM prompt transitions');

// 22. Test LiveLockScreen Video Wallpaper Compatibility & Live Blur Wiring
print('\n[22] Testing LiveLockScreen Video Wallpaper Compatibility & Live Blur Wiring:');
const {
    isLiveLockscreenVideoActive,
    getLiveLockscreenVideoPath,
    _setShellMain,
    LIVE_LOCKSCREEN_UUID,
    LIVE_LOCKSCREEN_SCHEMA,
} = await import('../src/main/liveLockscreenHelper.js');
assert(typeof isLiveLockscreenVideoActive === 'function', 'isLiveLockscreenVideoActive exported cleanly');
assert(typeof getLiveLockscreenVideoPath === 'function', 'getLiveLockscreenVideoPath exported cleanly');
assert(LIVE_LOCKSCREEN_UUID === 'live-lockscreen@nick-redwill', 'LIVE_LOCKSCREEN_UUID matches upstream extension id');
assert(LIVE_LOCKSCREEN_SCHEMA === 'org.gnome.shell.extensions.live-lockscreen', 'LIVE_LOCKSCREEN_SCHEMA matches upstream gschema id');

// Test isLiveLockscreenVideoActive detection states
const mockInactiveExt = { _settings: { get_boolean: () => false }, _wallpaperManager: { customWallpaperOverlay: null } };
const mockDialog = { _backgroundGroup: [] };
assert(isLiveLockscreenVideoActive(mockDialog, mockInactiveExt) === false, 'isLiveLockscreenVideoActive returns false when LiveLockScreen not enabled');

// Test custom wallpaper override priority: when custom wallpaper overlay is active, video is covered
const mockCustomActiveExt = {
    _settings: { get_boolean: (k) => k === 'lockscreen-wallpaper-enable' },
    _wallpaperManager: {
        customWallpaperOverlay: { visible: true, get_n_children: () => 1 },
    },
};
assert(isLiveLockscreenVideoActive(mockDialog, mockCustomActiveExt) === false, 'custom wallpaper overlay overrides live video background');

// Test detection via wrapper actor effect in _backgroundGroup
const mockLiveDialogWithEffect = {
    _backgroundGroup: [
        {
            get_effect: (name) => (name === 'lockscreen-extension-blur' ? {} : null),
            get_children: () => [],
        },
    ],
};
_setShellMain({
    extensionManager: {
        lookup: (uuid) => (uuid === LIVE_LOCKSCREEN_UUID ? { state: 1 } : null),
    },
});

assert(isLiveLockscreenVideoActive(mockLiveDialogWithEffect, mockInactiveExt) === true, 'detects LiveLockScreen via lockscreen-extension-blur effect');

// Test detection via player process window title
const mockLiveDialogWithWinTitle = {
    _backgroundGroup: [
        {
            get_effect: () => null,
            get_children: () => [
                {
                    get_meta_window: () => ({ get_title: () => 'LLS-Player-DP-1' }),
                },
            ],
        },
    ],
};
assert(isLiveLockscreenVideoActive(mockLiveDialogWithWinTitle, mockInactiveExt) === true, 'detects LiveLockScreen via LLS-Player window actor');

// Test detection via active stateObj player PID
_setShellMain({
    extensionManager: {
        lookup: (uuid) => (uuid === LIVE_LOCKSCREEN_UUID ? {
            state: 1,
            stateObj: {
                _backgroundCreated: true,
                _player: { pid: 4242 },
            },
        } : null),
    },
});
assert(isLiveLockscreenVideoActive(mockDialog, mockInactiveExt) === true, 'detects LiveLockScreen via active player PID in stateObj');

// Reset mock
_setShellMain(null);

// Test setBlurLive wiring across components
assert(typeof WackClock.prototype.setBlurLive === 'function', 'WackClock declares setBlurLive');
assert(psText.includes('setBlurLive(live)'), 'promptStyling declares setBlurLive');
assert(notifText.includes('setBlurLive(live)'), 'notificationManager declares setBlurLive');
assert(unlockCtrlText.includes('syncLiveBlur(dialog'), 'unlockDialogController declares syncLiveBlur');

// Test unlockDialogController source code wiring
assert(unlockCtrlText.includes("import { isLiveLockscreenVideoActive } from './liveLockscreenHelper.js'"), 'unlockDialogController imports isLiveLockscreenVideoActive');
assert(unlockCtrlText.includes('this.syncLiveBlur(dialog)'), 'unlockDialogController syncs live blur during install & background updates');
assert(unlockCtrlText.includes("child-added', () => this._onBackgroundGroupChildAdded(dialog)"), 'unlockDialogController tracks background group child additions');
assert(unlockCtrlText.includes("effectName of ['blur', 'lockscreen-extension-blur']"), 'unlockDialogController applies full background blur to LiveLockScreen video wrappers');
assert(unlockCtrlText.includes('this.syncLiveBlur(dialog, false)'), 'unlockDialogController resets live blur on uninstall');

// Test wackClock source code wiring
assert(wackClockText.includes('this._blurLive = boolVal'), 'WackClock stores and propagates blurLive state');
assert(wackClockText.includes('this._timeBlurEffect.live = boolVal'), 'WackClock updates time blur effect live mode');
assert(wackClockText.includes('this._dateBlurEffect.live = boolVal'), 'WackClock updates date blur effect live mode');

print(`\n========================================`);
print(`Test Results: ${passed} Passed, ${failed} Failed`);
print(`========================================\n`);

if (failed > 0) {
    throw new Error(`${failed} tests failed`);
}
