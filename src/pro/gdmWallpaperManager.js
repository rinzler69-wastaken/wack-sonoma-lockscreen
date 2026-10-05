import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
} from '../main/constants.js';
import { _log, GDM_CROSSFADE_DURATION } from './gdmUtils.js';
import { GdmThemeStore, GdmWallpaperView } from './gdmThemePipeline.js';

export class GdmWallpaperManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.view = null;
        this.themeStore = null;
        this.monitorsChangedId = null;
        this.sharedWallpaperMonitor = null;
        this.sharedWallpaperRefreshId = null;
        this.currentWallpaperMetadata = null;
    }

    setup(dialog, dialogParent) {
        this.view = new GdmWallpaperView(dialogParent, dialog);
        this.view.rebuild();

        this.themeStore = new GdmThemeStore(this._gdm._extension, (userName) => {
            const activeUser = this._gdm._dialog?._user?.get_user_name() ?? null;
            const effectiveUser = activeUser ?? this.themeStore._defaultUser;
            if (userName === null || userName === effectiveUser || (activeUser === null && userName === this.themeStore._defaultUser)) {
                this.applyWallpaper(activeUser, true);
            }
        });

        this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.view)
                this.view.rebuild();
            this._gdm._syncLockscreenMessageLayout();
            this._gdm._positionAuthPrompt();
            this._gdm._positionUserList();
        });

        this.setupSharedWallpaperMonitor();

        if (this.view && this.themeStore) {
            for (const theme of this.themeStore._themes.values()) {
                this.view.warm(theme);
            }
            const activeUser = this._gdm._dialog?._user?.get_user_name() ?? null;
            this.applyWallpaper(activeUser, false);
        }
    }

    teardown() {
        if (this.monitorsChangedId) {
            Main.layoutManager.disconnect(this.monitorsChangedId);
            this.monitorsChangedId = null;
        }

        if (this.sharedWallpaperRefreshId) {
            GLib.source_remove(this.sharedWallpaperRefreshId);
            this.sharedWallpaperRefreshId = null;
        }

        if (this.sharedWallpaperMonitor) {
            this.sharedWallpaperMonitor.disconnectObject(this);
            this.sharedWallpaperMonitor = null;
        }

        if (this.themeStore) {
            this.themeStore.destroy();
            this.themeStore = null;
        }

        if (this.view) {
            this.view.destroy();
            this.view = null;
        }

        this.currentWallpaperMetadata = null;
    }

    setupSharedWallpaperMonitor() {
        if (this.sharedWallpaperMonitor)
            return;

        const SHARED_DIR = '/var/tmp/wack/shared';
        for (const dPath of ['/var/tmp/wack', SHARED_DIR]) {
            const d = Gio.File.new_for_path(dPath);
            if (!d.query_exists(null)) {
                d.make_directory_with_parents(null);
                d.set_attribute_uint32('unix::mode', 0o1777, Gio.FileQueryInfoFlags.NONE, null);
            }
        }

        const dir = Gio.File.new_for_path(SHARED_DIR);
        if (dir.query_exists(null)) {
            this.sharedWallpaperMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );

            this.sharedWallpaperMonitor.connectObject('changed', (_monitor, file, _otherFile, eventType) => {
                const name = file?.get_basename() ?? '';
                if (!name.startsWith('wack-shared-wallpaper-') || !name.endsWith('.json'))
                    return;

                if (eventType !== Gio.FileMonitorEvent.CHANGED &&
                    eventType !== Gio.FileMonitorEvent.CREATED &&
                    eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType !== Gio.FileMonitorEvent.MOVED_IN) {
                    return;
                }

                const rawName = name.replace('wack-shared-wallpaper-', '').replace('.json', '');
                if (rawName === 'gdm')
                    return;

                if (this.sharedWallpaperRefreshId)
                    GLib.source_remove(this.sharedWallpaperRefreshId);

                this.sharedWallpaperRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this.sharedWallpaperRefreshId = null;
                    if (this.themeStore)
                        this.themeStore.loadUser(rawName).catch(() => {});
                    return GLib.SOURCE_REMOVE;
                });
                GLib.Source.set_name_by_id(this.sharedWallpaperRefreshId, '[WACK] GdmWallpaperManager.sharedWallpaperRefresh');
            }, this);
        }
    }

    applyWallpaper(requestedUserName = null, animate = true, isExplicitSelection = false) {
        if (!this.themeStore || !this.view)
            return;

        // On an explicit account switch (or cancel back to the user list), restore
        // the canonical color scheme of the target user.  For a named user this is
        // the account's stored last-known scheme.  For null (cancel/reset), the entry
        // state owner is the default user — the last-active session that launched GDM.
        // This wipes any ephemeral QS-toggle or per-account scheme write that occurred
        // during navigation, ensuring every cancel atomically restores the entry state.
        if (isExplicitSelection) {
            const schemeOwner = requestedUserName ?? this.themeStore._defaultUser ?? null;
            const rawMeta = schemeOwner !== null
                ? (this.themeStore._themes.get(schemeOwner)?.rawMeta ?? null)
                : null;
            const canonicalScheme = rawMeta?.color_scheme ?? null;
            if (canonicalScheme !== null) {
                const globalScheme = this.themeStore._getColorScheme();
                if (canonicalScheme !== globalScheme)
                    this.themeStore._interfaceSettings.set_enum('color-scheme', canonicalScheme);
                // _onColorSchemeChanged fires -> re-installs themes under canonical scheme
                // -> _onChanged -> applyWallpaper with isExplicitSelection=false -> no
                // further write.  We continue below so presentation is immediate.
            }
        }

        const theme = this.themeStore.peek(requestedUserName);
        if (!theme)
            return;

        this._gdm._currentWallpaperMetadata = theme.meta;
        this.currentWallpaperMetadata = theme.meta;

        // Fast in-memory property updates (no disk I/O, no blocking on main thread)
        this.view.present(theme, animate);

        // Apply prompt styling synchronously
        this._gdm._promptStyling.applyTheme(theme);

        // Update clock alpha and presentation settings
        if (this._gdm._clockManager) {
            if (theme.clockAlpha !== null)
                this._gdm._clockManager.setWallpaperAlpha(theme.clockAlpha, theme.palette ? theme.palette.value : null);
            if (this._gdm._clockManager.clock && theme.meta) {
                if (theme.meta.clockFormat !== undefined)
                    this._gdm._clockManager.clock.setClockFormat(theme.meta.clockFormat);
                if (theme.meta.dateStyle !== undefined)
                    this._gdm._clockManager.clock.setDateStyle(theme.meta.dateStyle);
                if (theme.meta.userLocale !== undefined)
                    this._gdm._clockManager.clock.setLocale(theme.meta.userLocale);
            }
        }

        // Update lockscreen message
        this._gdm._updateLockscreenMessage(theme.meta);
    }

    setPromptBackgroundBlur(active, animate = true) {
        if (!this.view)
            return;

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = active ? PROMPT_BLUR_RADIUS * scaleFactor : 0;
        const brightness = active ? PROMPT_BLUR_BRIGHTNESS : 1.0;
        this.view.setPromptBlur(radius, brightness, animate, GDM_CROSSFADE_DURATION);
    }

    saveGdmWallpaperMetadata(metadata) {
        if (!metadata || metadata.username !== 'gdm')
            return;

        try {
            const SHARED_DIR = '/var/tmp/wack/shared';
            for (const dPath of ['/var/tmp/wack', SHARED_DIR]) {
                const d = Gio.File.new_for_path(dPath);
                if (!d.query_exists(null)) {
                    d.make_directory_with_parents(null);
                    d.set_attribute_uint32('unix::mode', 0o1777, Gio.FileQueryInfoFlags.NONE, null);
                }
            }
            const metaFile = Gio.File.new_for_path(`${SHARED_DIR}/wack-shared-wallpaper-gdm.json`);
            metaFile.replace_contents(
                JSON.stringify(metadata),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            metaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            _log('[WACK/GdmWallpaperManager] Failed to save GDM wallpaper metadata: ' + e);
        }
    }
}
