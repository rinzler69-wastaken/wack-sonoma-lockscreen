import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GDesktopEnums from 'gi://GDesktopEnums';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import { WackClock } from './wackClock.js';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import { getWallpaperAlpha } from './alphaManager.js';
import {
    GDM_USER_STACK_VERTICAL_FRACTION,
    GDM_DATETIME_TOP_FRACTION,
    DATE_LABEL_HEIGHT,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
    GDM_CROSSFADE_DURATION,
} from './constants.js';

function _log(msg) {
    console.log(msg);
}

function _logError(msg) {
    console.error(msg);
}

export class GdmManager {
    constructor(extension) {
        this._extension = extension;
        this._active = false;
        this._dialog = null;
        this._dialogParent = null;
        this._gdmClock = null;
        this._gdmClockWrapper = null;
        this._findDialogTimeoutId = null;
        this._origShowPrompt = null;
        this._origOnReset = null;
        this._allocationHandlers = [];
        this._opacityId = null;
        this._timeLabel = null;
        this._cupertinoRestPromptContainer = null;
        this._cupertinoRestPrompt = null;
        this._backgroundGroup = null;
        this._bgManagers = [];
        this._monitorsChangedId = null;
        this._appliedWallpaperUser = undefined;
        this._gdmAvatarSetup = false;
        this._gdmOrigUpdateUser = null;
        this._gdmOrigMethodName = null;
        this._gdmOrigUserWellYAlign = null;
        this._userListItemAddedId = null;
    }

    enable() {
        _log('[WACK/GdmManager] enable() called, mode=' + Main.sessionMode.currentMode);
        if (Main.sessionMode.currentMode !== 'gdm') return;

        this._active = true;

        // Try to find the LoginDialog
        let attempts = 0;
        const findDialog = () => {
            if (!this._active)
                return GLib.SOURCE_REMOVE;

            const dialog = this._findLoginDialog();

            if (dialog) {
                this._dialog = dialog;
                this._setup();
                this._applyWallpaper();
                this._findDialogTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }

            attempts++;
            if (attempts > 50) {
                _log('[WACK/GdmManager] Could not find LoginDialog after 50 attempts');
                this._findDialogTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        };

        this._findDialogTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, findDialog);
    }

    disable() {
        if (!this._active) return;
        this._active = false;
        if (this._findDialogTimeoutId) {
            GLib.source_remove(this._findDialogTimeoutId);
            this._findDialogTimeoutId = null;
        }
        this._teardown();
    }

    // ── Discovery ────────────────────────────────────────────────────────────

    _findLoginDialog() {
        return Main.screenShield?._dialog || null;
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    _setup() {
        const dialog = this._dialog;
        this._dialogParent = dialog.get_parent();

        // Setup background group and managers (similar to UnlockDialog)
        this._backgroundGroup = new Clutter.Actor();
        this._dialogParent.add_child(this._backgroundGroup);
        this._dialogParent.set_child_below_sibling(this._backgroundGroup, dialog);

        this._bgManagers = [];
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._updateBackgrounds();
        });

        this._updateBackgrounds();

        // 1. Clock wrapper setup to decouple date/time and enforce DATE_LABEL_HEIGHT spacing
        this._gdmClock = new WackClock();
        const dateLabel = this._gdmClock._dateOutput;
        const timeLabel = this._gdmClock._time;
        this._gdmClock.remove_child(dateLabel);
        this._gdmClock.remove_child(timeLabel);

        this._gdmClockWrapper = new Clutter.Actor();
        this._gdmClockWrapper.set_pivot_point(0.5, 0.5);
        this._gdmClockWrapper.add_child(dateLabel);
        this._gdmClockWrapper.add_child(timeLabel);

        this._dialogParent.add_child(this._gdmClockWrapper);
        this._dialogParent.set_child_above_sibling(this._gdmClockWrapper, null);

        this._timeLabel = timeLabel;
        this._connectAllocation(dialog, () => this._positionClock());
        this._connectAllocation(this._gdmClockWrapper, () => this._positionClock());
        this._connectAllocation(dateLabel, () => this._centerClockLabel(dateLabel));
        this._connectAllocation(timeLabel, () => this._centerClockLabel(timeLabel));

