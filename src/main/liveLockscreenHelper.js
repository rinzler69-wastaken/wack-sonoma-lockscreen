import Gio from 'gi://Gio';

let shellMain = globalThis.Main ?? null;
if (!shellMain) {
    try {
        shellMain = await import('resource:///org/gnome/shell/ui/main.js');
    } catch (_) {}
}

export function _setShellMain(main) {
    shellMain = main;
}

export const LIVE_LOCKSCREEN_UUID = 'live-lockscreen@nick-redwill';
export const LIVE_LOCKSCREEN_SCHEMA = 'org.gnome.shell.extensions.live-lockscreen';

/**
 * Checks whether the LiveLockScreen extension is currently installed and enabled.
 * @returns {boolean}
 */
export function isLiveLockscreenEnabled() {
    const liveExt = shellMain?.extensionManager?.lookup?.(LIVE_LOCKSCREEN_UUID);
    // ExtensionState.ENABLED is 1
    return Boolean(liveExt && liveExt.state === 1);
}

/**
 * Retrieves the configured video path from LiveLockScreen if set.
 * @param {object} [liveExt]
 * @returns {string|null}
 */
export function getLiveLockscreenVideoPath(liveExt = null) {
    try {
        const ext = liveExt ?? shellMain?.extensionManager?.lookup?.(LIVE_LOCKSCREEN_UUID);
        if (ext?.stateObj?._settings)
            return ext.stateObj._settings.get_string('background-video-path') || null;

        const schemaSource = Gio.SettingsSchemaSource.get_default();
        let schema = schemaSource ? schemaSource.lookup(LIVE_LOCKSCREEN_SCHEMA, true) : null;
        if (!schema && ext?.dir) {
            const schemasDir = ext.dir.get_child('schemas');
            if (schemasDir.query_exists(null)) {
                const localSource = Gio.SettingsSchemaSource.new_from_directory(
                    schemasDir.get_path(),
                    schemaSource,
                    false
                );
                schema = localSource.lookup(LIVE_LOCKSCREEN_SCHEMA, true);
            }
        }
        if (schema) {
            const settings = new Gio.Settings({ settings_schema: schema });
            return settings.get_string('background-video-path') || null;
        }
    } catch (_) {}
    return null;
}

/**
 * Detects whether what is actively displayed on the lockscreen is LiveLockScreen's video wallpaper.
 *
 * Requirements for true:
 * 1. LiveLockScreen extension is enabled.
 * 2. Wack lockscreen's custom wallpaper overlay is NOT actively covering the lockscreen.
 * 3. LiveLockScreen has active video playback (player PID / background created) OR its wrapper
 *    actors are present in the unlock dialog background group.
 *
 * @param {object} dialog
 * @param {object} extension
 * @returns {boolean}
 */
export function isLiveLockscreenVideoActive(dialog, extension) {
    // 1. If our custom wallpaper overlay is enabled and actively displaying, it covers the background
    if (extension?._settings?.get_boolean('lockscreen-wallpaper-enable')) {
        const overlay = extension._wallpaperManager?.customWallpaperOverlay;
        if (overlay && overlay.visible && overlay.get_n_children() > 0)
            return false;
    }

    // 2. Check if the LiveLockScreen extension is enabled
    const liveExt = shellMain?.extensionManager?.lookup?.(LIVE_LOCKSCREEN_UUID);
    if (!liveExt || liveExt.state !== 1)
        return false;

    // 3. Check LiveLockScreen stateObj directly if initialized
    if (liveExt.stateObj) {
        if (liveExt.stateObj._player?.pid && liveExt.stateObj._backgroundCreated)
            return true;
    }

    // 4. Check dialog._backgroundGroup for LiveLockScreen wrapper actors or video player windows
    if (dialog?._backgroundGroup) {
        for (const child of dialog._backgroundGroup) {
            if (child.get_effect?.('lockscreen-extension-blur'))
                return true;

            // Check if wrapper contains a player window actor
            if (typeof child.get_children === 'function') {
                for (const inner of child.get_children()) {
                    const metaWin = inner.get_meta_window?.();
                    const title = metaWin?.get_title?.() || '';
                    if (title.startsWith('LLS-Player-'))
                        return true;
                }
            }
        }
    }

    return false;
}
