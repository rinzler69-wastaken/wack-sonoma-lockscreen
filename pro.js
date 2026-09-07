import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GDesktopEnums from 'gi://GDesktopEnums';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import { WackClock } from './wackClock.js';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import { applyPromptAnimation } from './anims.js';
import { getWallpaperAlpha, getWallpaperPromptColor } from './alphaManager.js';
import {
    GDM_USER_STACK_VERTICAL_FRACTION,
    GDM_DATETIME_TOP_FRACTION,
    DATE_LABEL_HEIGHT,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
    GDM_CROSSFADE_DURATION,
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    centerClockLabel,
} from './constants.js';

const MESSAGE_PROMPT_GAP = 48;

function _log(msg) {
    console.debug(msg);
    try {
        const file = Gio.File.new_for_path('/var/tmp/wack-debug.log');
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(`[INFO] ${msg}\n`), null);
        stream.close(null);
    } catch (e) {
        // ignore
    }
}

function _logError(msg) {
    console.error(msg);
    try {
        const file = Gio.File.new_for_path('/var/tmp/wack-debug.log');
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(`[ERROR] ${msg}\n`), null);
        stream.close(null);
    } catch (e) {
        // ignore
    }
}

function _setActorVisible(actor, visible, opacity) {
    if (!actor)
        return;

    actor.visible = visible;
    actor.opacity = opacity;
}

export class GdmManager {
    constructor(extension) {
        this._extension = extension;
        this._active = false;
        this._dialog = null;
        this._dialogParent = null;
        this._gdmClock = null;
        this._gdmClockWrapper = null;
        this._clockGlowDate = null;
        this._clockGlowTime = null;
        this._clockPressed = false;
        this._menuWasOpenOnPress = false;
        this._findDialogTimeoutId = null;
        this._origShowPrompt = null;
        this._origOnReset = null;
        this._origVfuncAllocate = null;
        this._allocationHandlers = [];
        this._opacityId = null;
        this._timeLabel = null;
        this._cupertinoRestPromptContainer = null;
        this._cupertinoRestPrompt = null;
        this._backgroundGroup = null;
        this._bgManagers = [];
        this._monitorsChangedId = null;
        this._appliedWallpaperUser = undefined;
        this._appliedWallpaperSignature = null;
        this._gdmAvatarSetup = false;
        this._gdmOrigUpdateUser = null;
        this._gdmOrigMethodName = null;
        this._gdmOrigUserWellYAlign = null;
        this._userListItemAddedId = null;
        this._promptColorRequestId = 0;
        this._currentWallpaperMetadata = null;
        this._sharedWallpaperMonitor = null;
        this._sharedWallpaperRefreshId = null;
        this._lastWellH = undefined;
        this._lastYCenterFraction = undefined;
        this._lockscreenMessageContent = null;
        this._lockscreenMessageScrollView = null;
        this._lockscreenMessageWidth = 0;
        this._lockscreenMessageHeight = 0;
        this._lockscreenMessageHasOverflow = false;
        this._selectedPromptMode = 'cupertino';
        this._legacyPromptChromeVisible = false;
        this._origAuthPromptReset = null;
        this._legacyPromptResetAnimating = false;
        this._legacyResetInstant = false;
        this._verificationSucceeded = false;
        // Explicit prompt animation state. A prompt can be shown either because
        // the user selected an account, or because authentication just succeeded.
        // These states must never share the same entrance animation.
        this._legacyPromptAnimationState = 'idle'; // idle | selection | success
        this._legacySuccessFadeRunning = false;
        this._skipLegacyPromptEntryAnimation = false;
        this._legacyExitClone = null;
        this._origOnSessionOpened = null;
        this._origStartSession = null;
        this._isNotListed = false;
        this._notListedButtonId = 0;
        this._origAskForUsername = null;
        this._origBeginVerificationForItem = null;
        this._clockPressed = false;
        this._menuWasOpenOnPress = false;
        this._dateMenuOpenStateId = 0;
    }

    enable() {
        _log('[WACK/GdmManager] enable() called, mode=' + Main.sessionMode.currentMode);
        if (Main.sessionMode.currentMode !== 'gdm') return;

        this._active = true;

        // 1. Ensure stylesheet is loaded and listen for GDM theme updates
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.connectObject('notify::theme', () => this._ensureStylesheetLoaded(), this);
        this._ensureStylesheetLoaded();

        // 2. Discover the LoginDialog (event-driven monkeypatch)
        this._origEnsureUnlockDialog = Main.screenShield._ensureUnlockDialog;
        Main.screenShield._ensureUnlockDialog = (allowCancel) => {
            const res = this._origEnsureUnlockDialog.call(Main.screenShield, allowCancel);

            // Re-setup if the dialog changed or was newly created
            if (Main.screenShield._dialog && this._dialog !== Main.screenShield._dialog) {
                if (this._dialog) {
                    this._teardown();
                }
                this._dialog = Main.screenShield._dialog;
                this._setup();
                this._applyWallpaper();
                // Restart the dialog's fade-in so the first rendered frame is
                // always our chrome, never stock GDM's layout.
                this._restartDialogFadeIn();
            }
            return res;
        };

        // Fallback: If it's already instantiated at enable time, setup immediately.
        // The dialog may already be mid-fade-in, so we restart its animation after
        // setup to guarantee our chrome is never briefly visible in stock GDM form.
        const dialog = this._findLoginDialog();
        if (dialog) {
            this._dialog = dialog;
            this._setup();
            this._applyWallpaper();
            this._restartDialogFadeIn();
        }
    }

    disable() {
        if (!this._active) return;
        this._active = false;

        // Restore original ensureUnlockDialog method
        if (this._origEnsureUnlockDialog) {
            Main.screenShield._ensureUnlockDialog = this._origEnsureUnlockDialog;
            this._origEnsureUnlockDialog = null;
        }

        // Cleanly disconnect all signal handlers on ThemeContext
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.disconnectObject(this);

        this._teardown();
        this._unloadStylesheet();
    }

    // ── Discovery ────────────────────────────────────────────────────────────

    _findLoginDialog() {
        return Main.screenShield?._dialog || null;
    }

    _ensureStylesheetLoaded() {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const theme = themeContext.get_theme();
        if (theme) {
            const stylesheetFile = this._extension.dir.get_child('stylesheet.css');
            try {
                theme.load_stylesheet(stylesheetFile);
                _log('[WACK/GdmManager] Stylesheet loaded successfully');
            } catch (e) {
                // Ignore if already loaded
            }
        }
    }

    _unloadStylesheet() {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const theme = themeContext.get_theme();
        if (theme) {
            const stylesheetFile = this._extension.dir.get_child('stylesheet.css');
            try {
                theme.unload_stylesheet(stylesheetFile);
                _log('[WACK/GdmManager] Stylesheet unloaded');
            } catch (e) {
                // Ignore if already unloaded
            }
        }
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    _setup() {
        const dialog = this._dialog;
        this._dialogParent = dialog.get_parent();

        if (dialog.vfunc_allocate) {
            this._origVfuncAllocate = dialog.vfunc_allocate;
            dialog.vfunc_allocate = (dialogBox) => {
                this._origVfuncAllocate.call(dialog, dialogBox);
                this._positionUserList(dialogBox);
                this._positionAuthPrompt(dialogBox);
            };
        }

        // Setup background group and managers (similar to UnlockDialog)
        this._backgroundGroup = new Clutter.Actor();
        this._dialogParent.add_child(this._backgroundGroup);
        this._dialogParent.set_child_below_sibling(this._backgroundGroup, dialog);

        this._bgManagers = [];
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._updateBackgrounds();
            this._syncLockscreenMessageLayout();
            this._positionAuthPrompt();
        });

        this._updateBackgrounds();
        this._setupSharedWallpaperMonitor();

        // 1. Clock wrapper setup to decouple date/time and enforce DATE_LABEL_HEIGHT spacing
        this._gdmClock = new WackClock();
        const dateLabel = this._gdmClock._dateOutput;
        const timeLabel = this._gdmClock._time;
        this._gdmClock.remove_child(dateLabel);
        this._gdmClock.remove_child(timeLabel);

