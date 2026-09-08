import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    DATETIME_TOP_FRACTION,
    HINT_VERTICAL_FRACTION,
    HINT_NOTIF_MARGIN,
    FADE_OUT_SCALE,
    DATE_LABEL_HEIGHT,
    TIME_LABEL_HEIGHT_FALLBACK,
    centerClockLabel,
} from './constants.js';

export class ClockLayoutManager {
    constructor(extension) {
        this._extension = extension;
        this.clockWrapper = null;
        this.dateLabel = null;
        this.timeLabel = null;
        this.hintContainer = null;
        this.hint = null;
        this.overflowLabel = null;
        this.hintText = '';
        this.overflowActive = false;
    }

    setup(dialog, lockDialogGroup) {
        const dateLabel = dialog._clock._dateOutput;
        const timeLabel = dialog._clock._time;
        dialog._clock.remove_child(dateLabel);
        dialog._clock.remove_child(timeLabel);

        this.clockWrapper = new Clutter.Actor();
        this.clockWrapper.set_pivot_point(0.5, 0.5);
        this.clockWrapper.add_child(dateLabel);
        this.clockWrapper.add_child(timeLabel);
        lockDialogGroup.add_child(this.clockWrapper);

        this.dateLabel = dateLabel;
        this.timeLabel = timeLabel;

        timeLabel.connectObject('notify::text', () => this.positionClock(), this);
        centerClockLabel(timeLabel, this.clockWrapper);
        centerClockLabel(dateLabel, this.clockWrapper);

        this.positionClock();

        this.hintContainer = new Clutter.Actor();
        lockDialogGroup.add_child(this.hintContainer);

        const hint = dialog._clock._hint;
        this.hintContainer.add_child(hint);
        this.hint = hint;
        this.hintText = hint.text;

        hint.connectObject(
            'notify::text', () => {
                if (!this.overflowActive && !this._extension._showingInhibitHint) {
                    this.hintText = hint.text;
                }
            },
            'notify::opacity', () => {
                const notifManager = this._extension._notifManager;
                const hasNotifs = notifManager ? notifManager.hasVisibleNotifs() : false;
                const suppressHint = this._extension._promptActive || (this._extension._lockscreenMode === 'cupertino' && !hasNotifs && !this.overflowActive);
                if (suppressHint && hint.opacity > 0) {
                    hint.remove_all_transitions();
                    hint.set_opacity(0);
                }
            },
            this
        );
        this.positionHint();

        this.overflowLabel = new St.Label({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 255,
            visible: false,
        });
        this.overflowActive = false;
        this.hintContainer.add_child(this.overflowLabel);
    }

    positionClock() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const monitorX = monitor.x;
        const monitorY = monitor.y;
        const monitorWidth = monitor.width;
        const monitorHeight = monitor.height;

        const wrapper = this.clockWrapper;
        const dateLabel = this.dateLabel;
        const timeLabel = this.timeLabel;
        if (!wrapper || !dateLabel || !timeLabel) return;

        const topY = monitorY + Math.floor(monitorHeight * DATETIME_TOP_FRACTION);

        dateLabel.set_position(0, 0);
        timeLabel.set_position(0, DATE_LABEL_HEIGHT);

        wrapper.set_position(monitorX, topY);
        wrapper.set_width(monitorWidth);
        wrapper.set_pivot_point(0.5, 0.5);
    }

    positionHint() {
        if (!this.hint) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const monitorX = monitor.x;
        const monitorY = monitor.y;
        const monitorWidth = monitor.width;
        const monitorHeight = monitor.height;

        this.hint.set_width(-1);
        const [, natWidth] = this.hint.get_preferred_width(-1);
        const [, natHeight] = this.hint.get_preferred_height(-1);

        const notifBox = this._extension._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitorY + Math.floor(monitorHeight * HINT_VERTICAL_FRACTION);
        const notifTop = monitorY + monitorHeight - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);

        const x = monitorX + Math.floor((monitorWidth - natWidth) / 2);
        this.hint.set_position(x, y);
        this.hint.set_width(natWidth);
    }

    getClockAnimationParams() {
        const monitor = Main.layoutManager.primaryMonitor;
        const monitorY = monitor ? monitor.y : 0;
        const clockY = this.clockWrapper?.y ?? 0;
        const [, natHeight] = this.clockWrapper?.get_preferred_height(-1) ?? [0, 0];
        const [, dateHeight] = this.dateLabel?.get_preferred_height(-1) ?? [0, DATE_LABEL_HEIGHT];
        const [, timeHeight] = this.timeLabel?.get_preferred_height(-1) ?? [0, TIME_LABEL_HEIGHT_FALLBACK];
        const clockHeight = Math.max(natHeight, dateHeight + timeHeight, DATE_LABEL_HEIGHT + timeHeight);

        return {
            fadeOutScale: FADE_OUT_SCALE,
            slideUpDistance: Math.ceil(Math.max(128, clockY - monitorY + clockHeight + 48)),
        };
    }

    teardown(dialog, lockDialogGroup) {
        if (this.timeLabel) {
            this.timeLabel.disconnectObject(this);
        }
        if (this.hint) {
            this.hint.disconnectObject(this);
        }
        if (this.hintContainer) {
            if (this.overflowLabel) {
                this.hintContainer.remove_child(this.overflowLabel);
                this.overflowLabel.destroy();
                this.overflowLabel = null;
            }
            if (this.hint) {
                this.hintContainer.remove_child(this.hint);
            }
            if (lockDialogGroup) {
                lockDialogGroup.remove_child(this.hintContainer);
            }
            this.hintContainer.destroy();
            this.hintContainer = null;
        }
        if (this.clockWrapper) {
            if (this.dateLabel)
                this.clockWrapper.remove_child(this.dateLabel);
            if (this.timeLabel)
                this.clockWrapper.remove_child(this.timeLabel);
            if (lockDialogGroup)
                lockDialogGroup.remove_child(this.clockWrapper);
            this.clockWrapper.destroy();
            this.clockWrapper = null;
        }
        this.dateLabel = null;
        this.timeLabel = null;
        this.hint = null;
    }
}