        this._timeLabel.connectObject('notify::text', () => this._positionClock(), this);

        this._positionClock();

        // 2. Shift user selection list down
        this._connectAllocation(dialog._userSelectionBox, () => this._positionUserList());
        this._positionUserList();

        // 3a. Tighten user list button widths to max natural content width
        this._setupUserListWidths();

        // 3. Distro logo opacity override
        if (dialog._logoBin) {
            dialog._logoBin.opacity = 0;
        }

        // 4. Disable dateMenu panel button
        if (Main.panel?.statusArea?.dateMenu) {
            Main.panel.statusArea.dateMenu.hide();
        }

        this._gdmClockWrapper.opacity = 255;

        let hasBeenFullyVisible = false;
        this._opacityId = dialog.connect('notify::opacity', () => {
            const op = dialog.opacity;
            if (op === 255) {
                if (!hasBeenFullyVisible) {
                    hasBeenFullyVisible = true;
                } else {
                    // GDM was already visible before, went idle/hidden, and is now waking up again.
                    // With pure CSS backgrounds, Mutter's texture flush bug doesn't apply!
                    // No need to rebuild anything.
                }
                this._gdmClockWrapper.opacity = 255;
            } else if (hasBeenFullyVisible) {
                this._gdmClockWrapper.opacity = op;
            }
        });

        // 5. On prompt show: reposition native _authPrompt and style as Cupertino
        this._origShowPrompt = dialog._showPrompt.bind(dialog);
        dialog._showPrompt = (...args) => {
            this._origShowPrompt(...args);
            this._onUserSelected();
        };

        // 6. On reset: restore _authPrompt position and avatar
        this._origOnReset = dialog._onReset.bind(dialog);
        dialog._onReset = (...args) => {
            this._origOnReset(...args);
            this._onReset();
        };

