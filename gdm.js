import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GDesktopEnums from 'gi://GDesktopEnums';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import { WackClock } from './wackClock.js';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import {
    GDM_USER_STACK_VERTICAL_FRACTION,
    GDM_CROSSFADE_DURATION,
    GDM_DATETIME_TOP_FRACTION,
    DATE_LABEL_HEIGHT,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
} from './constants.js';

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
    }

    enable() {
        console.log('[WACK/GdmManager] enable() called, mode=' + Main.sessionMode.currentMode);
        if (this._active) return;
        if (Main.sessionMode.currentMode !== 'gdm') return;
        this._active = true;

        // Try to find the LoginDialog and SystemBackground
        let attempts = 0;
        const findDialog = () => {
            if (!this._active)
                return GLib.SOURCE_REMOVE;

            const dialog = this._findLoginDialog();
            const systemBgActor = Main.layoutManager?._systemBackground;

            if (dialog && systemBgActor && systemBgActor.content?.background) {
                this._dialog = dialog;
                this._setup();
                this._applyWallpaper();
                this._findDialogTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }

            attempts++;
            if (attempts > 50) {
                console.log('[WACK/GdmManager] Could not find LoginDialog or SystemBackground after 50 attempts');
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
            console.error('[WACK/GdmManager] _findLoginDialog error:', e);
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
                console.log('[WACK/GdmManager] FOUND at depth', depth, child.constructor?.name);
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
        dialog.add_child(this._backgroundGroup);
        dialog.set_child_below_sibling(this._backgroundGroup, null);

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
                hasBeenFullyVisible = true;
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

        authPrompt.translation_x = Math.floor(w / 2 - promptW / 2) - (authPrompt.x || 0) - 1;
        console.log('[WACK/GdmManager] positionAuthPrompt currentY:', currentY, 'targetY:', targetY, 'translation_y:', authPrompt.translation_y, 'translation_x:', authPrompt.translation_x, 'wellH:', wellH, 'anchorH:', anchorH);
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

        let bgManager = new Background.BackgroundManager({
            container: widget,
            monitorIndex,
            controlPosition: false,
        });

        this._bgManagers.push(bgManager);
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
        if (!this._bgManagers || !this._backgroundGroup)
            return;

        for (let i = 0; i < this._bgManagers.length; i++)
            this._bgManagers[i].destroy();

        this._bgManagers = [];
        this._backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this._createBackground(i);

        this._updateBackgroundEffects();
        this._applyWallpaper();
    }

    // ── Wallpaper application ────────────────────────────────────────────────

    _applyWallpaper(userName = null) {
        try {
            if (!this._bgManagers || this._bgManagers.length === 0)
                return;

            let user = this._dialog?._user;
            let selectedUserName = userName || (user ? user.get_user_name() : null);

            let success = false;
            if (selectedUserName) {
                const metaFile = Gio.File.new_for_path(`/tmp/wack-shared-wallpaper-${selectedUserName}.json`);
                if (metaFile.query_exists(null)) {
                    const [loadSuccess, contents] = metaFile.load_contents(null);
                    if (loadSuccess) {
                        const metadata = JSON.parse(new TextDecoder().decode(contents));
                        if (metadata) {
                            for (const bgManager of this._bgManagers) {
                                const bg = bgManager.backgroundActor?.content?.background;
                                if (bg) {
                                    if (metadata.is_color) {
                                        let [res, color] = Cogl.Color.from_string(metadata.primary_color);
                                        if (res) {
                                            if (metadata.shading_type === 0) { // SOLID
                                                bg.set_color(color);
                                            } else {
                                                let [res2, secondColor] = Cogl.Color.from_string(metadata.secondary_color);
                                                if (res2) {
                                                    bg.set_gradient(metadata.shading_type, color, secondColor);
                                                }
                                            }
                                        }
                                    } else {
                                        const file = Gio.File.new_for_uri(metadata.uri);
                                        bg.set_file(file, metadata.style);
                                    }
                                }
                            }
                            success = true;
                        }
                    }
                }
            }

            if (!success) {
                const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                const uri = bgSettings.get_string('picture-uri');
                const style = bgSettings.get_enum('picture-options');
                if (uri) {
                    const file = Gio.File.new_for_uri(uri);
                    for (const bgManager of this._bgManagers) {
                        const bg = bgManager.backgroundActor?.content?.background;
                        if (bg) {
                            bg.set_file(file, style);
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[WACK/GdmManager] Failed to apply wallpaper: ' + e);
        }
    }

    // ── User selection ────────────────────────────────────────────────────────

    _onUserSelected() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        // Apply selected user's wallpaper
        this._applyWallpaper();

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
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        // Revert to GDM default background
        this._applyWallpaper(null);

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