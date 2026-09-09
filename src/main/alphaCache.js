import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;

const _cache = new Map();
let _loaded = false;
let _loadPromise = null;

export function initCache() {
    if (_loadPromise)
        return _loadPromise;

    _loadPromise = new Promise((resolve) => {
        if (_loaded) {
            resolve();
            return;
        }
        _loaded = true;

        const file = Gio.File.new_for_path(CACHE_FILE);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [success, contents] = file.load_contents_finish(res);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data && data.__version__ === 'v10') {
                        for (const [k, v] of Object.entries(data)) {
                            if (k !== '__version__')
                                _cache.set(k, v);
                        }
                    } else {
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                }
            } catch (e) {
                // File does not exist or JSON parsing failed; ignore.
            }
            resolve();
        });
    });

    return _loadPromise;
}

export function saveCache() {
    try {
        const obj = { __version__: 'v10' };
        for (const [k, v] of _cache.entries())
            obj[k] = v;
        const data = JSON.stringify(obj);
        const file = Gio.File.new_for_path(CACHE_FILE);
        const bytes = new TextEncoder().encode(data);
        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null,
            (obj2, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.error(`[WACK/AlphaCache] Failed to save persistent cache: ${e}`);
                }
            }
        );
    } catch (e) {
        console.error(`[WACK/AlphaCache] Failed to save persistent cache: ${e}`);
    }
}

export function clearCache() {
    _cache.clear();
    _loaded = false;
    _loadPromise = null;
}

export function getCache(key) {
    return _cache.get(key);
}

export function setCache(key, value) {
    _cache.set(key, value);
}

export function hasCache(key) {
    return _cache.has(key);
}
