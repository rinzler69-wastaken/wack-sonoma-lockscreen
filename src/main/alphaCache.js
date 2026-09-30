import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { PROMPT_VISUAL_ALGORITHM_VERSION } from './colorUtils.js';

export const CACHE_SCHEMA_VERSION = 1;
export const MAX_CACHE_ENTRIES = 64;

const userName = GLib.get_user_name();
const CACHE_DIR = '/var/tmp/wack/cache';
const CACHE_FILE = `${CACHE_DIR}/wack-wallpaper-alpha-cache-${userName}.json`;
const LEGACY_CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;

export const CacheMetrics = {
    l1Hits: 0,
    l1Misses: 0,
    diskHits: 0,
    diskMisses: 0,
    diskWrites: 0,
    evictions: 0,
    invalidations: 0,
    coalescedRequests: 0,
    reset() {
        this.l1Hits = 0;
        this.l1Misses = 0;
        this.diskHits = 0;
        this.diskMisses = 0;
        this.diskWrites = 0;
        this.evictions = 0;
        this.invalidations = 0;
        this.coalescedRequests = 0;
    },
};

export function ensureCacheDirectory(path = CACHE_DIR) {
    for (const p of ['/var/tmp/wack', path]) {
        try {
            const dir = Gio.File.new_for_path(p);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
                dir.set_attribute_uint32('unix::mode', 0o1777, Gio.FileQueryInfoFlags.NONE, null);
            }
        } catch (_) {}
    }
}

const _cache = new Map();
let _state = 'UNINITIALIZED'; // 'UNINITIALIZED' | 'LOADING' | 'READY'
let _generation = 0;
let _loadPromise = null;
let _saving = false;
let _saveRequested = false;
let _dirty = false;
let _saveScheduled = false;

function _isValidRgb(c) {
    return (
        c !== null &&
        typeof c === 'object' &&
        !Array.isArray(c) &&
        Number.isInteger(c.r) && c.r >= 0 && c.r <= 255 &&
        Number.isInteger(c.g) && c.g >= 0 && c.g <= 255 &&
        Number.isInteger(c.b) && c.b >= 0 && c.b <= 255
    );
}

function _validateCacheEntry(key, value) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4096)
        return false;

    // Scalar alpha value (0.0 to 1.0)
    if (typeof value === 'number')
        return Number.isFinite(value) && value >= 0.0 && value <= 1.0;

    // Visual result object
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if (!_isValidRgb(value))
            return false;
        if (value.start && !_isValidRgb(value.start))
            return false;
        if (value.end && !_isValidRgb(value.end))
            return false;
        if (value.cancelColor && !_isValidRgb(value.cancelColor))
            return false;
        if (value.avatarColor && !_isValidRgb(value.avatarColor))
            return false;
        if (value.a11yColor && !_isValidRgb(value.a11yColor))
            return false;
        if (value.sessionColor && !_isValidRgb(value.sessionColor))
            return false;
        if (typeof value.useInverse !== 'boolean')
            return false;
        if (typeof value.shadowAlpha !== 'number' || !Number.isFinite(value.shadowAlpha))
            return false;
        return true;
    }

    return false;
}