        this._setupGdmAvatarOverride();
    }

    // ── Teardown ──────────────────────────────────────────────────────────────

    _teardown() {
        const dialog = this._dialog;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._bgManagers) {
            for (let i = 0; i < this._bgManagers.length; i++) {
                this._bgManagers[i].destroy();
            }
            this._bgManagers = [];
        }

        if (this._backgroundGroup) {
            this._backgroundGroup.destroy();
            this._backgroundGroup = null;
        }

        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
            this._cupertinoRestPrompt = null;
        }

        if (this._opacityId && dialog) {
            dialog.disconnect(this._opacityId);
            this._opacityId = null;
        }

        this._teardownUserListWidths();

        for (const { actor, id } of this._allocationHandlers)
            actor.disconnect(id);
        this._allocationHandlers = [];

        if (this._origShowPrompt && dialog) {
            dialog._showPrompt = this._origShowPrompt;
            this._origShowPrompt = null;
        }
        if (this._origOnReset && dialog) {
            dialog._onReset = this._origOnReset;
            this._origOnReset = null;
        }

        if (this._timeLabel) {
            this._timeLabel.disconnectObject(this);
            this._timeLabel = null;
        }

        if (this._gdmClockWrapper) {
            this._gdmClockWrapper.destroy();
            this._gdmClockWrapper = null;
        }

        if (this._gdmClock) {
            this._gdmClock.destroy();
            this._gdmClock = null;
        }

        // Restore distro logo opacity
        if (dialog?._logoBin) {
            dialog._logoBin.opacity = 255;
        }

        // Restore dateMenu panel button
        if (Main.panel?.statusArea?.dateMenu) {
            Main.panel.statusArea.dateMenu.show();
        }

        // Restore _authPrompt position
        if (dialog?._authPrompt) {
            dialog._authPrompt.translation_x = 0;
            dialog._authPrompt.translation_y = 0;
            dialog._authPrompt.remove_style_class_name('wack-cupertino-prompt');
            if (dialog._authPrompt._message) {
                dialog._authPrompt._message.remove_style_class_name('wack-cupertino-message');
            }
            if (dialog._authPrompt._capsLockWarningLabel) {
                dialog._authPrompt._capsLockWarningLabel.remove_style_class_name('wack-cupertino-caps-lock-warning');
            }
        }

        // Restore userSelectionBox position
        if (dialog?._userSelectionBox) {
            dialog._userSelectionBox.translation_x = 0;
            dialog._userSelectionBox.translation_y = 0;
        }

        // Restore default background color (#282828)
        const systemBgActor = Main.layoutManager?._systemBackground;
        if (systemBgActor && systemBgActor.content?.background) {
            const bg = systemBgActor.content.background;
            bg.set_file(null, 0);
            let [res, color] = Cogl.Color.from_string('#282828');
            if (res) {
                bg.set_color(color);
            }
        }

        this._teardownGdmAvatarOverride();

        this._dialogParent = null;
        this._dialog = null;
    }

    // ── Positioning ───────────────────────────────────────────────────────────

    _connectAllocation(actor, fn) {
        const id = actor.connect('notify::allocation', fn);
        this._allocationHandlers.push({ actor, id });
    }

    _dialogSize() {
        const alloc = this._dialog.get_allocation_box();
        return { w: alloc.x2 - alloc.x1, h: alloc.y2 - alloc.y1 };
    }

    _centerClockLabel(label) {
        if (!label || !this._gdmClockWrapper) return;
        const wrapperW = this._gdmClockWrapper.width;
        if (wrapperW === 0) return; // not allocated yet, wait for next pass
        const [, natW] = label.get_preferred_width(-1);
        if (natW === 0) return; // label not measured yet
        label.set_x(Math.floor(wrapperW / 2 - natW / 2));
    }

    _positionClock() {
        if (!this._gdmClock || !this._gdmClockWrapper || !this._dialog) return;
        const alloc = this._dialog.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;

        const topY = Math.floor(h * GDM_DATETIME_TOP_FRACTION);
        this._gdmClockWrapper.set_size(w, h);
        this._gdmClockWrapper.set_position(alloc.x1, topY);

        this._gdmClock._dateOutput.set_y(0);
        this._gdmClock._time.set_y(DATE_LABEL_HEIGHT);

        this._centerClockLabel(this._gdmClock._dateOutput);
        this._centerClockLabel(this._gdmClock._time);
    }

    _positionUserList() {
        if (!this._dialog?._userSelectionBox) return;
        const box = this._dialog._userSelectionBox;
        if (!box.visible) return;
        const { w, h } = this._dialogSize();
        const [, , natW, natH] = box.get_preferred_size();
        box.translation_x = Math.floor(w / 2 - natW / 2) - (box.x || 0);
        box.translation_y = Math.floor(h * GDM_USER_STACK_VERTICAL_FRACTION - natH / 2) - (box.y || 0);
    }

    // ── User list width tightening ──────────────────────────────────────────

    _getItemTightWidth(item) {
        // UserWidgetLabel uses BinLayout so it reports max(real_name, username)
        // as its natural width even when only the real name is visible.
        // We measure the real name label directly to get the actual display width.
        const userWidget = item._userWidget;
        if (!userWidget) return item.get_preferred_width(-1)[1];

        const avatar = userWidget._avatar;
        const labelWidget = userWidget._label;
        if (!avatar || !labelWidget) return item.get_preferred_width(-1)[1];

        const [, avatarNatW] = avatar.get_preferred_width(-1);
        const visibleLabel = labelWidget._realNameLabel ?? labelWidget._userNameLabel;
        const [, labelNatW] = visibleLabel ? visibleLabel.get_preferred_width(-1) : [0, 0];

        // Spacing between avatar and label from CSS 'spacing' on .user-widget
        const spacing = userWidget.get_theme_node().get_length('spacing');

        // Button's own horizontal padding
        const itemNode = item.get_theme_node();
        const padLeft = itemNode.get_padding(St.Side.LEFT);
        const padRight = itemNode.get_padding(St.Side.RIGHT);

        return Math.ceil(padLeft + avatarNatW + spacing + labelNatW + padRight);
    }

    _applyUserListWidths() {
        const userList = this._dialog?._userList;
        if (!userList || userList._items.size === 0) return;

        let maxW = 0;
        for (const item of userList._items.values()) {
            const w = this._getItemTightWidth(item);
            if (w > maxW) maxW = w;
        }

        for (const item of userList._items.values()) {
            item.x_expand = false;
            item.set_width(maxW);
        }
    }

    _setupUserListWidths() {
        const userList = this._dialog?._userList;
        if (!userList) return;

        this._applyUserListWidths();

        // Re-apply whenever a new user is lazily added to the list
        this._userListItemAddedId = userList.connect('item-added', () => {
            this._applyUserListWidths();
        });
    }

    _teardownUserListWidths() {
        const userList = this._dialog?._userList;
        if (this._userListItemAddedId && userList) {
            userList.disconnect(this._userListItemAddedId);
            this._userListItemAddedId = null;
        }
        // Restore items to natural x_expand and width
        if (userList) {
            for (const item of userList._items.values()) {
                item.x_expand = true;
                item.set_width(-1);
            }
        }
    }

    _positionAuthPrompt() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;
        const { w, h } = this._dialogSize();

        const restPrompt = this._cupertinoRestPrompt;
        const userWell = restPrompt?._userWell;
        const [, , , wellH] = userWell
            ? userWell.get_preferred_size()
            : [0, 0, 0, 0];
        const [, , promptW, promptH] = authPrompt.get_preferred_size();

        const anchorH = wellH > 0 ? Math.floor(wellH * 1.3) : promptH;

        // entryY is where the prompt entry box should start
        const targetY = Math.floor(h * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;

        const currentY = authPrompt.get_allocation_box().y1;
        authPrompt.translation_y = targetY - currentY;

        authPrompt.translation_x = Math.floor(w / 2 - promptW / 2) - (authPrompt.x || 0);
        _log('[WACK/GdmManager] positionAuthPrompt currentY: ' + currentY + ' targetY: ' + targetY + ' translation_y: ' + authPrompt.translation_y + ' translation_x: ' + authPrompt.translation_x + ' wellH: ' + wellH + ' anchorH: ' + anchorH);
    }

    _createBackground(monitorIndex) {
        let monitor = Main.layoutManager.monitors[monitorIndex];
        
        let createWidget = () => new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({ name: 'blur' }),
        });

        let widgetA = createWidget();
        let widgetB = createWidget();
        
        widgetB.opacity = 0; // Starts hidden

        this._backgroundGroup.add_child(widgetA);
        this._backgroundGroup.add_child(widgetB);

        this._bgManagers.push({
            widgetA,
            widgetB,
            activeIsA: true,
            destroy() {
                widgetA.destroy();
                widgetB.destroy();
            }
        });
    }

    _updateBackgroundEffects() {
        for (const widget of this._backgroundGroup) {
            const effect = widget.get_effect('blur');
            if (effect) {
                effect.set({
                    brightness: 1.0,
                    radius: 0,
                });
            }
        }
    }

    _updateBackgrounds() {
        if (!this._backgroundGroup) return;

        for (let i = 0; i < this._bgManagers.length; i++)
            this._bgManagers[i].destroy();

        this._bgManagers = [];
        this._backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this._createBackground(i);

        this._updateBackgroundEffects();
        this._appliedWallpaperUser = undefined;
        this._applyWallpaper();
    }

    // ── Wallpaper application ────────────────────────────────────────────────

    _applyWallpaper(requestedUserName = null) {
        try {
            if (!this._backgroundGroup) {
                this._backgroundGroup = new Clutter.Actor();
                this._dialogParent.add_child(this._backgroundGroup);
                this._dialogParent.set_child_below_sibling(this._backgroundGroup, this._dialog);
                this._bgManagers = [];
            }

            if (!this._bgManagers || this._bgManagers.length === 0) {
                for (let i = 0; i < Main.layoutManager.monitors.length; i++)
                    this._createBackground(i);
                this._updateBackgroundEffects();
                this._appliedWallpaperUser = undefined;
            }

            let resolvedUserName = requestedUserName;
            let metaFile = null;

            if (!resolvedUserName) {
                // Find the most recently modified user metadata file
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

            _log(`[WACK/GdmManager] _applyWallpaper resolved user: ${resolvedUserName}`);

            // Push the user's clock format preference into WackClock.
            // The GDM session reads system dconf, not the user's own profile, so we
            // carry it over via the shared metadata file written by the user session.
            if (this._gdmClock)
                this._gdmClock.setClockFormat(metadata?.clockFormat ?? null);

            // Calculate and apply dynamic clock alpha based on the GDM background
            let alphaPromise;
            if (metadata) {
                alphaPromise = getWallpaperAlpha({
                    uri: metadata.uri,
                    isColor: metadata.is_color,
                    primaryColor: metadata.primary_color,
                    secondaryColor: metadata.secondary_color,
                    shadingType: metadata.shading_type,
                    textLuminance: 1.0,
                });
            } else {
                try {
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
                } catch (e) {
                    _log('[WACK/GdmManager] Failed to get default background settings for alpha: ' + e);
                    alphaPromise = Promise.resolve(0.6);
                }
            }

            alphaPromise.then(alpha => {
                if (this._gdmClock)
                    this._gdmClock.setWallpaperAlpha(alpha);
            }).catch(e => {
                _log('[WACK/GdmManager] Failed to compute dynamic alpha: ' + e);
            });

            if (this._appliedWallpaperUser === resolvedUserName) {
                return;
            }

            let success = false;
            if (metadata) {
                for (const bgManager of this._bgManagers) {
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

                    let isFirstRun = this._appliedWallpaperUser === undefined;

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
                    for (const bgManager of this._bgManagers) {
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

                        let isFirstRun = this._appliedWallpaperUser === undefined;

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
            this._appliedWallpaperUser = resolvedUserName;
        } catch (e) {
            _log('[WACK/GdmManager] Failed to apply wallpaper: ' + e);
        }
    }

    // ── User selection ────────────────────────────────────────────────────────

    _onUserSelected() {
        _log('[WACK/GdmManager] _onUserSelected called');
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        // Recreate the dummy rest prompt with the current GDM user to get exact same font/avatar metrics
        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
        }

        this._cupertinoRestPromptContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'wack-cupertino-rest',
            opacity: 0,
            visible: true,
        });
        this._cupertinoRestPromptContainer.set_position(-1000, -1000);
        this._cupertinoRestPrompt = new WackCupertinoRestPrompt(this._dialog._user, this._extension);
        this._cupertinoRestPromptContainer.add_child(this._cupertinoRestPrompt);
        this._dialog.add_child(this._cupertinoRestPromptContainer);

        // Style as Cupertino prompt (hides password field chrome, etc.)
        authPrompt.add_style_class_name('wack-cupertino-prompt');

        if (authPrompt._message) {
            authPrompt._message.add_style_class_name('wack-cupertino-message');
        }
        if (authPrompt._capsLockWarningLabel) {
            authPrompt._capsLockWarningLabel.add_style_class_name('wack-cupertino-caps-lock-warning');
        }

        // Make native avatar visible — don't suppress it
        const uw = authPrompt._userWell?.get_child();
        if (uw) {
            if (uw._avatar) uw._avatar.opacity = 255;
            if (uw._avatarButton) {
                uw._avatarButton.opacity = 255;
                uw._avatarButton.visible = true;
            }
        }

        // Apply selected user's wallpaper with transition
        if (this._dialog._user) {
            this._applyWallpaper(this._dialog._user.get_user_name());
        }

        // Reposition prompt to lower third on allocation
        this._connectAllocation(authPrompt, () => this._positionAuthPrompt());
        this._positionAuthPrompt();
    }

    _onReset() {
        _log('[WACK/GdmManager] _onReset called');
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
            this._cupertinoRestPrompt = null;
        }

        authPrompt.translation_x = 0;
        authPrompt.translation_y = 0;
        authPrompt.remove_style_class_name('wack-cupertino-prompt');

        if (authPrompt._message) {
            authPrompt._message.remove_style_class_name('wack-cupertino-message');
        }
        if (authPrompt._capsLockWarningLabel) {
            authPrompt._capsLockWarningLabel.remove_style_class_name('wack-cupertino-caps-lock-warning');
        }

        // Disconnect the auth prompt allocation handler
        this._allocationHandlers = this._allocationHandlers.filter(({ actor, id }) => {
            if (actor === authPrompt) {
                actor.disconnect(id);
                return false;
            }
            return true;
        });

        // Restore background to the last active user
        this._applyWallpaper(null);
    }

    _setupGdmAvatarOverride() {
        if (this._gdmAvatarSetup) return;
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;
        this._gdmAvatarSetup = true;

        if (authPrompt._userWell) {
            this._gdmOrigUserWellYAlign = authPrompt._userWell.y_align;
            authPrompt._userWell.y_align = Clutter.ActorAlign.START;
        }

        if (!this._gdmOrigUpdateUser) {
            const methodName = authPrompt.setUser ? 'setUser' : 'updateUser';
            this._gdmOrigMethodName = methodName;
            this._gdmOrigUpdateUser = authPrompt[methodName].bind(authPrompt);
            authPrompt[methodName] = (user) => {
                this._gdmOrigUpdateUser(user);
                this._wrapGdmAvatar();
            };
            this._wrapGdmAvatar();
        }

        authPrompt.connectObject('destroy', () => this._teardownGdmAvatarOverride(), this);
    }

    _teardownGdmAvatarOverride() {
        const authPrompt = this._dialog?._authPrompt;
        if (authPrompt) authPrompt.disconnectObject(this);

        if (authPrompt && authPrompt._userWell && this._gdmOrigUserWellYAlign !== undefined) {
            authPrompt._userWell.y_align = this._gdmOrigUserWellYAlign;
            this._gdmOrigUserWellYAlign = null;
        }

        if (authPrompt && this._gdmOrigUpdateUser && this._gdmOrigMethodName) {
            authPrompt[this._gdmOrigMethodName] = this._gdmOrigUpdateUser;
        }
        this._gdmOrigUpdateUser = null;
        this._gdmOrigMethodName = null;

        this._unwrapGdmAvatar();
        this._gdmAvatarSetup = false;
    }

    _wrapGdmAvatar() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) {
            _log('[WACK/GdmManager] _wrapGdmAvatar: no authPrompt');
            return;
        }

        const uw = authPrompt._userWell?.get_child();
        _log(`[WACK/GdmManager] _wrapGdmAvatar: uw=${uw?.constructor?.name}, child=${uw}`);
        if (uw) {
            _log(`[WACK/GdmManager] _wrapGdmAvatar: uw._avatar=${uw._avatar}, uw._avatarButton=${uw._avatarButton}`);
            const childrenNames = uw.get_children().map(c => c.constructor.name);
            _log(`[WACK/GdmManager] _wrapGdmAvatar: uw children: ${childrenNames.join(', ')}`);
        }

        if (uw && uw._avatar && !uw._avatarButton) {
            const avatar = uw._avatar;
            _log('[WACK/GdmManager] _wrapGdmAvatar: wrapping avatar in St.Button');
            uw.remove_child(avatar);
            
            uw._avatarButton = new St.Button({
                style_class: 'wack-avatar-well',
                x_expand: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
                can_focus: false,
                child: avatar,
                reactive: false,
            });
            uw.insert_child_at_index(uw._avatarButton, 0);

            const label = uw?._label;
            if (label && label.vfunc_allocate) {
                label.vfunc_allocate = function (box) {
                    this.set_allocation(box);
                    const availWidth = box.x2 - box.x1;
                    const availHeight = box.y2 - box.y1;
                    const childBox = new Clutter.ActorBox();
                    this._currentLabel = this._userNameLabel;
                    this.label_actor = this._currentLabel;
                    this._realNameLabel.allocate(childBox); // hidden, zero-sized
                    childBox.set_size(availWidth, availHeight);
                    this._userNameLabel.allocate(childBox);
                };
            }
            _log('[WACK/GdmManager] _wrapGdmAvatar: wrapping completed successfully');
        }
    }

    _unwrapGdmAvatar() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        const uw = authPrompt._userWell?.get_child();
        if (uw && uw._avatarButton) {
            const button = uw._avatarButton;
            const avatar = button.get_child();
            if (avatar) {
                button.set_child(null);
                uw.remove_child(button);
                uw.insert_child_at_index(avatar, 0);
            }
            uw._avatarButton = null;
        }
    }
}
