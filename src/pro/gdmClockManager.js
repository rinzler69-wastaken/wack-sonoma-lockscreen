import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WackClock } from '../main/wackClock.js';
import {
    DATE_LABEL_HEIGHT,
    centerClockLabel,
} from '../main/constants.js';
import { GDM_DATETIME_TOP_FRACTION } from './gdmUtils.js';

export class GdmClockManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.clock = null;
        this.clockWrapper = null;
        this.clockGlowDate = null;
        this.clockGlowTime = null;
        this.timeLabel = null;
        this.clockPressed = false;
        this.menuWasOpenOnPress = false;
        this.dateMenuOpenStateId = 0;
    }

    setup(dialog, dialogParent) {
        this.clock = new WackClock();
        const dateLabel = this.clock._dateOutput;
        const timeLabel = this.clock._time;
        this.timeLabel = timeLabel;
        this.clock.remove_child(dateLabel);
        this.clock.remove_child(timeLabel);

        this.clockGlowDate = new St.Label({
            style_class: 'wack-date wack-clock-glow-date',
            text: dateLabel.text,
            reactive: false,
            opacity: 0,
        });
        this.clockGlowTime = new St.Label({
            style_class: 'unlock-dialog-clock-time wack-time wack-clock-glow-time',
            text: timeLabel.text,
            reactive: false,
            opacity: 0,
        });

        this.clockWrapper = new St.Widget({
            style_class: 'wack-gdm-clock-wrapper',
            reactive: true,
            track_hover: false,
        });
        this.clockWrapper._delegate = this;
        this.clockWrapper.set_pivot_point(0.5, 0.5);
        this.clockWrapper.add_child(this.clockGlowDate);
        this.clockWrapper.add_child(this.clockGlowTime);
        this.clockWrapper.add_child(dateLabel);
        this.clockWrapper.add_child(timeLabel);

        dialogParent.add_child(this.clockWrapper);
        dialogParent.set_child_above_sibling(this.clockWrapper, null);

        this._gdm._connectAllocation(dialog, () => this.positionClock());
        this._gdm._connectAllocation(this.clockWrapper, () => this.positionClock());

        centerClockLabel(this.clockGlowDate, this.clockWrapper);
        centerClockLabel(this.clockGlowTime, this.clockWrapper);
        centerClockLabel(dateLabel, this.clockWrapper);
        centerClockLabel(timeLabel, this.clockWrapper);

        this.timeLabel.connectObject('notify::text', () => {
            if (this.clockGlowTime)
                this.clockGlowTime.text = this.timeLabel.text;
            this.positionClock();
        }, this);

        this.clock._dateOutput.connectObject('notify::text', () => {
            if (this.clockGlowDate)
                this.clockGlowDate.text = this.clock._dateOutput.text;
        }, this);

        this.positionClock();

        this.clockWrapper.connectObject(
            'button-press-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (this._gdm._selectedPromptMode === 'wack' &&
                    (this._gdm._legacyPromptChromeVisible || this._gdm._legacyPromptAnimationState === 'selection'))
                    return Clutter.EVENT_PROPAGATE;

                if (this.clockWrapper.opacity < 10 || !this.clockWrapper.visible)
                    return Clutter.EVENT_PROPAGATE;

                const [stageX, stageY] = event.get_coords();
                if (this.isPointInsideClock(stageX, stageY)) {
                    const dateMenu = Main.panel?.statusArea?.dateMenu;
                    this.menuWasOpenOnPress = dateMenu?.menu?.isOpen ?? false;
                    this.clockPressed = true;
                    this.clockWrapper.add_style_pseudo_class('active');
                    this.clockWrapper.add_style_class_name('wack-gdm-clock-active');
                    this.syncClockGlowState(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'button-release-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (this.clockPressed) {
                    this.clockPressed = false;
                    this.clockWrapper.remove_style_pseudo_class('active');
                    this.clockWrapper.remove_style_class_name('wack-gdm-clock-active');
                    const [stageX, stageY] = event.get_coords();
                    const inside = this.isPointInsideClock(stageX, stageY);
                    if (inside && !this.menuWasOpenOnPress) {
                        this.toggleDateMenu();
                    }
                    this.menuWasOpenOnPress = false;
                    this.syncClockGlowState(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'touch-event', (actor, event) => {
                if (this._gdm._selectedPromptMode === 'wack' &&
                    (this._gdm._legacyPromptChromeVisible || this._gdm._legacyPromptAnimationState === 'selection'))
                    return Clutter.EVENT_PROPAGATE;

                if (this.clockWrapper.opacity < 10 || !this.clockWrapper.visible)
                    return Clutter.EVENT_PROPAGATE;

                const type = event.type();
                const [stageX, stageY] = event.get_coords();
                if (type === Clutter.EventType.TOUCH_BEGIN) {
                    if (this.isPointInsideClock(stageX, stageY)) {
                        const dateMenu = Main.panel?.statusArea?.dateMenu;
                        this.menuWasOpenOnPress = dateMenu?.menu?.isOpen ?? false;
                        this.clockPressed = true;
                        this.clockWrapper.add_style_pseudo_class('active');
                        this.clockWrapper.add_style_class_name('wack-gdm-clock-active');
                        this.syncClockGlowState(true);
                        return Clutter.EVENT_STOP;
                    }
                } else if (type === Clutter.EventType.TOUCH_END) {
                    if (this.clockPressed) {
                        this.clockPressed = false;
                        this.clockWrapper.remove_style_pseudo_class('active');
                        this.clockWrapper.remove_style_class_name('wack-gdm-clock-active');
                        const inside = this.isPointInsideClock(stageX, stageY);
                        if (inside && !this.menuWasOpenOnPress) {
                            this.toggleDateMenu();
                        }
                        this.menuWasOpenOnPress = false;
                        this.syncClockGlowState(true);
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            },
            this
        );

        if (Main.panel?.statusArea?.dateMenu) {
            const dateMenuBtn = Main.panel.statusArea.dateMenu;
            dateMenuBtn.hide();
            if (dateMenuBtn.menu) {
                dateMenuBtn.menu.sourceActor = this.clockWrapper;
                dateMenuBtn.menu._arrowAlignment = 0.5;
                if (dateMenuBtn.menu._boxPointer) {
                    dateMenuBtn.menu._boxPointer.updateArrowSide(St.Side.TOP);
                    dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                    dateMenuBtn.menu._boxPointer.setPosition(this.clockWrapper, 0.5);
                }

                this.dateMenuOpenStateId = dateMenuBtn.menu.connect('open-state-changed', (menu, isOpen) => {
                    if (!this.clockWrapper) return;
                    if (isOpen) {
                        this.clockWrapper.add_style_pseudo_class('checked');
                        this.clockWrapper.add_style_class_name('wack-gdm-clock-checked');
                    } else {
                        this.clockWrapper.remove_style_pseudo_class('checked');
                        this.clockWrapper.remove_style_class_name('wack-gdm-clock-checked');
                        this.clockWrapper.remove_style_pseudo_class('active');
                        this.clockWrapper.remove_style_class_name('wack-gdm-clock-active');
                    }
                    this.syncClockGlowState(true);
                });
            }
        }

        this.clockWrapper.opacity = 255;
    }

    teardown() {
        if (this.timeLabel) {
            this.timeLabel.disconnectObject(this);
            this.timeLabel = null;
        }

        if (this.clock?._dateOutput) {
            this.clock._dateOutput.disconnectObject(this);
        }

        if (this.dateMenuOpenStateId && Main.panel?.statusArea?.dateMenu?.menu) {
            Main.panel.statusArea.dateMenu.menu.disconnect(this.dateMenuOpenStateId);
            this.dateMenuOpenStateId = 0;
        }

        if (Main.panel?.statusArea?.dateMenu) {
            const dateMenuBtn = Main.panel.statusArea.dateMenu;
            if (dateMenuBtn.menu) {
                if (dateMenuBtn.menu.sourceActor === this.clockWrapper)
                    dateMenuBtn.menu.sourceActor = dateMenuBtn;
                if (dateMenuBtn.menu._boxPointer) {
                    dateMenuBtn.menu._boxPointer.updateArrowSide(St.Side.TOP);
                    dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                    dateMenuBtn.menu._boxPointer.setPosition(dateMenuBtn, 0.5);
                }
                if (dateMenuBtn.menu.actor)
                    dateMenuBtn.menu.actor.style = null;
            }
            dateMenuBtn.show();
        }

        if (this.clockWrapper) {
            this.clockWrapper.disconnectObject(this);
            this.clockWrapper.destroy();
            this.clockWrapper = null;
        }

        if (this.clock) {
            this.clock.destroy();
            this.clock = null;
        }

        this.clockGlowDate = null;
        this.clockGlowTime = null;
        this.clockPressed = false;
        this.menuWasOpenOnPress = false;
    }

    positionClock(dialogBox = null) {
        if (!this.clock || !this.clockWrapper || !this._gdm._dialog) return;
        const alloc = dialogBox || this._gdm._dialog.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;

        const topY = Math.floor(h * GDM_DATETIME_TOP_FRACTION);
        const [, timeHeight] = this.clock._time.get_preferred_height(-1);
        this.clockWrapper.set_size(w, DATE_LABEL_HEIGHT + timeHeight);
        this.clockWrapper.set_position(alloc.x1, topY);
        this.clockWrapper.set_pivot_point(0.5, 0.5);

        this.clockGlowDate?.set_y(0);
        this.clockGlowTime?.set_y(DATE_LABEL_HEIGHT);
        this.clock._dateOutput.set_y(0);
        this.clock._time.set_y(DATE_LABEL_HEIGHT);

        const dateMenuBtn = Main.panel?.statusArea?.dateMenu;
        if (dateMenuBtn?.menu?.sourceActor === this.clockWrapper) {
            if (dateMenuBtn.menu._boxPointer) {
                dateMenuBtn.menu._boxPointer.updateArrowSide(St.Side.TOP);
                dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                dateMenuBtn.menu._boxPointer.setPosition(this.clockWrapper, 0.5);
            }
            if (dateMenuBtn.menu.actor) {
                const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const bottomY = topY + DATE_LABEL_HEIGHT + timeHeight;
                const availableHeight = Math.round((workArea.height - bottomY - 30) / scaleFactor);
                if (availableHeight > 200) {
                    dateMenuBtn.menu.actor.style = `max-height: ${availableHeight}px;`;
                }
            }
        }
    }

    isPointInsideClock(stageX, stageY) {
        if (!this.clock || !this.clockWrapper) return false;
        const [success, localX, localY] = this.clockWrapper.transform_stage_point(stageX, stageY);
        if (!success) return false;

        const h = this.clockWrapper.height;
        if (localY < 0 || localY > h) return false;

        const w = this.clockWrapper.width;
        const [, dateW] = this.clock._dateOutput.get_preferred_width(-1);
        const [, timeW] = this.clock._time.get_preferred_width(-1);
        const clockW = Math.max(dateW || 0, timeW || 0);
        const halfW = (clockW / 2) + 40;
        const centerX = w / 2;

        return (localX >= centerX - halfW && localX <= centerX + halfW);
    }

    syncClockGlowState(animate = true) {
        if (!this.clockGlowDate || !this.clockGlowTime) return;

        let targetOpacity = 0;
        let duration = 250;

        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const isMenuOpen = dateMenu?.menu?.isOpen ?? false;

        if (this.clockPressed) {
            targetOpacity = 255;
            duration = 150;
        } else if (isMenuOpen) {
            targetOpacity = 100;
            duration = 250;
        } else {
            targetOpacity = 0;
            duration = 250;
        }

        for (const actor of [this.clockGlowDate, this.clockGlowTime]) {
            if (animate) {
                actor.ease({
                    opacity: targetOpacity,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                actor.remove_all_transitions();
                actor.opacity = targetOpacity;
            }
        }
    }

    toggleDateMenu() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu?.menu || !this.clockWrapper) return;

        if (this._gdm._selectedPromptMode === 'wack' &&
            (this._gdm._legacyPromptChromeVisible || this._gdm._legacyPromptAnimationState === 'selection')) {
            return;
        }

        if (this.clockWrapper.opacity < 10 || !this.clockWrapper.visible) return;

        if (dateMenu.menu.sourceActor !== this.clockWrapper) {
            dateMenu.menu.sourceActor = this.clockWrapper;
            dateMenu.menu._arrowAlignment = 0.5;
            if (dateMenu.menu._boxPointer) {
                dateMenu.menu._boxPointer.updateArrowSide(St.Side.TOP);
                dateMenu.menu._boxPointer.setSourceAlignment(0.5);
                dateMenu.menu._boxPointer.setPosition(this.clockWrapper, 0.5);
            }
        }

        dateMenu.menu.toggle();
    }
}