export function initCache() {
    if (_state === 'READY')
        return Promise.resolve();

    if (_loadPromise)
        return _loadPromise;

    _state = 'LOADING';
    const currentGen = _generation;

    _loadPromise = new Promise((resolve) => {
        let file = Gio.File.new_for_path(CACHE_FILE);
        if (!file.query_exists(null)) {
            const legacyFile = Gio.File.new_for_path(LEGACY_CACHE_FILE);
            if (legacyFile.query_exists(null)) {
                file = legacyFile;
            }
        }
        file.load_contents_async(null, (obj, res) => {
            try {
                if (_generation !== currentGen) {
                    resolve();
                    return;
                }

                const [success, contents] = file.load_contents_finish(res);
                if (success && contents) {
                    const decoded = new TextDecoder().decode(contents);
                    const data = JSON.parse(decoded);

                    if (
                        data &&
                        typeof data === 'object' &&
                        !Array.isArray(data) &&
                        data.__schema__ === CACHE_SCHEMA_VERSION &&
                        data.__visual_version__ === PROMPT_VISUAL_ALGORITHM_VERSION &&
                        data.entries &&
                        typeof data.entries === 'object' &&
                        !Array.isArray(data.entries)
                    ) {
                        for (const [k, v] of Object.entries(data.entries)) {
                            // In-memory entries created while loading are authoritative
                            if (!_cache.has(k) && _validateCacheEntry(k, v)) {
                                if (_cache.size >= MAX_CACHE_ENTRIES) {
                                    const oldest = _cache.keys().next().value;
                                    if (oldest !== undefined) {
                                        _cache.delete(oldest);
                                        CacheMetrics.evictions++;
                                    }
                                }
                                _cache.set(k, v);
                                CacheMetrics.diskHits++;
                            }
                        }
                    } else {
                        // Incompatible format or algorithm version mismatch: discard stale file
                        CacheMetrics.invalidations++;
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                } else {
                    CacheMetrics.diskMisses++;
                }
            } catch (e) {
                // File missing, read error, or malformed JSON: safely reset
                CacheMetrics.diskMisses++;
                try {
                    file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                } catch (_) {}
            } finally {
                if (_generation === currentGen)
                    _state = 'READY';
                _loadPromise = null;
                resolve();
            }
        });
    });

    return _loadPromise;
}

function _flushSave() {
    _saveScheduled = false;

    if (_saving) {
        _saveRequested = true;
        return;
    }

    if (!_dirty)
        return;

    _saving = true;
    _dirty = false;
    _saveRequested = false;

    const currentGen = _generation;
    const entriesObj = Object.fromEntries(_cache);
    const envelope = {
        __schema__: CACHE_SCHEMA_VERSION,
        __visual_version__: PROMPT_VISUAL_ALGORITHM_VERSION,
        entries: entriesObj,
    };

    let encoded;
    try {
        encoded = new TextEncoder().encode(JSON.stringify(envelope));
    } catch (e) {
        _saving = false;
        return;
    }

    ensureCacheDirectory();
    const file = Gio.File.new_for_path(CACHE_FILE);
    file.replace_contents_async(
        encoded,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (obj, res) => {
            try {
                file.replace_contents_finish(res);
                CacheMetrics.diskWrites++;
                try {
                    file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
                } catch (_) {}
                // Clean up legacy cache file if it exists
                try {
                    const legacyFile = Gio.File.new_for_path(LEGACY_CACHE_FILE);
                    if (legacyFile.query_exists(null))
                        legacyFile.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                } catch (_) {}
            } catch (e) {
                // Non-fatal persistence error
            } finally {
                _saving = false;
                if (_generation === currentGen && (_saveRequested || _dirty)) {
                    _flushSave();
                }
            }
        }
    );
}

export function saveCache() {
    _dirty = true;
    if (!_saveScheduled) {
        _saveScheduled = true;
        Promise.resolve().then(() => {
            if (_saveScheduled)
                _flushSave();
        });
    }
}

export function clearCache() {
    _generation++;
    _state = 'UNINITIALIZED';
    _loadPromise = null;
    _cache.clear();
    _dirty = false;
    _saveRequested = false;
    _saveScheduled = false;
}

export function getCache(key) {
    if (typeof key !== 'string')
        return undefined;

    const val = _cache.get(key);
    if (val !== undefined) {
        // Refresh LRU order on access
        _cache.delete(key);
        _cache.set(key, val);
        CacheMetrics.l1Hits++;
    } else {
        CacheMetrics.l1Misses++;
    }
    return val;
}

export function setCache(key, value) {
    if (!_validateCacheEntry(key, value))
        return false;

    if (_cache.has(key)) {
        _cache.delete(key);
    } else if (_cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined) {
            _cache.delete(oldest);
            CacheMetrics.evictions++;
        }
    }

    _cache.set(key, value);
    saveCache();
    return true;
}

export function hasCache(key) {
    if (typeof key !== 'string')
        return false;
    return _cache.has(key);
}

/**
 * Asynchronously prunes old vibrancy slice PNGs and unused dynamic slideshow directories
 * in the background so the critical UI rendering path is never blocked.
 *
 * Implements the presentation-package ownership model: a vibrancy PNG is eligible
 * for deletion only when it is no longer referenced by any currently-published
 * Light/Dark presentation variant in the cross-session manifest.
 *
 * @param {string} targetDir Destination directory of the newly created slice
 * @param {string} justGeneratedHash Hash of the slice just written — always preserved.
 * @param {number} [maxDynamicDirs=4] Maximum number of dynamic slideshow directories to retain
 */
