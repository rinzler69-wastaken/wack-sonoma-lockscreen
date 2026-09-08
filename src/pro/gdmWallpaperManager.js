import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperAlpha } from '../main/alphaManager.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
} from '../main/constants.js';
import { _log, GDM_CROSSFADE_DURATION } from './gdmUtils.js';

export class GdmWallpaperManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.backgroundGroup = null;
        this.bgManagers = [];
        this.monitorsChangedId = null;
        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.currentWallpaperMetadata = null;
        this.sharedWallpaperMonitor = null;
        this.sharedWallpaperRefreshId = null;
    }

    setup(dialog, dialogParent) {
        this.backgroundGroup = new Clutter.Actor();
        dialogParent.add_child(this.backgroundGroup);
        dialogParent.set_child_below_sibling(this.backgroundGroup, dialog);

        this.bgManagers = [];
        this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this.updateBackgrounds();
            this._gdm._syncLockscreenMessageLayout();
            this._gdm._positionAuthPrompt();
            this._gdm._positionUserList();
        });

        this.updateBackgrounds();
        this.setupSharedWallpaperMonitor();
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

        for (let i = 0; i < this.bgManagers.length; i++) {
            this.bgManagers[i]._bms_pipeline?.destroy();
            this.bgManagers[i].destroy();
        }
        this.bgManagers = [];

        if (this.backgroundGroup) {
            this.backgroundGroup.destroy();
            this.backgroundGroup = null;
        }

        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.currentWallpaperMetadata = null;
    }

    createBackground(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex];

        const createWidget = () => new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({ name: 'blur' }),
        });

        const widgetA = createWidget();
        const widgetB = createWidget();

        widgetA.opacity = 0;
        widgetB.opacity = 0;

        this.backgroundGroup.add_child(widgetA);
        this.backgroundGroup.add_child(widgetB);

        this.bgManagers.push({
            widgetA,
            widgetB,
            activeIsA: true,
            destroy() {
                widgetA.destroy();
                widgetB.destroy();
            }
        });
    }

    updateBackgroundEffects() {
        if (!this.backgroundGroup) return;
        for (const widget of this.backgroundGroup.get_children()) {
            const effect = widget.get_effect('blur');
            if (effect) {
                effect.set({
                    brightness: 1.0,
                    radius: 0,
                });
            }
        }
    }

    setPromptBackgroundBlur(active, animate = true) {
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = active ? PROMPT_BLUR_RADIUS * scaleFactor : 0;
        const brightness = active ? PROMPT_BLUR_BRIGHTNESS : 1.0;

        for (const widget of this.backgroundGroup?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            if (!effect)
                continue;

            effect.set_enabled(true);
            widget.remove_transition('@effects.blur.radius');
            widget.remove_transition('@effects.blur.brightness');
            if (animate) {
                widget.ease_property('@effects.blur.radius', radius, {
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                widget.ease_property('@effects.blur.brightness', brightness, {
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                effect.set({ radius, brightness });
            }
        }
    }

    updateBackgrounds() {
        if (!this.backgroundGroup) return;

        for (let i = 0; i < this.bgManagers.length; i++) {
            this.bgManagers[i]._bms_pipeline?.destroy();
            this.bgManagers[i].destroy();
        }

        this.bgManagers = [];
        this.backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this.createBackground(i);

        this.updateBackgroundEffects();
        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.applyWallpaper();
    }

    setupSharedWallpaperMonitor() {
        if (this.sharedWallpaperMonitor)
            return;

        try {
            const dir = Gio.File.new_for_path('/var/tmp');
            this.sharedWallpaperMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );

            this.sharedWallpaperMonitor.connectObject('changed', (_monitor, file, _otherFile, eventType) => {
                const path = file?.get_path?.() ?? '';
                const name = file?.get_basename?.() ?? '';
                const isRelevant = name.startsWith('wack-shared-wallpaper-') && name.endsWith('.json');
                if (!isRelevant)
                    return;

                if (eventType !== Gio.FileMonitorEvent.CHANGED &&
                    eventType !== Gio.FileMonitorEvent.CREATED &&
                    eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType !== Gio.FileMonitorEvent.MOVED_IN) {
                    return;
                }

                _log(`[WACK/GdmManager] Shared wallpaper metadata changed: ${path}`);
                this.queueSharedWallpaperRefresh();
            }, this);
        } catch (e) {
            _log('[WACK/GdmManager] Failed to monitor shared wallpaper metadata: ' + e);
        }
    }

    queueSharedWallpaperRefresh() {
        if (this.sharedWallpaperRefreshId)
            GLib.source_remove(this.sharedWallpaperRefreshId);

        this.sharedWallpaperRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this.sharedWallpaperRefreshId = null;

            const activeUserName = this._gdm._dialog?._user?.get_user_name?.() ?? null;
            this.applyWallpaper(activeUserName);
            return GLib.SOURCE_REMOVE;
        });
    }

    buildWallpaperSignature(resolvedUserName, metadata) {
        return JSON.stringify({
            username: resolvedUserName ?? null,
            source_uri: metadata?.source_uri ?? null,
            resolved_slide_path: metadata?.resolved_slide_path ?? null,
            uri: metadata?.uri ?? null,
            style: metadata?.style ?? null,
            primary_color: metadata?.primary_color ?? null,
            secondary_color: metadata?.secondary_color ?? null,
            shading_type: metadata?.shading_type ?? null,
            is_color: metadata?.is_color ?? null,
            clockAlpha: metadata?.clockAlpha ?? null,
            promptColor: metadata?.promptColor ?? null,
            cursorBlink: metadata?.cursorBlink ?? null,
            lockscreenMode: metadata?.lockscreenMode ?? null,
            lockscreenMessageEnable: metadata?.lockscreenMessageEnable ?? null,
            lockscreenMessageText: metadata?.lockscreenMessageText ?? null,
        });
    }

    applyWallpaper(requestedUserName = null) {
        try {
            if (!this.backgroundGroup) {
                this.backgroundGroup = new Clutter.Actor();
                this._gdm._dialogParent.add_child(this.backgroundGroup);
                this._gdm._dialogParent.set_child_below_sibling(this.backgroundGroup, this._gdm._dialog);
                this.bgManagers = [];
            }

            if (!this.bgManagers || this.bgManagers.length === 0) {
                for (let i = 0; i < Main.layoutManager.monitors.length; i++)
                    this.createBackground(i);
                this.updateBackgroundEffects();
                this.appliedWallpaperUser = undefined;
            }

            let resolvedUserName = requestedUserName;
            let metaFile = null;

            if (!resolvedUserName) {
                try {
                    const dir = Gio.File.new_for_path('/var/tmp');
                    if (dir.query_exists(null)) {
                        const enumerator = dir.enumerate_children(
                            'standard::name,time::modified',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );
                        let maxMtime = 0;
                        let info;
                        while ((info = enumerator.next_file(null)) !== null) {
                            const name = info.get_name();
                            if (name.startsWith('wack-shared-wallpaper-') && name.endsWith('.json')) {
                                const mtime = info.get_attribute_uint64('time::modified');
                                if (mtime > maxMtime) {
                                    maxMtime = mtime;
                                    metaFile = Gio.File.new_for_path(`/var/tmp/${name}`);
                                }
                            }
                        }
                    }
                } catch (err) {
                    _log('[WACK/GdmManager] Failed to find most recent user wallpaper: ' + err);
                }
            } else {
                metaFile = Gio.File.new_for_path(`/var/tmp/wack-shared-wallpaper-${resolvedUserName}.json`);
            }

            let metadata = null;
            if (metaFile && metaFile.query_exists(null)) {
                const [loadSuccess, contents] = metaFile.load_contents(null);
                if (loadSuccess) {
                    metadata = JSON.parse(new TextDecoder().decode(contents));
                }
                if (!resolvedUserName && metadata) {
                    resolvedUserName = metadata.username;
                }
            }
            this.currentWallpaperMetadata = metadata;
            this._gdm._currentWallpaperMetadata = metadata;
            this._gdm._updateLockscreenMessage(metadata);
            const wallpaperSignature = this.buildWallpaperSignature(resolvedUserName, metadata);

            _log(`[WACK/GdmManager] _applyWallpaper resolved user: ${resolvedUserName}`);

            const clock = this._gdm._clockManager?.clock ?? this._gdm._gdmClock;
            if (clock)
                clock.setClockFormat(metadata?.clockFormat ?? null);

            let alphaPromise;
            if (metadata) {
                if (metadata.clockAlpha != null) {
                    alphaPromise = Promise.resolve(metadata.clockAlpha);
                } else {
                    alphaPromise = getWallpaperAlpha({
                        uri: metadata.uri,
                        isColor: metadata.is_color,
                        primaryColor: metadata.primary_color,
                        secondaryColor: metadata.secondary_color,
                        shadingType: metadata.shading_type,
                        textLuminance: 1.0,
                    });
                }
            } else {
                const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                const uri = bgSettings.get_string('picture-uri');
                const style = bgSettings.get_enum('picture-options');
                const primaryColor = bgSettings.get_string('primary-color');
                const secondaryColor = bgSettings.get_string('secondary-color');
                const shadingType = bgSettings.get_enum('color-shading-type');
                const isColor = (style === 0);

                alphaPromise = getWallpaperAlpha({
                    uri,
                    isColor,
                    primaryColor,
                    secondaryColor,
                    shadingType,
                    textLuminance: 1.0,
                });
            }

            alphaPromise.then(alpha => {
                const activeClock = this._gdm._clockManager?.clock ?? this._gdm._gdmClock;
                if (activeClock)
                    activeClock.setWallpaperAlpha(alpha);
            }).catch(e => {
                _log('[WACK/GdmManager] Failed to compute dynamic alpha: ' + e);
            });

            this._gdm._updateCupertinoPromptBackground(metadata).catch(e => {
                _log('[WACK/GdmManager] Failed to compute prompt background: ' + e);
            });

            if (this.appliedWallpaperUser === resolvedUserName &&
                this.appliedWallpaperSignature === wallpaperSignature) {
                return;
            }

            let success = false;
            if (metadata) {
                for (const bgManager of this.bgManagers) {
                    let activeWidget = bgManager.activeIsA ? bgManager.widgetA : bgManager.widgetB;
                    let targetWidget = bgManager.activeIsA ? bgManager.widgetB : bgManager.widgetA;

                    let styleStr = '';
                    if (metadata.is_color) {
                        if (metadata.shading_type === 0) {
                            styleStr = `background-color: ${metadata.primary_color};`;
                        } else {
                            let dir = metadata.shading_type === 1 ? 'vertical' : 'horizontal';
                            styleStr = `background-gradient-direction: ${dir}; background-gradient-start: ${metadata.primary_color}; background-gradient-end: ${metadata.secondary_color};`;
                        }
                    } else {
                        let bgSize = 'cover';
                        let bgPos = 'center';
                        let bgRepeat = 'no-repeat';
                        switch (metadata.style) {
                            case 0:
                            case 2: bgSize = 'auto'; break;
                            case 3: bgSize = 'contain'; break;
                            case 4: bgSize = '100% 100%'; break;
                            case 5:
                            case 6: bgSize = 'cover'; break;
                            case 1: bgSize = 'auto'; bgRepeat = 'repeat'; bgPos = 'top left'; break;
                        }
                        styleStr = `background-image: url("${metadata.uri}"); background-size: ${bgSize}; background-position: ${bgPos}; background-repeat: ${bgRepeat};`;
                    }
                    _log(`[WACK/GdmManager] setting inline CSS background on St.Widget`);
                    targetWidget.set_style(styleStr);

                    let isFirstRun = this.appliedWallpaperUser === undefined;

                    if (isFirstRun) {
                        targetWidget.remove_transition('opacity');
                        activeWidget.remove_transition('opacity');
                        targetWidget.opacity = 255;
                        activeWidget.opacity = 0;
                    } else {
                        targetWidget.ease({
                            opacity: 255,
                            duration: GDM_CROSSFADE_DURATION,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                        activeWidget.ease({
                            opacity: 0,
                            duration: GDM_CROSSFADE_DURATION,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }

                    bgManager.activeIsA = !bgManager.activeIsA;
                }
                success = true;
            }

            if (!success) {
                _log(`[WACK/GdmManager] falling back to org.gnome.desktop.background settings`);
                const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                const uri = bgSettings.get_string('picture-uri');
                const style = bgSettings.get_enum('picture-options');
                if (uri) {
                    for (const bgManager of this.bgManagers) {
                        let activeWidget = bgManager.activeIsA ? bgManager.widgetA : bgManager.widgetB;
                        let targetWidget = bgManager.activeIsA ? bgManager.widgetB : bgManager.widgetA;

                        let bgSize = 'cover';
                        let bgPos = 'center';
                        let bgRepeat = 'no-repeat';
                        switch (style) {
                            case 0:
                            case 2: bgSize = 'auto'; break;
                            case 3: bgSize = 'contain'; break;
                            case 4: bgSize = '100% 100%'; break;
                            case 5:
                            case 6: bgSize = 'cover'; break;
                            case 1: bgSize = 'auto'; bgRepeat = 'repeat'; bgPos = 'top left'; break;
                        }
                        let styleStr = `background-image: url("${uri}"); background-size: ${bgSize}; background-position: ${bgPos}; background-repeat: ${bgRepeat};`;
                        targetWidget.set_style(styleStr);

                        let isFirstRun = this.appliedWallpaperUser === undefined;

                        if (isFirstRun) {
                            targetWidget.remove_transition('opacity');
                            activeWidget.remove_transition('opacity');
                            targetWidget.opacity = 255;
                            activeWidget.opacity = 0;
                        } else {
                            targetWidget.ease({
                                opacity: 255,
                                duration: GDM_CROSSFADE_DURATION,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                            activeWidget.ease({
                                opacity: 0,
                                duration: GDM_CROSSFADE_DURATION,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        }

                        bgManager.activeIsA = !bgManager.activeIsA;
                    }
                }
            }
            this.appliedWallpaperUser = resolvedUserName;
            this.appliedWallpaperSignature = wallpaperSignature;
        } catch (e) {
            _log('[WACK/GdmManager] Failed to apply wallpaper: ' + e);
        }
    }
}
