import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HINT_TIMEOUT = 4;
const CROSSFADE_TIME = 300;

// Fractional distance from top of screen for clock. default is 0.12
const CLOCK_TOP_FRACTION = 0.12;

// Fractional distance from top of screen for hint (if no notifications). default is 0.85
const HINT_VERTICAL_FRACTION = 0.85;

// Margin between hint and notifications when notifications are present. default is 32
const HINT_NOTIF_MARGIN = 32;
const FADE_OUT_SCALE = 0.3;

// Blur params
const PROMPT_BLUR_RADIUS = 50;
const PROMPT_BLUR_BRIGHTNESS = 0.85;
const PROMPT_BLUR_DURATION = 300;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

async function getPrettyDate() {
    try {
        const proc = new Gio.Subprocess({
            argv: ['date', '+%A, %B %-d'],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return stdout.trim();
    } catch (e) {
        const now = new Date();
        return now.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});
    }
}

const WackClock = GObject.registerClass(
class WackClock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'unlock-dialog-clock',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dateOutput = new St.Label({
            style_class: 'wack-date',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._time = new St.Label({
            style_class: 'unlock-dialog-clock-time wack-time',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._hint = new St.Label({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: true,
        });

        this.add_child(this._dateOutput);
        this.add_child(this._time);

        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connect('notify::clock', this._updateTime.bind(this));

        const backend = this.get_context().get_backend();
        this._seat = backend.get_default_seat();
        this._seat.connectObject('notify::touch-mode',
            this._updateHint.bind(this), this);

        this._monitorManager = global.backend.get_monitor_manager();
        this._monitorManager.connectObject('power-save-mode-changed',
            () => (this._hint.opacity = 0), this);

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(HINT_TIMEOUT * 1000, () => {
            this._hint.ease({opacity: 255, duration: CROSSFADE_TIME});
        });

        this._dateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60,
            () => { this._updateDate(); return GLib.SOURCE_CONTINUE; });

        this._updateTime();
        this._updateDate();
        this._updateHint();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _updateTime() {
        this._time.text = this._wallClock.clock.trim().replace(/\s*(AM|PM)\s*/i, '');
    }

    async _updateDate() {
        this._dateOutput.text = await getPrettyDate();
    }

    _updateHint() {
        this._hint.text = this._seat.touch_mode
            ? 'Swipe up to unlock'
            : 'Click or press a key to unlock';
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        this._idleMonitor.remove_watch(this._idleWatchId);
        if (this._dateTimeoutId)
            GLib.source_remove(this._dateTimeoutId);
    }
});

const WackLayout = GObject.registerClass(
class WackLayout extends Clutter.LayoutManager {
    _init(stack, notifications, switchUserButton) {
        super._init();
        this._stack = stack;
        this._notifications = notifications;
        this._switchUserButton = switchUserButton;
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        const [width, height] = box.get_size();
        const tenthOfHeight = height / 10.0;

        const [,, stackWidth, stackHeight] = this._stack.get_preferred_size();
        const [,, notificationsWidth, notificationsHeight] = this._notifications.get_preferred_size();

        const columnWidth = Math.max(stackWidth, notificationsWidth);
        const columnX1 = Math.floor((width - columnWidth) / 2.0);
        const actorBox = new Clutter.ActorBox();

        const maxNotificationsHeight = Math.min(
            notificationsHeight,
            height - tenthOfHeight - stackHeight);
        actorBox.x1 = columnX1;
        actorBox.y1 = height - maxNotificationsHeight;
        actorBox.x2 = columnX1 + columnWidth;
        actorBox.y2 = actorBox.y1 + maxNotificationsHeight;
        this._notifications.allocate(actorBox);

        const stackY = Math.min(
            Math.floor(height / 3.0),
            height - stackHeight - maxNotificationsHeight);
        actorBox.x1 = columnX1;
        actorBox.y1 = stackY;
        actorBox.x2 = columnX1 + columnWidth;
        actorBox.y2 = stackY + stackHeight;
        this._stack.allocate(actorBox);

        if (this._switchUserButton.visible) {
            const [,, natWidth, natHeight] = this._switchUserButton.get_preferred_size();
            const textDirection = this._switchUserButton.get_text_direction();
            if (textDirection === Clutter.TextDirection.RTL)
                actorBox.x1 = box.x1 + natWidth;
            else
                actorBox.x1 = box.x2 - (natWidth * 2);
            actorBox.y1 = box.y2 - (natHeight * 2);
            actorBox.x2 = actorBox.x1 + natWidth;
            actorBox.y2 = actorBox.y1 + natHeight;
            this._switchUserButton.allocate(actorBox);
        }
    }
});

export default class WackLockscreenClockExtension extends Extension {
    enable() {
        const dialog = Main.screenShield._dialog;
        if (!dialog) return;

        this._dialog = dialog;
        this._originalClock = dialog._clock;
        this._injectionManager = new InjectionManager();
        const lockDialogGroup = Main.screenShield._lockDialogGroup;

        // --- 1. Zero global blur ---
        this._origUpdateBgEffects = dialog._updateBackgroundEffects.bind(dialog);
        dialog._updateBackgroundEffects = () => {
            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({brightness: 1.0, radius: 0});
            }
        };
        dialog._updateBackgroundEffects();

        this._notifHeightId = dialog._notificationsBox.connect('notify::height', () => {
            this._positionHint();
        });
        this._notifVisibleId = dialog._notificationsBox.connect('notify::visible', () => {
            this._positionHint();
        });

        // --- 2. Prompt blur — animate radius on background widgets via _showPrompt/_showClock ---
        this._injectionManager.overrideMethod(
            dialog, '_showPrompt',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptShow();
                };
            }
        );

        this._injectionManager.overrideMethod(
            dialog, '_showClock',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptHide();
                };
            }
        );

        // --- 3. Replace clock, decouple from stack ---
        dialog._stack.remove_child(dialog._clock);
        dialog._clock = new WackClock();
        dialog._clock.set_pivot_point(0.5, 0.5);
        lockDialogGroup.add_child(dialog._clock);
        this._positionClock();

        // Reparent hint into lockDialogGroup
        const hint = dialog._clock._hint;
        lockDialogGroup.add_child(hint);
        this._hint = hint;
        this._positionHint();



        // Monitor changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
        });

        // --- 4. Patch _setTransitionProgress for clock-only animation ---
        this._origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this._origSetTransitionProgress(progress);

            // Clock: fade+scale in place, no translation
            const clockOpacity = Math.round(255 * (1 - progress));
            const clockScale = FADE_OUT_SCALE + (1 - FADE_OUT_SCALE) * (1 - progress);
            dialog._clock.set({
                opacity: clockOpacity,
                scale_x: clockScale,
                scale_y: clockScale,
                translation_y: 0,
            });

            // Hint: stow when prompt appears
            if (progress > 0 && this._hint.opacity > 0) {
                this._hintOpacity = this._hint.opacity;
                this._hint.set_opacity(0);
            } else if (progress === 0 && this._hintOpacity > 0) {
                this._hint.set_opacity(this._hintOpacity);
                this._hintOpacity = 0;
            }
        };

        // --- 5. Prompt-only layout ---
        const mainBox = dialog.get_child_at_index(dialog.get_n_children() - 1);
        if (mainBox) {
            this._origLayout = mainBox.layout_manager;
            mainBox.layout_manager = new WackLayout(
                dialog._stack,
                dialog._notificationsBox,
                dialog._otherUserButton);
            mainBox.queue_relayout();
            this._mainBox = mainBox;
        }
    }

    _onPromptShow() {
        for (const widget of this._dialog._backgroundGroup) {
            widget.ease_property('@effects.blur.radius', PROMPT_BLUR_RADIUS, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            widget.ease_property('@effects.blur.brightness', PROMPT_BLUR_BRIGHTNESS, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _onPromptHide() {
        for (const widget of this._dialog._backgroundGroup) {
            widget.ease_property('@effects.blur.radius', 0, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            widget.ease_property('@effects.blur.brightness', 1.0, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _positionClock() {
        const clock = this._dialog?._clock;
        if (!clock) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        clock.set_position(monitor.x, monitor.y + Math.floor(monitor.height * CLOCK_TOP_FRACTION));
        clock.set_width(monitor.width);
    }

    _positionHint() {
        if (!this._hint) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const [, natWidth] = this._hint.get_preferred_width(-1);
        const [, natHeight] = this._hint.get_preferred_height(-1);

        const notifBox = this._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitor.y + Math.floor(monitor.height * HINT_VERTICAL_FRACTION);
        const notifTop = monitor.y + monitor.height - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);

        const x = monitor.x + Math.floor((monitor.width - natWidth) / 2);
        this._hint.set_position(x, y);
        this._hint.set_width(natWidth);
    }

    disable() {
        if (!this._dialog) return;

        // Restore blur
        if (this._origUpdateBgEffects) {
            this._dialog._updateBackgroundEffects = this._origUpdateBgEffects;
            this._origUpdateBgEffects = null;
            this._dialog._updateBackgroundEffects();
        }





        // Restore transition progress
        if (this._origSetTransitionProgress) {
            this._dialog._setTransitionProgress = this._origSetTransitionProgress;
            this._origSetTransitionProgress = null;
        }

        // Clear injections (_showPrompt, _showClock)
        this._injectionManager?.clear();
        this._injectionManager = null;

        if (this._notifHeightId) {
            this._dialog._notificationsBox?.disconnect(this._notifHeightId);
            this._notifHeightId = null;
        }
        if (this._notifVisibleId) {
            this._dialog._notificationsBox?.disconnect(this._notifVisibleId);
            this._notifVisibleId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        if (this._hint) {
            lockDialogGroup?.remove_child(this._hint);
            this._hint = null;
        }

        if (this._dialog._clock) {
            lockDialogGroup?.remove_child(this._dialog._clock);
            this._dialog._clock.destroy();
            this._dialog._clock = null;
        }

        this._dialog._clock = this._originalClock;
        this._dialog._stack.add_child(this._originalClock);

        if (this._mainBox && this._origLayout) {
            this._mainBox.layout_manager = this._origLayout;
            this._mainBox.queue_relayout();
        }

        this._dialog = null;
        this._originalClock = null;
        this._mainBox = null;
        this._origLayout = null;
        this._hintOpacity = 0;
    }
}