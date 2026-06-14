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
import {
    GDM_USER_STACK_VERTICAL_FRACTION,
    GDM_DATETIME_TOP_FRACTION,
    DATE_LABEL_HEIGHT,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
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
        try {
            return this._searchActorTree(Main.layoutManager.uiGroup, 0);
        } catch (e) {
            _logError('[WACK/GdmManager] _findLoginDialog error: ' + e);
        }
        return null;
    }

    _searchActorTree(actor, depth) {
        if (depth > 6) return null;
        const n = actor.get_n_children();
        for (let i = 0; i < n; i++) {
            const child = actor.get_child_at_index(i);
            if (!child) continue;
            if (child.style_class?.includes('login-dialog') || child.constructor?.name === 'LoginDialog') {
                _log('[WACK/GdmManager] FOUND at depth ' + depth + ' ' + (child.constructor?.name ?? ''));
                return child;
            }
            const found = this._searchActorTree(child, depth + 1);
            if (found) return found;
        }
        return null;
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
        let widget = new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({ name: 'blur' }),
        });

        this._bgManagers.push({
            widget: widget,
            destroy() {
                widget.destroy();
            }
        });

        this._backgroundGroup.add_child(widget);
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

    _applyWallpaper() {
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

            // Find the most recently modified user metadata file
            let metaFile = null;
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

            let metadata = null;
            if (metaFile && metaFile.query_exists(null)) {
                const [loadSuccess, contents] = metaFile.load_contents(null);
                if (loadSuccess) {
                    metadata = JSON.parse(new TextDecoder().decode(contents));
                }
            }

            let resolvedUserName = metadata ? metadata.username : null;
            _log(`[WACK/GdmManager] _applyWallpaper resolved last active user: ${resolvedUserName}`);

            if (this._appliedWallpaperUser === resolvedUserName) {
                return;
            }

            let success = false;
            if (metadata) {
                for (const bgManager of this._bgManagers) {
                    const widget = bgManager.widget;
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
                    widget.set_style(styleStr);
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
                        bgManager.widget.set_style(styleStr);
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
        const avatar = authPrompt._userWell?.get_child()?._avatar;
        if (avatar) avatar.opacity = 255;

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
    }
}