export function scheduleVibrancyPruning(targetDir, justGeneratedHash, maxDynamicDirs = 4) {
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        (async () => {
            try {
                const currentUserName = GLib.get_user_name();
                const BASE_VIBRANCY_DIR = '/var/tmp/wack/vibrancy';
                const SHARED_DIR = '/var/tmp/wack/shared';

                // Build the set of hashes that must be preserved.
                // Seed with the hash just generated by the caller.
                const keepHashes = new Set([justGeneratedHash]);

                // Read the published cross-session manifest for this user and harvest
                // every promptColor.imagePath referenced by any variant (light, dark,
                // or root).  Those paths own their PNG artifacts for as long as they
                // appear in the manifest.
                const manifestPath = `${SHARED_DIR}/wack-shared-wallpaper-${currentUserName}.json`;
                const manifestFile = Gio.File.new_for_path(manifestPath);
                if (manifestFile.query_exists(null)) {
                    try {
                        const [ok, bytes] = await manifestFile.load_contents_async(null);
                        if (ok && bytes) {
                            const manifest = JSON.parse(new TextDecoder().decode(bytes));
                            // Collect imagePaths from every variant slot that may carry one.
                            const slots = [
                                manifest?.promptColor,
                                manifest?.variants?.light?.promptColor,
                                manifest?.variants?.dark?.promptColor,
                            ];
                            for (const pc of slots) {
                                if (pc?.imagePath) {
                                    // fileName format: wack-prompt-blur-<user>-<hash>.png
                                    const fileName = pc.imagePath.substring(pc.imagePath.lastIndexOf('/') + 1);
                                    const withoutExt = fileName.endsWith('.png') ? fileName.slice(0, -4) : fileName;
                                    const lastDash = withoutExt.lastIndexOf('-');
                                    if (lastDash >= 0)
                                        keepHashes.add(withoutExt.slice(lastDash + 1));
                                }
                            }
                        }
                    } catch (_) {
                        // Manifest unreadable or malformed — only the just-generated hash is protected.
                    }
                }

            // 1. Clean older slice PNGs in targetDir for this user,
            //    keeping any file whose hash suffix is in keepHashes.
            if (targetDir) {
                const tDir = Gio.File.new_for_path(targetDir);
                if (tDir.query_exists(null)) {
                    const enumerator = tDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    const toDelete = [];
                    let fileInfo;
                    while ((fileInfo = enumerator.next_file(null)) !== null) {
                        const fileName = fileInfo.get_name();
                        if (!fileName.startsWith(`wack-prompt-blur-${currentUserName}-`))
                            continue;
                        // Extract the hash portion between the last '-' and '.png'.
                        const withoutExt = fileName.endsWith('.png') ? fileName.slice(0, -4) : fileName;
                        const lastDash = withoutExt.lastIndexOf('-');
                        const fileHash = lastDash >= 0 ? withoutExt.slice(lastDash + 1) : '';
                        if (!keepHashes.has(fileHash))
                            toDelete.push(`${targetDir}/${fileName}`);
                    }
                    enumerator.close(null);
                    for (const path of toDelete) {
                        try {
                            Gio.File.new_for_path(path).delete(null);
                        } catch (_) {}
                    }
                }
            }

            // 2. Clean stray root files in BASE_VIBRANCY_DIR and prune older dynamic slideshow folders
            const baseDir = Gio.File.new_for_path(BASE_VIBRANCY_DIR);
            if (baseDir.query_exists(null)) {
                const enumerator = baseDir.enumerate_children('standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
                const dynamicDirs = [];
                const strayFiles = [];
                let fileInfo;
                while ((fileInfo = enumerator.next_file(null)) !== null) {
                    const name = fileInfo.get_name();
                    const fType = fileInfo.get_file_type();
                    if (fType === Gio.FileType.DIRECTORY) {
                        if (name !== 'general') {
                            dynamicDirs.push({
                                path: `${BASE_VIBRANCY_DIR}/${name}`,
                                mtime: fileInfo.get_attribute_uint64('time::modified') || 0,
                            });
                        }
                    } else {
                        strayFiles.push(`${BASE_VIBRANCY_DIR}/${name}`);
                    }
                }
                enumerator.close(null);

                for (const path of strayFiles) {
                    try {
                        Gio.File.new_for_path(path).delete(null);
                    } catch (_) {}
                }

                if (dynamicDirs.length > maxDynamicDirs) {
                    dynamicDirs.sort((a, b) => b.mtime - a.mtime);
                    const toPrune = dynamicDirs.slice(maxDynamicDirs);
                    for (const item of toPrune) {
                        if (item.path !== targetDir) {
                            try {
                                const pDir = Gio.File.new_for_path(item.path);
                                const pEnum = pDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                                let pInfo;
                                while ((pInfo = pEnum.next_file(null)) !== null) {
                                    try {
                                        pDir.get_child(pInfo.get_name()).delete(null);
                                    } catch (_) {}
                                }
                                pEnum.close(null);
                                pDir.delete(null);
                            } catch (_) {}
                        }
                    }
                }
            }

            // 3. Clean legacy slice PNGs in /var/tmp
            const legacyTmpDir = Gio.File.new_for_path('/var/tmp');
            if (legacyTmpDir.query_exists(null)) {
                const enumerator = legacyTmpDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                const toDelete = [];
                let fileInfo;
                while ((fileInfo = enumerator.next_file(null)) !== null) {
                    const fileName = fileInfo.get_name();
                    if (fileName.startsWith('wack-a11y-blur-') || fileName.startsWith('wack-session-blur-') ||
                        fileName.startsWith('wack-cancel-blur-') || fileName.startsWith('wack-prompt-blur-')) {
                        toDelete.push(`/var/tmp/${fileName}`);
                    }
                }
                enumerator.close(null);
                for (const path of toDelete) {
                    try {
                        Gio.File.new_for_path(path).delete(null);
                    } catch (_) {}
                }
            }
        } catch (_) {}
    })();
    return GLib.SOURCE_REMOVE;
});
}