        this._clockGlowDate = new St.Label({
            style_class: 'wack-date wack-clock-glow-date',
            text: dateLabel.text,
            reactive: false,
            opacity: 0,
        });
        this._clockGlowTime = new St.Label({
            style_class: 'unlock-dialog-clock-time wack-time wack-clock-glow-time',
            text: timeLabel.text,
            reactive: false,
            opacity: 0,
        });

        this._gdmClockWrapper = new St.Widget({
            style_class: 'wack-gdm-clock-wrapper',
            reactive: true,
            track_hover: false,
        });
        this._gdmClockWrapper._delegate = this;
        this._gdmClockWrapper.set_pivot_point(0.5, 0.5);
        this._gdmClockWrapper.add_child(this._clockGlowDate);
        this._gdmClockWrapper.add_child(this._clockGlowTime);
        this._gdmClockWrapper.add_child(dateLabel);
        this._gdmClockWrapper.add_child(timeLabel);

        this._dialogParent.add_child(this._gdmClockWrapper);
        this._dialogParent.set_child_above_sibling(this._gdmClockWrapper, null);

        // Lockscreen message label — child of _dialogParent so the dialog's layout
        // manager cannot override our set_position calls.
        this._lockscreenMessageLabel = new St.Label({
            style_class: 'wack-cupertino-lockscreen-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lockscreenMessageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._lockscreenMessageLabel.clutter_text.line_wrap = true;
        this._lockscreenMessageLabel.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._lockscreenMessageLabel.x_expand = true;

        this._lockscreenMessageContent = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this._lockscreenMessageContent.add_child(this._lockscreenMessageLabel);

this._lockscreenMessageScrollView = new St.ScrollView({
    style_class: 'wack-cupertino-lockscreen-message-scroll',
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
    overlay_scrollbars: true,
    hscrollbar_policy: St.PolicyType.NEVER,
    vscrollbar_policy: St.PolicyType.NEVER,
});

this._lockscreenMessageScrollView.set_child(this._lockscreenMessageContent);
this._lockscreenMessageScrollView.connectObject(
    'scroll-event',
    () => {
        return this._lockscreenMessageHasOverflow
            ? Clutter.EVENT_PROPAGATE
            : Clutter.EVENT_STOP;
    },
    this
);

        const messageScrollbar = this._lockscreenMessageScrollView.get_vscroll_bar?.();
        if (messageScrollbar) {
            messageScrollbar.opacity = 0;
            messageScrollbar.visible = false;
            messageScrollbar.reactive = false;
        }

        this._dialogParent.add_child(this._lockscreenMessageScrollView);
        this._dialogParent.set_child_above_sibling(this._lockscreenMessageScrollView, null);

        this._timeLabel = timeLabel;
        this._connectAllocation(dialog, () => this._positionClock());
        this._connectAllocation(this._gdmClockWrapper, () => this._positionClock());

        // Setup clock centering constraints
        centerClockLabel(this._clockGlowDate, this._gdmClockWrapper);
        centerClockLabel(this._clockGlowTime, this._gdmClockWrapper);
        centerClockLabel(dateLabel, this._gdmClockWrapper);
        centerClockLabel(timeLabel, this._gdmClockWrapper);

        this._timeLabel.connectObject('notify::text', () => {
            if (this._clockGlowTime)
                this._clockGlowTime.text = this._timeLabel.text;
            this._positionClock();
        }, this);

        this._gdmClock._dateOutput.connectObject('notify::text', () => {
            if (this._clockGlowDate)
                this._clockGlowDate.text = this._gdmClock._dateOutput.text;
        }, this);

        this._positionClock();

        this._gdmClockWrapper.connectObject(
            'button-press-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (this._selectedPromptMode === 'wack' &&
                    (this._legacyPromptChromeVisible || this._legacyPromptAnimationState === 'selection'))
                    return Clutter.EVENT_PROPAGATE;

                if (this._gdmClockWrapper.opacity < 10 || !this._gdmClockWrapper.visible)
                    return Clutter.EVENT_PROPAGATE;

                const [stageX, stageY] = event.get_coords();
                if (this._isPointInsideClock(stageX, stageY)) {
                    const dateMenu = Main.panel?.statusArea?.dateMenu;
                    this._menuWasOpenOnPress = dateMenu?.menu?.isOpen ?? false;
                    this._clockPressed = true;
                    this._gdmClockWrapper.add_style_pseudo_class('active');
                    this._gdmClockWrapper.add_style_class_name('wack-gdm-clock-active');
                    this._syncClockGlowState(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'button-release-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (this._clockPressed) {
                    this._clockPressed = false;
                    this._gdmClockWrapper.remove_style_pseudo_class('active');
                    this._gdmClockWrapper.remove_style_class_name('wack-gdm-clock-active');
                    const [stageX, stageY] = event.get_coords();
                    const inside = this._isPointInsideClock(stageX, stageY);
                    if (inside && !this._menuWasOpenOnPress) {
                        this._toggleDateMenu();
                    }
                    this._menuWasOpenOnPress = false;
                    this._syncClockGlowState(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'touch-event', (actor, event) => {
                if (this._selectedPromptMode === 'wack' &&
                    (this._legacyPromptChromeVisible || this._legacyPromptAnimationState === 'selection'))
                    return Clutter.EVENT_PROPAGATE;

                if (this._gdmClockWrapper.opacity < 10 || !this._gdmClockWrapper.visible)
                    return Clutter.EVENT_PROPAGATE;

                const type = event.type();
                const [stageX, stageY] = event.get_coords();
                if (type === Clutter.EventType.TOUCH_BEGIN) {
                    if (this._isPointInsideClock(stageX, stageY)) {
                        const dateMenu = Main.panel?.statusArea?.dateMenu;
                        this._menuWasOpenOnPress = dateMenu?.menu?.isOpen ?? false;
                        this._clockPressed = true;
                        this._gdmClockWrapper.add_style_pseudo_class('active');
                        this._gdmClockWrapper.add_style_class_name('wack-gdm-clock-active');
                        this._syncClockGlowState(true);
                        return Clutter.EVENT_STOP;
                    }
                } else if (type === Clutter.EventType.TOUCH_END) {
                    if (this._clockPressed) {
                        this._clockPressed = false;
                        this._gdmClockWrapper.remove_style_pseudo_class('active');
                        this._gdmClockWrapper.remove_style_class_name('wack-gdm-clock-active');
                        const inside = this._isPointInsideClock(stageX, stageY);
                        if (inside && !this._menuWasOpenOnPress) {
                            this._toggleDateMenu();
                        }
                        this._menuWasOpenOnPress = false;
                        this._syncClockGlowState(true);
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            },
            this
        );

        // 2. Shift user selection list down
        this._connectAllocation(dialog._userSelectionBox, () => this._positionUserList());
        this._positionUserList();

        // 3. Shift auth prompt and message label
        this._connectAllocation(dialog._authPrompt, () => this._positionAuthPrompt());
        if (this._lockscreenMessageScrollView) {
            this._connectAllocation(this._lockscreenMessageScrollView, () => this._positionAuthPrompt());
        }

        // 3a. Tighten user list button widths to max natural content width
        this._setupUserListWidths();

        // 3. Distro logo opacity override
        if (dialog._logoBin) {
            dialog._logoBin.opacity = 0;
        }

        // 4. Disable dateMenu panel button and set big clock as its permanent source in GDM
        if (Main.panel?.statusArea?.dateMenu) {
            const dateMenuBtn = Main.panel.statusArea.dateMenu;
            dateMenuBtn.hide();
            if (dateMenuBtn.menu) {
                dateMenuBtn.menu.sourceActor = this._gdmClockWrapper;
                dateMenuBtn.menu._arrowAlignment = 0.5;
                if (dateMenuBtn.menu._boxPointer) {
                    dateMenuBtn.menu._boxPointer.updateArrowSide(St.Side.TOP);
                    dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                    dateMenuBtn.menu._boxPointer.setPosition(this._gdmClockWrapper, 0.5);
                }

                this._dateMenuOpenStateId = dateMenuBtn.menu.connect('open-state-changed', (menu, isOpen) => {
                    if (!this._gdmClockWrapper) return;
                    if (isOpen) {
                        this._gdmClockWrapper.add_style_pseudo_class('checked');
                        this._gdmClockWrapper.add_style_class_name('wack-gdm-clock-checked');
                    } else {
                        this._gdmClockWrapper.remove_style_pseudo_class('checked');
                        this._gdmClockWrapper.remove_style_class_name('wack-gdm-clock-checked');
                        this._gdmClockWrapper.remove_style_pseudo_class('active');
                        this._gdmClockWrapper.remove_style_class_name('wack-gdm-clock-active');
                    }
                    this._syncClockGlowState(true);
                });
            }
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
                if (!this._legacyPromptChromeVisible)
                    this._gdmClockWrapper.opacity = 255;
                const messageActor = this._getLockscreenMessageActor();
                if (messageActor && messageActor.visible) {
                    messageActor.opacity = 255;
                }
            } else if (hasBeenFullyVisible) {
                if (!this._legacyPromptChromeVisible)
                    this._gdmClockWrapper.opacity = op;
                const messageActor = this._getLockscreenMessageActor();
                if (messageActor && messageActor.visible) {
                    messageActor.opacity = op;
                }
            }
        });

        // 5. On prompt show: reposition native _authPrompt and style as Cupertino
        this._origShowPrompt = dialog._showPrompt.bind(dialog);
        dialog._showPrompt = (...args) => {
            if (this._selectedPromptMode === 'wack' && (this._verificationSucceeded || this._legacyPromptAnimationState === 'success')) {
                this._yeetLegacyPromptTransform();
                return;
            }

            const wasAlreadyVisible = dialog._authPrompt?.visible;
            this._origShowPrompt(...args);

            // In Legacy mode, do not repeat the entrance scale+slide if already in selection state
            if (this._selectedPromptMode === 'wack' && wasAlreadyVisible && this._legacyPromptAnimationState === 'selection')
                return;

            this._onUserSelected();
        };

        // 6. On reset: restore _authPrompt position and avatar
        this._origOnReset = dialog._onReset.bind(dialog);
        dialog._onReset = (...args) => {
            const willDeferReset = this._selectedPromptMode === 'wack'
                && !this._legacyPromptResetAnimating
                && !this._verificationSucceeded;

            this._origOnReset(...args);

            if (!willDeferReset)
                this._onReset();
        };
        this._authPromptResetId = dialog._authPrompt.connect('reset', () => {
            this._onReset();
        });

        // 7. On session opened / startSession: ensure scale+slide is yeeted and prompt fades out
        if (dialog._onSessionOpened) {
            this._origOnSessionOpened = dialog._onSessionOpened.bind(dialog);
            dialog._onSessionOpened = (...args) => {
                this._verificationSucceeded = true;
                if (this._selectedPromptMode === 'wack') {
                    this._legacyPromptAnimationState = 'success';
                    this._skipLegacyPromptEntryAnimation = true;
                    this._yeetLegacyPromptTransform();
                    if (!this._legacySuccessFadeRunning)
                        this._animateLegacyPromptSuccessFadeOut(() => {});
                }
                return this._origOnSessionOpened(...args);
            };
        }

        if (dialog._startSession) {
            this._origStartSession = dialog._startSession.bind(dialog);
            dialog._startSession = (...args) => {
                this._verificationSucceeded = true;
                if (this._selectedPromptMode === 'wack') {
                    this._legacyPromptAnimationState = 'success';
                    this._skipLegacyPromptEntryAnimation = true;
                    this._yeetLegacyPromptTransform();
                    if (!this._legacySuccessFadeRunning)
                        this._animateLegacyPromptSuccessFadeOut(() => {});
                }
                return this._origStartSession(...args);
            };
        }

        // 8. Track Not Listed vs normal user selection for lockscreen message suppression
        if (dialog._notListedButton) {
            this._notListedButtonId = dialog._notListedButton.connect('clicked', () => {
                this._isNotListed = true;
                this._updateLockscreenMessage();
            });
        }
        if (dialog._askForUsernameAndBeginVerification) {
            this._origAskForUsername = dialog._askForUsernameAndBeginVerification.bind(dialog);
            dialog._askForUsernameAndBeginVerification = (...args) => {
                this._isNotListed = true;
                this._updateLockscreenMessage();
                return this._origAskForUsername(...args);
            };
        }
        if (dialog._beginVerificationForItem) {
            this._origBeginVerificationForItem = dialog._beginVerificationForItem.bind(dialog);
            dialog._beginVerificationForItem = (...args) => {
                this._isNotListed = false;
                return this._origBeginVerificationForItem(...args);
            };
        }

        // Intercept Legacy reset so successful authentication can keep its fade,
        // while cancel/back returns to the picker immediately with no animation.
        this._origAuthPromptReset = dialog._authPrompt.reset.bind(dialog._authPrompt);
        dialog._authPrompt.reset = (...args) => {
            _log(`[WACK/GdmManager] authPrompt.reset() called: mode=${this._selectedPromptMode}, ` +
                `verified=${this._verificationSucceeded}`);

            if (this._selectedPromptMode !== 'wack')
                return this._origAuthPromptReset(...args);

            if (this._verificationSucceeded || this._legacyPromptAnimationState === 'success') {
                // SUCCESS STATE: fade out only. Never invoke the selection
                // scale+slide animation during this lifecycle.
                this._legacyPromptAnimationState = 'success';
                this._skipLegacyPromptEntryAnimation = true;
                this._legacyPromptResetAnimating = true;
                this._yeetLegacyPromptTransform();
                this._animateLegacyPromptSuccessFadeOut(() => {
                    this._legacyPromptResetAnimating = false;
                    this._origAuthPromptReset(...args);
                });
                return undefined;
            }

            // CANCEL STATE: hard reset. Kill every transition we own, restore the
            // picker/chrome/blur synchronously, then let native GDM perform its reset.
            this._legacyPromptAnimationState = 'idle';
            this._legacyPromptResetAnimating = false;
            this._legacyResetInstant = true;

            const authPrompt = this._dialog?._authPrompt;
            const userSelection = this._dialog?._userSelectionBox;
            const clock = this._gdmClockWrapper;
            const dateMenu = Main.panel?.statusArea?.dateMenu;

            authPrompt?.remove_all_transitions();
            userSelection?.remove_all_transitions();
            clock?.remove_all_transitions();
            dateMenu?.remove_all_transitions();

            if (authPrompt) {
                authPrompt.opacity = 255;
                authPrompt.scale_x = 1;
                authPrompt.scale_y = 1;
                authPrompt.translation_x = 0;
                authPrompt.translation_y = 0;
            }

            if (userSelection) {
                userSelection.opacity = 255;
                userSelection.show();
            }

            if (clock) {
                clock.opacity = 255;
                clock.scale_x = 1;
                clock.scale_y = 1;
            }

            if (dateMenu) {
                dateMenu.opacity = 255;
                dateMenu.show();
            }

            // Remove the prompt blur immediately instead of easing it out.
            for (const widget of this._backgroundGroup?.get_children() ?? []) {
                const effect = widget.get_effect('blur');
                if (!effect)
                    continue;

                widget.remove_transition('@effects.blur.radius');
                effect.set({
                    radius: 0,
                    brightness: 1.0,
                });
            }

            this._destroyLegacyExitClone();
            this._origAuthPromptReset(...args);
            return undefined;
        };

    }

    // ── Fade-in restart ──────────────────────────────────────────────────────────

    _restartDialogFadeIn() {
        const dialog = this._dialog;
        if (!dialog) return;
        // Cancel GDM's in-progress ease and restart from transparent, ensuring
        // the very first painted frame shows our configured layout, never stock GDM.
        dialog.remove_all_transitions();
        dialog.opacity = 0;
        dialog.ease({
            opacity: 255,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    // ── Teardown ──────────────────────────────────────────────────────────────

    _teardown() {
        this._stopCursorBlink();
        // Safety net: if the authPrompt is being replaced/destroyed mid-animation,
        // _animateLegacyPromptOut's onComplete may never fire, leaving this flag
        // stuck true and permanently disabling the Legacy inverse animation.
        this._legacyPromptResetAnimating = false;
        this._legacySuccessFadeRunning = false;
        this._legacyPromptAnimationState = 'idle';
        this._skipLegacyPromptEntryAnimation = false;
        this._destroyLegacyExitClone();
        if (!this._dialog) return;
        const dialog = this._dialog;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._sharedWallpaperRefreshId) {
            GLib.source_remove(this._sharedWallpaperRefreshId);
            this._sharedWallpaperRefreshId = null;
        }

        if (this._sharedWallpaperMonitor) {
            this._sharedWallpaperMonitor.disconnectObject(this);
            this._sharedWallpaperMonitor.cancel();
            this._sharedWallpaperMonitor = null;
        }

        if (this._bgManagers) {
            for (let i = 0; i < this._bgManagers.length; i++) {
                // Guard against Blur My Shell stamping a _bms_pipeline on our
                // manager objects (issue #16): destroy it before our own cleanup.
                this._bgManagers[i]._bms_pipeline?.destroy();
                this._bgManagers[i].destroy();
            }
            this._bgManagers = [];
        }

        if (this._backgroundGroup) {
            this._backgroundGroup.destroy();
            this._backgroundGroup = null;
        }

        if (this._lockscreenMessageScrollView) {
            this._lockscreenMessageScrollView.destroy();
            this._lockscreenMessageScrollView = null;
        }
        this._lockscreenMessageContent = null;
        if (this._lockscreenMessageLabel) {
            this._lockscreenMessageLabel = null;
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

        if (this._authPromptResetId && dialog?._authPrompt) {
            dialog._authPrompt.disconnect(this._authPromptResetId);
            this._authPromptResetId = 0;
        }
        if (this._origAuthPromptReset && dialog?._authPrompt) {
            dialog._authPrompt.reset = this._origAuthPromptReset;
            this._origAuthPromptReset = null;
        }

        for (const { actor, id } of this._allocationHandlers)
            actor.disconnect(id);
        this._allocationHandlers = [];

        if (this._origVfuncAllocate && dialog) {
            dialog.vfunc_allocate = this._origVfuncAllocate;
            this._origVfuncAllocate = null;
        }

        if (this._origShowPrompt && dialog) {
            dialog._showPrompt = this._origShowPrompt;
            this._origShowPrompt = null;
        }
        if (this._origOnReset && dialog) {
            dialog._onReset = this._origOnReset;
            this._origOnReset = null;
        }
        if (this._origOnSessionOpened && dialog) {
            dialog._onSessionOpened = this._origOnSessionOpened;
            this._origOnSessionOpened = null;
        }
        if (this._origStartSession && dialog) {
            dialog._startSession = this._origStartSession;
            this._origStartSession = null;
        }
        if (this._notListedButtonId && dialog?._notListedButton) {
            dialog._notListedButton.disconnect(this._notListedButtonId);
            this._notListedButtonId = 0;
        }
        if (this._origAskForUsername && dialog) {
            dialog._askForUsernameAndBeginVerification = this._origAskForUsername;
            this._origAskForUsername = null;
        }
        if (this._origBeginVerificationForItem && dialog) {
            dialog._beginVerificationForItem = this._origBeginVerificationForItem;
            this._origBeginVerificationForItem = null;
        }

        if (this._timeLabel) {
            this._timeLabel.disconnectObject(this);
            this._timeLabel = null;
        }

        if (this._gdmClock?._dateOutput) {
            this._gdmClock._dateOutput.disconnectObject(this);
        }

        this._clockGlowDate = null;
        this._clockGlowTime = null;

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
            const dateMenuBtn = Main.panel.statusArea.dateMenu;
            if (dateMenuBtn.menu?.isOpen)
                dateMenuBtn.menu.close();
            if (dateMenuBtn.menu) {
                dateMenuBtn.menu.sourceActor = dateMenuBtn;
                if (dateMenuBtn.menu._boxPointer) {
                    dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                    dateMenuBtn.menu._boxPointer.setPosition(dateMenuBtn, 0.5);
                }
            }
            if (this._dateMenuOpenStateId) {
                dateMenuBtn.menu.disconnect(this._dateMenuOpenStateId);
                this._dateMenuOpenStateId = 0;
            }
            const dateMenu = dateMenuBtn.container;
            dateMenu?.remove_all_transitions();
            if (dateMenu) dateMenu.opacity = 255;
            dateMenuBtn.show();
        }

        // Restore _authPrompt position
        if (dialog?._authPrompt) {
            dialog._authPrompt.translation_x = 0;
            dialog._authPrompt.translation_y = 0;
            dialog._authPrompt.remove_style_class_name('wack-cupertino-prompt');
            this._clearCupertinoPromptBackground();
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

    _getLockscreenMessageActor() {
        return this._lockscreenMessageScrollView ?? this._lockscreenMessageLabel ?? null;
    }

    _getLockscreenMessageWidth() {
        const dialog = this._dialog;
        if (dialog) {
            const alloc = dialog.get_allocation_box();
            const width = alloc.x2 - alloc.x1;
            if (width > 0)
                return Math.floor(width / 3);
        }

        const monitor = Main.layoutManager?.primaryMonitor;
        return monitor ? Math.floor(monitor.width / 3) : 0;
    }

    _getLockscreenMessageLineHeight() {
        const clutterText = this._lockscreenMessageLabel?.clutter_text;
        const layout = clutterText?.get_layout?.();
        const context = layout?.get_context?.();
        const fontDescription = layout?.get_font_description?.();

        if (context && fontDescription) {
            const metrics = context.get_metrics(fontDescription, Pango.Language.get_default());
            const metricsHeight = metrics.get_height();
            if (metricsHeight > 0)
                return Math.ceil(metricsHeight / Pango.SCALE);

            const ascent = metrics.get_ascent();
            const descent = metrics.get_descent();
            if (ascent + descent > 0)
                return Math.ceil((ascent + descent) / Pango.SCALE);
        }

        const [, naturalHeight] = this._lockscreenMessageLabel?.get_preferred_height?.(-1) ?? [0, 0];
        return Math.ceil(naturalHeight);
    }

    _getLockscreenMessageLineCount() {
        const layout = this._lockscreenMessageLabel?.clutter_text?.get_layout?.();
        return layout?.get_line_count?.() ?? 0;
    }

    _syncLockscreenMessageFade() {
        if (!this._lockscreenMessageScrollView)
            return;

        if (this._lockscreenMessageHasOverflow)
            this._lockscreenMessageScrollView.add_style_class_name('vfade');
        else
            this._lockscreenMessageScrollView.remove_style_class_name('vfade');
    }

_syncLockscreenMessageLayout() {
    if (!this._lockscreenMessageLabel ||
        !this._lockscreenMessageScrollView ||
        !this._lockscreenMessageContent)
        return;

    const messageWidth = this._getLockscreenMessageWidth();
    if (messageWidth <= 0)
        return;

    this._lockscreenMessageWidth = messageWidth;

    this._lockscreenMessageContent.width = messageWidth;
    this._lockscreenMessageLabel.width = messageWidth;

    const lineHeight = this._getLockscreenMessageLineHeight();
    const maxVisibleHeight = Math.ceil(lineHeight * 4);

    const [, naturalHeight] =
        this._lockscreenMessageLabel.get_preferred_height(messageWidth);

    const lineCount = this._getLockscreenMessageLineCount();

    this._lockscreenMessageHasOverflow =
        naturalHeight > maxVisibleHeight || lineCount > 4;

    const visibleHeight = this._lockscreenMessageHasOverflow
        ? maxVisibleHeight
        : naturalHeight;

    this._lockscreenMessageHeight = visibleHeight;

    this._lockscreenMessageScrollView.set_size(
        messageWidth,
        visibleHeight
    );

    const vadj = this._lockscreenMessageScrollView.vadjustment;

    vadj.connectObject(
    'notify::value',
    () => {
        console.debug(`[WACK] value=${vadj.value} upper=${vadj.upper} page=${vadj.page_size}`);
    },
    this
);

    if (vadj)
        vadj.set_value(0);

    // Completely disable scrolling unless there is actual overflow.
    this._lockscreenMessageScrollView.enable_mouse_scrolling =
        this._lockscreenMessageHasOverflow;

    this._lockscreenMessageScrollView.reactive =
        this._lockscreenMessageHasOverflow;

    this._lockscreenMessageScrollView.can_focus =
        this._lockscreenMessageHasOverflow;

    this._syncLockscreenMessageFade();
}

    _dialogSize() {
        const alloc = this._dialog.get_allocation_box();
        return { w: alloc.x2 - alloc.x1, h: alloc.y2 - alloc.y1 };
    }

    _positionClock(dialogBox = null) {
        if (!this._gdmClock || !this._gdmClockWrapper || !this._dialog) return;
        const alloc = dialogBox || this._dialog.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;

        const topY = Math.floor(h * GDM_DATETIME_TOP_FRACTION);
        const [, timeHeight] = this._gdmClock._time.get_preferred_height(-1);
        // Keep the wrapper's bounds tight around its two labels.  A full-screen
        // height makes a centred Scale Down pivot pull the visible clock toward the
        // middle of the monitor instead of shrinking it in place.
        this._gdmClockWrapper.set_size(w, DATE_LABEL_HEIGHT + timeHeight);
        this._gdmClockWrapper.set_position(alloc.x1, topY);
        this._gdmClockWrapper.set_pivot_point(0.5, 0.5);

        this._clockGlowDate?.set_y(0);
        this._clockGlowTime?.set_y(DATE_LABEL_HEIGHT);
        this._gdmClock._dateOutput.set_y(0);
        this._gdmClock._time.set_y(DATE_LABEL_HEIGHT);

        const dateMenuBtn = Main.panel?.statusArea?.dateMenu;
        if (dateMenuBtn?.menu?.sourceActor === this._gdmClockWrapper) {
            if (dateMenuBtn.menu._boxPointer) {
                dateMenuBtn.menu._boxPointer.updateArrowSide(St.Side.TOP);
                dateMenuBtn.menu._boxPointer.setSourceAlignment(0.5);
                dateMenuBtn.menu._boxPointer.setPosition(this._gdmClockWrapper, 0.5);
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

    _isPointInsideClock(stageX, stageY) {
        if (!this._gdmClock || !this._gdmClockWrapper) return false;
        const [success, localX, localY] = this._gdmClockWrapper.transform_stage_point(stageX, stageY);
        if (!success) return false;

        const h = this._gdmClockWrapper.height;
        if (localY < 0 || localY > h) return false;

        const w = this._gdmClockWrapper.width;
        const [, dateW] = this._gdmClock._dateOutput.get_preferred_width(-1);
        const [, timeW] = this._gdmClock._time.get_preferred_width(-1);
        const clockW = Math.max(dateW || 0, timeW || 0);
        const halfW = (clockW / 2) + 40;
        const centerX = w / 2;

        return (localX >= centerX - halfW && localX <= centerX + halfW);
    }

    _syncClockGlowState(animate = true) {
        if (!this._clockGlowDate || !this._clockGlowTime) return;

        let targetOpacity = 0;
        let duration = 250;

        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const isMenuOpen = dateMenu?.menu?.isOpen ?? false;

        if (this._clockPressed) {
            targetOpacity = 255;
            duration = 150;
        } else if (isMenuOpen) {
            targetOpacity = 100;
            duration = 250;
        } else {
            targetOpacity = 0;
            duration = 250;
        }

        for (const actor of [this._clockGlowDate, this._clockGlowTime]) {
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

    _toggleDateMenu() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu?.menu || !this._gdmClockWrapper) return;

        // In Legacy mode when in prompt state (account selected), suppress big clock dateMenu
        if (this._selectedPromptMode === 'wack' &&
            (this._legacyPromptChromeVisible || this._legacyPromptAnimationState === 'selection')) {
            return;
        }

        if (this._gdmClockWrapper.opacity < 10 || !this._gdmClockWrapper.visible) return;

        if (dateMenu.menu.sourceActor !== this._gdmClockWrapper) {
            dateMenu.menu.sourceActor = this._gdmClockWrapper;
            dateMenu.menu._arrowAlignment = 0.5;
            if (dateMenu.menu._boxPointer) {
                dateMenu.menu._boxPointer.updateArrowSide(St.Side.TOP);
                dateMenu.menu._boxPointer.setSourceAlignment(0.5);
                dateMenu.menu._boxPointer.setPosition(this._gdmClockWrapper, 0.5);
            }
        }

        dateMenu.menu.toggle();
    }

    _positionUserList(dialogBox = null) {
        if (!this._dialog?._userSelectionBox) return;
        const box = this._dialog._userSelectionBox;
        if (!box.visible) return;
        const alloc = dialogBox || this._dialog.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;
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

    _positionAuthPrompt(dialogBox = null) {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;
        if (this._selectedPromptMode === 'wack') return;
        const alloc = dialogBox || this._dialog.get_allocation_box();
        const w = alloc.x2 - alloc.x1;
        const h = alloc.y2 - alloc.y1;

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

        const messageActor = this._getLockscreenMessageActor();
        if (!dialogBox && messageActor && messageActor.visible && !this._isNotListed) {
            this._syncLockscreenMessageLayout();
            const msgW = this._lockscreenMessageWidth;
            const msgH = this._lockscreenMessageHeight;
            // Position in _dialogParent coordinates: mirror _positionClock pattern
            const msgX = alloc.x1 + Math.floor((w - msgW) / 2.0);
            const msgY = alloc.y1 + targetY - MESSAGE_PROMPT_GAP - msgH;
            messageActor.set_position(msgX, msgY);
        }

        _log('[WACK/GdmManager] positionAuthPrompt currentY: ' + currentY + ' targetY: ' + targetY + ' translation_y: ' + authPrompt.translation_y + ' translation_x: ' + authPrompt.translation_x + ' wellH: ' + wellH + ' anchorH: ' + anchorH);

        let yCenterFraction = null;
        const entry = this._findPromptEntry(authPrompt);
        if (entry) {
            const pos = entry.get_transformed_position();
            const yTrans = pos[1];
            const hTrans = entry.get_height() || 0;
            console.error(`[WACK/DEBUG] entry pos: ${JSON.stringify(pos)}, height: ${hTrans}`);
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            if (yTrans > 0 && monitorHeight > 0) {
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            }
        }

        const wellChanged = wellH !== this._lastWellH;
        const yCenterChanged = yCenterFraction !== null &&
            (this._lastYCenterFraction === undefined || Math.abs(yCenterFraction - this._lastYCenterFraction) > 0.001);

        if (wellChanged || yCenterChanged) {
            if (wellChanged) this._lastWellH = wellH;
            if (yCenterChanged) this._lastYCenterFraction = yCenterFraction;
            this._updateCupertinoPromptBackground().catch(e => {
                _logError('[WACK/GdmManager] Failed to update prompt background in allocation: ' + e);
            });
        }
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

        // Start both background widgets transparent (opacity = 0) so GDM's native background
        // (e.g. com.ubuntu.login-screen) renders cleanly when no cross-session wallpaper metadata
        // is available. _applyWallpaper() will fade in the active widget (opacity = 255) when cached
        // wallpaper metadata exists in /var/tmp.
        widgetA.opacity = 0;
        widgetB.opacity = 0;

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
        for (const widget of this._backgroundGroup.get_children()) {
            const effect = widget.get_effect('blur');
            if (effect) {
                effect.set({
                    brightness: 1.0,
                    radius: 0,
                });
            }
        }
    }

    _setPromptBackgroundBlur(active, animate = true) {
        // Returning from the prompt must never animate the blur away. Keep the
        // animated path only for entering the prompt. This also protects us
        // from duplicate/native reset paths calling this helper without the
        // explicit `animate = false` argument.
        if (!active)
            animate = false;

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = active ? PROMPT_BLUR_RADIUS * scaleFactor : 0;
        const brightness = active ? PROMPT_BLUR_BRIGHTNESS : 1.0;

        for (const widget of this._backgroundGroup?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            if (!effect)
                continue;

            effect.set_enabled(true);
            widget.remove_transition('@effects.blur.radius');
            if (animate) {
                widget.ease_property('@effects.blur.radius', radius, {
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                effect.set({ radius });
            }
            effect.set({ brightness });
        }
    }

    _updateBackgrounds() {
        if (!this._backgroundGroup) return;

        for (let i = 0; i < this._bgManagers.length; i++) {
            // Guard against Blur My Shell stamping a _bms_pipeline on our
            // manager objects (issue #16): destroy it before our own cleanup.
            this._bgManagers[i]._bms_pipeline?.destroy();
            this._bgManagers[i].destroy();
        }

        this._bgManagers = [];
        this._backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this._createBackground(i);

        this._updateBackgroundEffects();
        this._appliedWallpaperUser = undefined;
        this._appliedWallpaperSignature = null;
        this._applyWallpaper();
    }

    _setupSharedWallpaperMonitor() {
        if (this._sharedWallpaperMonitor)
            return;

        try {
            const dir = Gio.File.new_for_path('/var/tmp');
            this._sharedWallpaperMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );

            this._sharedWallpaperMonitor.connectObject('changed', (_monitor, file, _otherFile, eventType) => {
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
                this._queueSharedWallpaperRefresh();
            }, this);
        } catch (e) {
            _log('[WACK/GdmManager] Failed to monitor shared wallpaper metadata: ' + e);
        }
    }

    _queueSharedWallpaperRefresh() {
        if (this._sharedWallpaperRefreshId)
            GLib.source_remove(this._sharedWallpaperRefreshId);

        this._sharedWallpaperRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._sharedWallpaperRefreshId = null;

            const activeUserName = this._dialog?._user?.get_user_name?.() ?? null;
            this._applyWallpaper(activeUserName);
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildWallpaperSignature(resolvedUserName, metadata) {
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

    _updateLockscreenMessage(metadata = null) {
        if (!this._lockscreenMessageLabel) return;
        const messageActor = this._getLockscreenMessageActor();

        if (this._isNotListed) {
            this._lockscreenMessageHasOverflow = false;
            this._lockscreenMessageHeight = 0;
            this._syncLockscreenMessageFade();
            _setActorVisible(messageActor, false, 0);
            return;
        }

        const effectiveMetadata = metadata ?? this._currentWallpaperMetadata;
        
        const userSelected = !!(this._dialog?._user);
        const userListVisible = !!(this._dialog?._userSelectionBox?.visible);
        const authPromptActive = !!(this._dialog?._authPrompt?.visible);
        
        const showMessage = authPromptActive && userSelected && !userListVisible;

        // Only show the message when the password prompt is actively shown for a selected user.
        // Keep it hidden during user selection or transitions.
        if (showMessage && effectiveMetadata) {
            const enabled = effectiveMetadata.lockscreenMessageEnable ?? false;
            const text = effectiveMetadata.lockscreenMessageText ?? '';
            const cleanText = (text || '').trim();
            if (enabled && cleanText) {
                this._lockscreenMessageLabel.text = cleanText;
                this._syncLockscreenMessageLayout();
                if (messageActor && !messageActor.visible) {
                    messageActor.opacity = 0;
                    messageActor.visible = true;
                    messageActor.ease({
                        opacity: 255,
                        duration: 250,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            } else {
                this._lockscreenMessageHasOverflow = false;
                this._lockscreenMessageHeight = 0;
                this._syncLockscreenMessageFade();
                _setActorVisible(messageActor, false, 0);
            }
        } else {
            this._lockscreenMessageHasOverflow = false;
            this._lockscreenMessageHeight = 0;
            this._syncLockscreenMessageFade();
            _setActorVisible(messageActor, false, 0);
        }

        if (showMessage) {
            this._positionAuthPrompt();
        }
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
            this._currentWallpaperMetadata = metadata;
            this._updateLockscreenMessage(metadata);
            const wallpaperSignature = this._buildWallpaperSignature(resolvedUserName, metadata);

            _log(`[WACK/GdmManager] _applyWallpaper resolved user: ${resolvedUserName}`);

            // Push the user's clock format preference into WackClock.
            // The GDM session reads system dconf, not the user's own profile, so we
            // carry it over via the shared metadata file written by the user session.
            if (this._gdmClock)
                this._gdmClock.setClockFormat(metadata?.clockFormat ?? null);

            // Calculate and apply dynamic clock alpha based on the GDM background
            let alphaPromise;
            if (metadata) {
                if (typeof metadata.clockAlpha === 'number') {
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
                if (this._gdmClock)
                    this._gdmClock.setWallpaperAlpha(alpha);
            }).catch(e => {
                _log('[WACK/GdmManager] Failed to compute dynamic alpha: ' + e);
            });

            this._updateCupertinoPromptBackground(metadata).catch(e => {
                _log('[WACK/GdmManager] Failed to compute prompt background: ' + e);
            });

            if (this._appliedWallpaperUser === resolvedUserName &&
                this._appliedWallpaperSignature === wallpaperSignature) {
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
            this._appliedWallpaperSignature = wallpaperSignature;
        } catch (e) {
            _log('[WACK/GdmManager] Failed to apply wallpaper: ' + e);
        }
    }

    // ── User selection ────────────────────────────────────────────────────────

    _setLegacyPromptChrome(visible, animate = true) {
        // The clock must snap back on cancel. Never allow a hide operation to
        // schedule the Legacy clock fade/scale animation, even if another GDM
        // reset path calls this helper without the explicit flag.
        if (!visible)
            animate = false;

        const clock = this._gdmClockWrapper;
        // The panel contains DateMenuButton.container, but setup hid the
        // DateMenuButton itself. Fade that button, not its always-visible wrapper.
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        this._legacyPromptChromeVisible = visible;

        if (clock) {
            clock.remove_all_transitions();
            if (animate) {
                clock.ease({
                    opacity: visible ? 0 : 255,
                    // Legacy GDM always uses the WACK "Scale Down" clock handoff,
                    // independently of the user-session animation preference.
                    scale_x: visible ? 0.7 : 1.0,
                    scale_y: visible ? 0.7 : 1.0,
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                clock.opacity = visible ? 0 : 255;
                clock.scale_x = visible ? 0.7 : 1.0;
                clock.scale_y = visible ? 0.7 : 1.0;
            }
        }

        if (!dateMenu)
            return;

        if (visible) {
            if (dateMenu.menu?.isOpen)
                dateMenu.menu.close();
            if (dateMenu.menu) {
                dateMenu.menu.sourceActor = dateMenu;
                if (dateMenu.menu._boxPointer) {
                    dateMenu.menu._boxPointer.setSourceAlignment(0.5);
                    dateMenu.menu._boxPointer.setPosition(dateMenu, 0.5);
                }
            }
        }

        dateMenu.remove_all_transitions();
        if (!animate) {
            dateMenu.opacity = visible ? 255 : 0;
            if (visible)
                dateMenu.show();
            else
                dateMenu.hide();
            return;
        }

        if (visible) {
            dateMenu.opacity = 0;
            dateMenu.show();
            dateMenu.ease({
                opacity: 255,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            dateMenu.ease({
                opacity: 0,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => dateMenu.hide(),
            });
        }
    }

    _yeetLegacyPromptTransform() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt)
            return;

        authPrompt.remove_all_transitions();
        authPrompt.set_pivot_point(0.5, 0.5);
        authPrompt.scale_x = 1;
        authPrompt.scale_y = 1;
        authPrompt.translation_x = 0;
        authPrompt.translation_y = 0;
    }

    _animateLegacyPromptIn() {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt)
            return;

        // If verification succeeded or state is not selection, yeet scale+slide completely!
        if (this._legacyPromptAnimationState !== 'selection' || this._verificationSucceeded) {
            this._yeetLegacyPromptTransform();
            authPrompt.opacity = 255;
            authPrompt.visible = true;
            return;
        }

        authPrompt.remove_all_transitions();
        authPrompt.visible = true;
        authPrompt.set_pivot_point(0.5, 0.5);

        // Selection entrance: bottom-center -> final position. The prompt's own
        // center pivot keeps the scale centered instead of making it originate
        // from the lower-left corner.
        authPrompt.opacity = 0;
        authPrompt.scale_x = 0.5;
        authPrompt.scale_y = 0.5;
        authPrompt.translation_x = 0;
        authPrompt.translation_y = 200;
        authPrompt.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _animateLegacyPromptOut(onComplete) {
        _log('[WACK/GdmManager] _animateLegacyPromptOut called');
        if (this._verificationSucceeded || this._legacyPromptAnimationState === 'success') {
            this._animateLegacyPromptSuccessFadeOut(onComplete);
            return;
        }

        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) {
            _log('[WACK/GdmManager] _animateLegacyPromptOut: no authPrompt, bailing');
            onComplete();
            return;
        }

        try {
            this._destroyLegacyExitClone();

            const parent = authPrompt.get_parent();
            if (!parent) {
                _log('[WACK/GdmManager] _animateLegacyPromptOut: authPrompt has no parent, bailing');
                onComplete();
                return;
            }

            const clone = new Clutter.Clone({ source: authPrompt });
            clone.set_position(authPrompt.x, authPrompt.y);
            clone.set_size(authPrompt.width, authPrompt.height);
            clone.translation_x = authPrompt.translation_x;
            clone.translation_y = authPrompt.translation_y;
            clone.opacity = authPrompt.opacity;
            clone.set_pivot_point(0.5, 0.5);
            parent.add_child(clone);
            parent.set_child_above_sibling(clone, authPrompt);
            this._legacyExitClone = clone;
            _log(`[WACK/GdmManager] _animateLegacyPromptOut: clone created at ` +
                `x=${authPrompt.x} y=${authPrompt.y} w=${authPrompt.width} h=${authPrompt.height} ` +
                `opacity=${authPrompt.opacity}`);

            // Hide the real prompt immediately
            authPrompt.opacity = 0;

            // Pure fade: yeet scale and slide from exit animation
            clone.ease({
                opacity: 0,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    _log('[WACK/GdmManager] _animateLegacyPromptOut: clone animation complete');
                    this._destroyLegacyExitClone();
                    authPrompt.opacity = 255;
                    authPrompt.scale_x = 1;
                    authPrompt.scale_y = 1;
                    authPrompt.translation_x = 0;
                    authPrompt.translation_y = 0;
                    onComplete();
                },
            });
        } catch (e) {
            _logError('[WACK/GdmManager] _animateLegacyPromptOut threw: ' + e + '\n' + e.stack);
            this._destroyLegacyExitClone();
            authPrompt.opacity = 255;
            onComplete();
        }
    }

    _destroyLegacyExitClone() {
        if (this._legacyExitClone) {
            this._legacyExitClone.destroy();
            this._legacyExitClone = null;
        }
    }

    _animateLegacyPromptSuccessFadeOut(onComplete) {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) {
            onComplete();
            return;
        }

        this._destroyLegacyExitClone();
        this._yeetLegacyPromptTransform();
        authPrompt.visible = true;
        this._legacySuccessFadeRunning = true;
        authPrompt.ease({
            opacity: 0,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._legacySuccessFadeRunning = false;
                authPrompt.visible = false;
                onComplete();
            },
        });
    }

    _animateLegacyReturnToPicker() {
        this._setLegacyPromptChrome(false);
        this._setPromptBackgroundBlur(false);

        const userSelection = this._dialog?._userSelectionBox;
        if (!userSelection)
            return;

        // LoginDialog normally reveals this box only after AuthPrompt.reset().
        // Make it available now so its fade-in shares the same timeline as the
        // inverse prompt and returning Scale Down clock.
        userSelection.remove_all_transitions();
        userSelection.opacity = 0;
        userSelection.show();
        userSelection.ease({
            opacity: 255,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onUserSelected() {
        _log('[WACK/GdmManager] _onUserSelected called');
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;
        this._verificationSucceeded = false;
        this._legacyPromptAnimationState = 'selection';

        // _applyWallpaper synchronously loads the selected user's shared metadata.
        // That makes the prompt style a per-user choice, just like its wallpaper.
        if (this._dialog._user)
            this._applyWallpaper(this._dialog._user.get_user_name());
        this._selectedPromptMode = this._currentWallpaperMetadata?.lockscreenMode === 'wack'
            ? 'wack'
            : 'cupertino';
        this._setPromptBackgroundBlur(this._selectedPromptMode === 'wack');

        if (this._selectedPromptMode === 'wack') {
            // Keep the Cupertino user picker, but let the selected-account prompt be
            // plain GDM. The panel clock takes over while the large rest clock fades.
            this._teardownGdmAvatarOverride();
            authPrompt.translation_x = 0;
            authPrompt.translation_y = 0;
            authPrompt.add_style_class_name('wack-gdm-legacy-prompt');
            authPrompt.remove_style_class_name('wack-cupertino-prompt');
            authPrompt._message?.remove_style_class_name('wack-cupertino-message');
            authPrompt._capsLockWarningLabel?.remove_style_class_name('wack-cupertino-caps-lock-warning');
            this._clearCupertinoPromptBackground();
            _setActorVisible(this._getLockscreenMessageActor(), false, 0);
            this._setLegacyPromptChrome(true);
            this._animateLegacyPromptIn();
            this._startCursorBlink();
            return;
        }

        this._setLegacyPromptChrome(false);
        this._setupGdmAvatarOverride();
        authPrompt.remove_style_class_name('wack-gdm-legacy-prompt');

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
        authPrompt.opacity = 255;
        authPrompt.scale_x = 1;
        authPrompt.scale_y = 1;
        authPrompt.set_pivot_point(0, 0);
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

        this._updateCupertinoPromptBackground().catch(e => {
            _log('[WACK/GdmManager] Failed to apply Cupertino prompt color: ' + e);
        });

        this._updateLockscreenMessage();

        this._positionAuthPrompt();
        this._startCursorBlink();
    }

    _onReset() {
        this._stopCursorBlink();
        _log('[WACK/GdmManager] _onReset called');
        this._isNotListed = false;

        const instant = this._legacyResetInstant;
        this._legacyResetInstant = false;

        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        if (this._selectedPromptMode === 'wack') {
            // Cancel/back must restore the normal GDM chrome immediately.
            // This is intentionally not an animated handoff: the panel clock
            // must not fade back in and the prompt blur must not ease out.
            const resetInstant = instant || !this._verificationSucceeded;
            this._setLegacyPromptChrome(false, !resetInstant);
            this._setPromptBackgroundBlur(false, !resetInstant);
        } else {
            this._setPromptBackgroundBlur(false, !instant);
        }
        this._selectedPromptMode = 'cupertino';
        this._teardownGdmAvatarOverride();

        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
            this._cupertinoRestPrompt = null;
        }
        this._lastWellH = undefined;
        this._lastYCenterFraction = undefined;

        authPrompt.translation_x = 0;
        authPrompt.translation_y = 0;
        authPrompt.scale_x = 1;
        authPrompt.scale_y = 1;
        authPrompt.set_pivot_point(0, 0);
        authPrompt.opacity = 255;

        _setActorVisible(this._getLockscreenMessageActor(), false, 0);

        authPrompt.remove_style_class_name('wack-cupertino-prompt');
        authPrompt.remove_style_class_name('wack-gdm-legacy-prompt');
        this._clearCupertinoPromptBackground();

        if (authPrompt._message) {
            authPrompt._message.remove_style_class_name('wack-cupertino-message');
        }
        if (authPrompt._capsLockWarningLabel) {
            authPrompt._capsLockWarningLabel.remove_style_class_name('wack-cupertino-caps-lock-warning');
        }

        // Disconnect the auth prompt and lockscreen message label allocation handlers
        this._allocationHandlers = this._allocationHandlers.filter(({ actor, id }) => {
            if (actor === authPrompt || actor === this._lockscreenMessageLabel || actor === this._lockscreenMessageScrollView) {
                actor.disconnect(id);
                return false;
            }
            return true;
        });

        // Restore background to the last active user
        this._applyWallpaper(null);

        // Native reset is the end of the animation lifecycle.
        if (!this._verificationSucceeded) {
            this._legacyPromptAnimationState = 'idle';
            this._skipLegacyPromptEntryAnimation = false;
        }
    }

    _startCursorBlink() {
        this._stopCursorBlink();

        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt) return;

        const entry = this._findPromptEntry(authPrompt);
        let cursorBlink = true;
        if (this._currentWallpaperMetadata && typeof this._currentWallpaperMetadata.cursorBlink === 'boolean') {
            cursorBlink = this._currentWallpaperMetadata.cursorBlink;
        } else if (this._extension) {
            cursorBlink = this._extension.getSettings().get_boolean('cursor-blink');
        }

        if (entry && entry.clutter_text) {
            entry.clutter_text.cursor_blink = cursorBlink;
            entry.clutter_text.cursor_visible = true;
        }

        if (cursorBlink === false)
            return;

        let visible = true;
        this._cursorBlinkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const currentAuthPrompt = this._dialog?._authPrompt;
            if (!this._dialog || !currentAuthPrompt || !currentAuthPrompt.visible) {
                this._cursorBlinkTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const currentEntry = this._findPromptEntry(currentAuthPrompt);
            if (!currentEntry || !currentEntry.clutter_text) {
                return GLib.SOURCE_CONTINUE;
            }

            if (!currentEntry.clutter_text.has_key_focus()) {
                currentEntry.clutter_text.cursor_visible = false;
                return GLib.SOURCE_CONTINUE;
            }

            visible = !visible;
            currentEntry.clutter_text.cursor_visible = visible;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCursorBlink() {
        if (this._cursorBlinkTimeoutId) {
            GLib.source_remove(this._cursorBlinkTimeoutId);
            this._cursorBlinkTimeoutId = 0;
        }
    }

    _findPromptEntry(actor) {
        if (!actor)
            return null;

        if (actor.has_style_class_name?.('login-dialog-prompt-entry')) {
            return actor;
        }

        if (!actor.get_children)
            return null;

        for (const child of actor.get_children()) {
            const match = this._findPromptEntry(child);
            if (match)
                return match;
        }

        return null;
    }

    _applyPromptEntryBackground(entry, color) {
        if (!entry || !color)
            return;

        if (entry._wackOriginalStyle === undefined)
            entry._wackOriginalStyle = entry.get_style() ?? '';

        let shadowStyle = '';
        if (color.shadowAlpha !== undefined) {
            shadowStyle = ` box-shadow: 0 2px 24px 16px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
        }

        entry.set_style(`${entry._wackOriginalStyle} background-color: rgb(${color.r}, ${color.g}, ${color.b}) !important;${shadowStyle}`);
    }

    _applyCancelButtonBackground(button, color) {
        if (!button || !color)
            return;

        button._wackColor = color;

        if (button._wackOriginalStyle === undefined) {
            button._wackOriginalStyle = button.get_style() ?? '';

            button.connectObject(
                'notify::hover', () => this._updateCancelButtonStyle(button),
                'button-press-event', () => {
                    button._wackPressed = true;
                    this._updateCancelButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackPressed = false;
                    this._updateCancelButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                this
            );
        }

        this._updateCancelButtonStyle(button);
    }

    _updateCancelButtonStyle(button) {
        const color = button._wackColor;
        if (!color)
            return;

        if (!button.hover)
            button._wackPressed = false;

        let r = color.r;
        let g = color.g;
        let b = color.b;

        if (button._wackPressed) {
            // Subtle active lightening (blend 25% white)
            r = Math.round(r * 0.75 + 255 * 0.25);
            g = Math.round(g * 0.75 + 255 * 0.25);
            b = Math.round(b * 0.75 + 255 * 0.25);
        } else if (button.hover) {
            // Subtle hover lightening (blend 12.5% white)
            r = Math.round(r * 0.875 + 255 * 0.125);
            g = Math.round(g * 0.875 + 255 * 0.125);
            b = Math.round(b * 0.875 + 255 * 0.125);
        }

        let shadowStyle = '';
        if (color.shadowAlpha !== undefined) {
            shadowStyle = ` box-shadow: 0 2px 24px 16px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
        }

        button.set_style(`${button._wackOriginalStyle} background-color: rgb(${r}, ${g}, ${b}) !important;${shadowStyle}`);
    }

    _clearCupertinoPromptBackground() {
        const authPrompt = this._dialog?._authPrompt;
        const entry = this._findPromptEntry(authPrompt);
        if (entry) {
            if (entry._wackOriginalStyle !== undefined) {
                entry.set_style(entry._wackOriginalStyle);
                delete entry._wackOriginalStyle;
            } else {
                entry.set_style(null);
            }
        }

        const cancelButton = authPrompt?.cancelButton;
        if (cancelButton) {
            cancelButton.disconnectObject(this);
            if (cancelButton._wackOriginalStyle !== undefined) {
                cancelButton.set_style(cancelButton._wackOriginalStyle);
                delete cancelButton._wackOriginalStyle;
            } else {
                cancelButton.set_style(null);
            }
            delete cancelButton._wackColor;
            delete cancelButton._wackPressed;
        }
    }

    async _updateCupertinoPromptBackground(metadata = null) {
        const authPrompt = this._dialog?._authPrompt;
        if (!authPrompt || !authPrompt.has_style_class_name('wack-cupertino-prompt')) {
            this._clearCupertinoPromptBackground();
            return;
        }

        const entry = this._findPromptEntry(authPrompt);
        if (!entry)
            return;

        const effectiveMetadata = metadata ?? this._currentWallpaperMetadata;

        let promptVibrancy = true;
        if (effectiveMetadata && typeof effectiveMetadata.promptVibrancy === 'boolean') {
            promptVibrancy = effectiveMetadata.promptVibrancy;
        } else {
            const settings = this._extension.getSettings();
            promptVibrancy = settings.get_boolean('prompt-vibrancy');
        }

        if (!promptVibrancy) {
            this._clearCupertinoPromptBackground();
            return;
        }

        let wellH = 0;
        if (this._cupertinoRestPrompt?._userWell) {
            const [, , , hSize] = this._cupertinoRestPrompt._userWell.get_preferred_size();
            wellH = hSize > 0 ? hSize : 0;
        }

        let yCenterFraction = null;
        if (entry) {
            const [, yTrans] = entry.get_transformed_position();
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            if (yTrans > 0 && monitorHeight > 0) {
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            }
        }

        let wallpaperParams = null;
        if (effectiveMetadata) {
            if (effectiveMetadata.promptColor &&
                typeof effectiveMetadata.promptColor.r === 'number' &&
                typeof effectiveMetadata.promptColor.g === 'number' &&
                typeof effectiveMetadata.promptColor.b === 'number') {
                this._applyPromptEntryBackground(entry, effectiveMetadata.promptColor);
                if (authPrompt.cancelButton)
                    this._applyCancelButtonBackground(authPrompt.cancelButton, effectiveMetadata.promptColor);
                return;
            }

            wallpaperParams = {
                uri: effectiveMetadata.uri,
                isColor: effectiveMetadata.is_color,
                primaryColor: effectiveMetadata.primary_color,
                secondaryColor: effectiveMetadata.secondary_color,
                shadingType: effectiveMetadata.shading_type,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
            };
        } else {
            // When no cross-session wallpaper-sync metadata exists in GDM mode (e.g. before
            // user authentication), clear inline background overrides so the prompt entry
            // and cancel button fall back to their base styling defined in stylesheet.css.
            this._clearCupertinoPromptBackground();
            return;
        }

        if (!wallpaperParams)
            return;

        const requestId = ++this._promptColorRequestId;
        const color = await getWallpaperPromptColor(wallpaperParams);

        if (requestId !== this._promptColorRequestId)
            return;

        const currentPrompt = this._dialog?._authPrompt;
        const currentEntry = this._findPromptEntry(currentPrompt);
        if (!currentPrompt || !currentEntry || !currentPrompt.has_style_class_name('wack-cupertino-prompt'))
            return;

        this._applyPromptEntryBackground(currentEntry, color);
        if (currentPrompt.cancelButton)
            this._applyCancelButtonBackground(currentPrompt.cancelButton, color);
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
                // Save the original before overriding so _unwrapGdmAvatar can restore it.
                if (label._wackOrigVfuncAllocate === undefined)
                    label._wackOrigVfuncAllocate = label.vfunc_allocate;
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

        // Restore the label's vfunc_allocate before removing the button.
        const label = uw?._label;
        if (label && label._wackOrigVfuncAllocate !== undefined) {
            label.vfunc_allocate = label._wackOrigVfuncAllocate;
            delete label._wackOrigVfuncAllocate;
        }

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