/**
 * Authoritative system-wide cache flusher. Clears in-memory cache and
 * removes all cached value JSONs, vibrancy slices, shared wallpapers, and legacy files.
 */
export function flushAllCache() {
    clearCache();

    // 1. Clean cache directory
    const cacheDir = Gio.File.new_for_path(CACHE_DIR);
    if (cacheDir.query_exists(null)) {
        try {
            const enumerator = cacheDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    cacheDir.get_child(info.get_name()).delete(null);
                } catch (_) {}
            }
            enumerator.close(null);
        } catch (_) {}
    }

    // 2. Clean vibrancy directory (preserve 'general' folder)
    const baseVibrancy = Gio.File.new_for_path('/var/tmp/wack/vibrancy');
    if (baseVibrancy.query_exists(null)) {
        try {
            const enumerator = baseVibrancy.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const child = baseVibrancy.get_child(info.get_name());
                if (info.get_name() === 'general') {
                    try {
                        const genEnum = child.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                        let gInfo;
                        while ((gInfo = genEnum.next_file(null)) !== null) {
                            try {
                                child.get_child(gInfo.get_name()).delete(null);
                            } catch (_) {}
                        }
                        genEnum.close(null);
                    } catch (_) {}
                } else if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    try {
                        const subEnum = child.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                        let sInfo;
                        while ((sInfo = subEnum.next_file(null)) !== null) {
                            try {
                                child.get_child(sInfo.get_name()).delete(null);
                            } catch (_) {}
                        }
                        subEnum.close(null);
                        child.delete(null);
                    } catch (_) {}
                } else {
                    try {
                        child.delete(null);
                    } catch (_) {}
                }
            }
            enumerator.close(null);
        } catch (_) {}
    }

    // 3. Clean shared directory
    const sharedDir = Gio.File.new_for_path('/var/tmp/wack/shared');
    if (sharedDir.query_exists(null)) {
        try {
            const enumerator = sharedDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    sharedDir.get_child(info.get_name()).delete(null);
                } catch (_) {}
            }
            enumerator.close(null);
        } catch (_) {}
    }

    // 4. Clean legacy files in /var/tmp
    const tmpDir = Gio.File.new_for_path('/var/tmp');
    if (tmpDir.query_exists(null)) {
        try {
            const enumerator = tmpDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('wack-wallpaper-alpha-cache-') || name.startsWith('wack-prompt-blur-') ||
                    name.startsWith('wack-a11y-blur-') || name.startsWith('wack-session-blur-') || name.startsWith('wack-cancel-blur-')) {
                    try {
                        tmpDir.get_child(name).delete(null);
                    } catch (_) {}
                }
            }
            enumerator.close(null);
        } catch (_) {}
    }

    // 5. Re-ensure base directories and general directory exist with 0o1777 permissions
    for (const p of ['/var/tmp/wack', CACHE_DIR, '/var/tmp/wack/shared', '/var/tmp/wack/vibrancy', '/var/tmp/wack/vibrancy/general']) {
        try {
            const dir = Gio.File.new_for_path(p);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
                dir.set_attribute_uint32('unix::mode', 0o1777, Gio.FileQueryInfoFlags.NONE, null);
            }
        } catch (_) {}
    }
}
