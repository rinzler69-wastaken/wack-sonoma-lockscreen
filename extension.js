import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gdm from 'gi://Gdm';
import Gettext from 'gettext';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { UnblankManager } from './unblank.js';
import {
    CLOCK_ANIMATIONS,
    DEFAULT_CLOCK_ANIMATION,
    DEFAULT_PROMPT_ANIMATION,
    PROMPT_ANIMATIONS,
    applyClockAnimation,
    applyPromptAnimation,
    createAnimationState,
    getAnimationSetting,
    resetAnimationActors,
} from './anims.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WackClock } from './wackClock.js';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import { getWallpaperAlpha, clearCache, initCache } from './alphaManager.js';
import { WackLayout } from './layoutManager.js';
import { NotificationManager } from './notificationManager.js';
import { GdmManager } from './gdm.js';
import { CrossSessionManager } from './crossSessionManager.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    NOTIF_BLUR_RADIUS,
    NOTIF_BLUR_NAME,
    CROSSFADE_TIME,
    DATETIME_TOP_FRACTION,
    HINT_VERTICAL_FRACTION,
    HINT_NOTIF_MARGIN,
    FADE_OUT_SCALE,
    DATE_LABEL_HEIGHT,
    TIME_LABEL_HEIGHT_FALLBACK,
    CUPERTINO_UNLOCK_PANEL_FADE,
    CUPERTINO_UNLOCK_TSO_DELAY,
    CUPERTINO_UNLOCK_FADE_DURATION,
} from './constants.js';

function _log(msg) {
    console.log(msg);
}

function _logError(msg) {
    console.error(msg);
}

export default class WackLockscreenClockExtension extends Extension {
    // ── Single Source of Truth for Prompt State ───────────────────────────
    get _promptActive() {
        return (this._dialog?._adjustment?.value ?? 0) > 0;
    }

    enable() {
        this._gdmManager = new GdmManager(this);
        this._gdmManager.enable();

        if (Main.sessionMode.currentMode !== 'gdm') {
            const syncCrossSession = () => {
                const wackShell = Main.extensionManager.lookup('wack-shell@rinzler69-wastaken.github.com');
                const wackShellEnabled = wackShell && wackShell.state === 1;

                if (wackShellEnabled) {
                    if (this._crossSessionManager) {
                        this._crossSessionManager.disable();
                        this._crossSessionManager = null;
                    }
                } else {
                    if (!this._crossSessionManager) {
                        this._crossSessionManager = new CrossSessionManager();
                        this._crossSessionManager.enable();
                    }
                }
            };

            syncCrossSession();

            this._wackShellStateChangedId = Main.extensionManager.connect('extension-state-changed', (_obj, ext) => {
                if (ext.uuid === 'wack-shell@rinzler69-wastaken.github.com') {
                    syncCrossSession();
                }
            });
        }

        const dialog = Main.screenShield._dialog;
        _log(`[WACK] enable() called, dialog=${!!dialog}`);
        if (!dialog) return;

        this._origStylesheet = undefined;
        const userThemeFile = this._getUserThemeFile();
        if (userThemeFile) {
            this._origStylesheet = Main.getThemeStylesheet();
            Main.setThemeStylesheet(userThemeFile.get_path());
            Main.loadTheme();
        }

        if (Main.panel?.statusArea?.dateMenu?.container) {
            this._wasDateMenuVisible = Main.panel.statusArea.dateMenu.container.visible;
            Main.panel.statusArea.dateMenu.container.hide();
        }

        this._dialog = dialog;
        this._originalClock = dialog._clock;
        this._injectionManager = new InjectionManager();
        this._idleSources = new Set();
        this._clockAnimation = DEFAULT_CLOCK_ANIMATION;
        this._promptAnimation = DEFAULT_PROMPT_ANIMATION;
        this._lockscreenMode = 'wack';
        this._cupertinoAlwaysShowUser = false;
        this._cupertinoShowNotifsOverride = false;
        this._showingInhibitHint = false;
        this._inhibitHintTimeoutId = null;
        this._finishTimeoutId = null;
        this._originalWackText = null;
        this._originalCupertinoText = null;
        this._originalCupertinoCount = 0;
        this._animationState = createAnimationState();

        // Track state transitions to prevent redundant side-effects
        this._wasPromptActive = false;

        initCache();

        this._notifManager = new NotificationManager(this);
        this._loadSettings();
        this._unblankManager = new UnblankManager(this);
        const lockDialogGroup = Main.screenShield._lockDialogGroup;

        // ── Justified Duct Tape: Background Effects Override ──────────────
        // Prevents the shell from stomping our custom blur transitions.
        this._origUpdateBgEffects = dialog._updateBackgroundEffects.bind(dialog);
        dialog._updateBackgroundEffects = () => {
            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect) effect.set({ brightness: 1.0, radius: 0 });
            }
        };
        dialog._updateBackgroundEffects();

        // ── Justified Duct Tape: User Switch Visibility ───────────────────
        this._origUpdateUserSwitchVisibility = dialog._updateUserSwitchVisibility.bind(dialog);
        dialog._updateUserSwitchVisibility = () => {
            this._origUpdateUserSwitchVisibility();
            if (this._lockscreenMode === 'cupertino') {
                dialog._otherUserButton.visible = false;
            }
        };
        dialog._updateUserSwitchVisibility();

        // ── Justified Duct Tape: Finish Intercept for Cupertino Fade-out ──
        this._origFinish = dialog.finish.bind(dialog);
        dialog.finish = (onComplete) => {
            const isCupertino = this._lockscreenMode === 'cupertino';
            if (isCupertino && this._cupertinoUnlockFade) {
                // Snapshot the cache reference *now*, before _tempSessionModeOverride()
                // flips Main.sessionMode.hasWindows and emits 'updated' below. wack-shell's
                // _syncSessionModeUI() listens for that same signal and clears
                // global.wack_window_snapshots as soon as hasWindows goes true, which would
                // otherwise race ahead of the fade-in code further down in this callback.
                const capturedSnapshots = global.wack_window_snapshots
                    ? global.wack_window_snapshots.slice()
                    : [];
                log(`[WACK Lockscreen] finish(): captured ${capturedSnapshots.length} snapshot(s) before session-mode override`);

                const panel = Main.panel;
                if (panel) {
                    panel.ease({ opacity: 0, duration: CUPERTINO_UNLOCK_PANEL_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                }

                if (this._finishTimeoutId) {
                    GLib.source_remove(this._finishTimeoutId);
                    this._finishTimeoutId = null;
                }

                // Wait for the panel fade-out (CUPERTINO_UNLOCK_PANEL_FADE ms) to complete, then apply the
                // session mode override so the panel gets its user-session appearance
                // (dateMenu, theming, extensions) before it slides in.
                this._finishTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CUPERTINO_UNLOCK_TSO_DELAY, () => {
                    this._finishTimeoutId = null;
                    this._tempSessionModeOverride();

                    const duration = CUPERTINO_UNLOCK_FADE_DURATION;
                    const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

                    if (panel) {
                        panel.remove_all_transitions();
                        const panelHeight = panel.height || 60;
                        panel.translation_y = -panelHeight;
                        panel.opacity = 255;
                        panel.ease({ translation_y: 0, duration, mode });
                    }

                    // Check if we have cached window snapshots and fade them in
                    log(`[WACK Lockscreen] fade-in callback: ${capturedSnapshots.length} snapshot(s) available to crossfade`);
                    if (capturedSnapshots.length > 0) {
                        this._windowFadeContainer = new Clutter.Actor();
                        lockDialogGroup.add_child(this._windowFadeContainer);
                        // Place directly above `dialog` (which owns the opaque wallpaper/
                        // _backgroundGroup) so the window textures are actually visible,
                        // instead of set_child_below_sibling(..., null) which sank this
                        // below the wallpaper entirely. The clock/hint/panel — which fade
                        // to opacity 0 below — stay above this container, so as they fade
                        // out the window textures are revealed underneath.
                        lockDialogGroup.set_child_above_sibling(this._windowFadeContainer, this._dialog);

                        capturedSnapshots.forEach(snapshot => {
                            const actor = new Clutter.Actor({
                                content: snapshot.content,
                                x: snapshot.rect.x,
                                y: snapshot.rect.y,
                                width: snapshot.rect.width,
                                height: snapshot.rect.height
                            });
                            actor.set_pivot_point(0.5, 0.5);
                            actor.scale_x = 0.94;
                            actor.scale_y = 0.94;
                            // add_child first so actor is realized on stage,
                            // then ease — Clutter requires the actor to be staged
                            // before a transition can actually run.
                            this._windowFadeContainer.add_child(actor);
                            actor.ease({
                                scale_x: 1.0,
                                scale_y: 1.0,
                                duration,
                                mode,
                            });
                        });

                        // Container handles the unified opacity fade only
                        this._windowFadeContainer.opacity = 0;
                        this._windowFadeContainer.ease({
                            opacity: 255,
                            duration,
                            mode,
                        });
                    }

                    const actorsToFade = [this._clockWrapper, this._hintContainer, this._mainBox].filter(a => a != null);
                    actorsToFade.forEach(actor => {
                        actor.ease({ opacity: 0, duration, mode });
                    });

                    if (this._finishTimeoutId) {
                        GLib.source_remove(this._finishTimeoutId);
                        this._finishTimeoutId = null;
                    }
                    this._finishTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                        this._finishTimeoutId = null;

                        let called = false;
                        const safeOnComplete = () => {
                            if (called) return;
                            called = true;
                            this._restoreSessionMode();
                            if (this._windowFadeContainer) {
                                this._windowFadeContainer.destroy();
                                this._windowFadeContainer = null;
                            }
                            global.wack_window_snapshots = [];
                            onComplete();
                        };

                        this._origFinish(safeOnComplete);

                        // Fallback in case GDM's finish hangs or never calls onComplete
                        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            safeOnComplete();
                            return GLib.SOURCE_REMOVE;
                        });

                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._origFinish(onComplete);
            }
        };

        // ── Justified Duct Tape: Skip Slide-up in Cupertino Mode ──────────
        const shield = Main.screenShield;
        this._origContinueDeactivate = shield._continueDeactivate.bind(shield);
        shield._continueDeactivate = (animate) => {
            const isCupertino = this._lockscreenMode === 'cupertino';
            if (isCupertino) {
                shield._hideLockScreen(false);
                if (Main.sessionMode.currentMode === 'unlock-dialog') {
                    Main.sessionMode.popMode('unlock-dialog');
                }
                shield.emit('wake-up-screen');

                if (shield._isGreeter) {
                    shield._activationTime = 0;
                    shield._setActive(false);
                    return;
                }

                if (shield._dialog && !shield._isGreeter) shield._dialog.popModal();

                if (shield._grab) {
                    Main.popModal(shield._grab);
                    shield._grab = null;
                }

                shield._longLightbox.lightOff();
                shield._shortLightbox.lightOff();
                shield._lockDialogGroup.translation_y = -global.screen_height;
                shield._completeDeactivate();
            } else {
                this._origContinueDeactivate(animate);
            }
        };

        dialog._notificationsBox.connectObject(
            'notify::height', () => {
                this._positionHint();
                this._notifManager.positionOverflow();
            },
            'notify::visible', () => {
                this._positionHint();
                this._notifManager.positionOverflow();
            },
            this
        );

        // ── Clock Setup & Constraint-based Centering ──────────────────────
        dialog._stack.remove_child(dialog._clock);
        dialog._clock = new WackClock();
        lockDialogGroup.add_child(dialog._clock);

        const dateLabel = dialog._clock._dateOutput;
        const timeLabel = dialog._clock._time;
        dialog._clock.remove_child(dateLabel);
        dialog._clock.remove_child(timeLabel);

        this._clockWrapper = new Clutter.Actor();
        this._clockWrapper.set_pivot_point(0.5, 0.5);
        this._clockWrapper.add_child(dateLabel);
        this._clockWrapper.add_child(timeLabel);
        lockDialogGroup.add_child(this._clockWrapper);

        this._dateLabel = dateLabel;
        this._timeLabel = timeLabel;

        timeLabel.connectObject('notify::text', () => this._positionClock(), this);
        // Allocation changes are now handled cleanly by Clutter constraints
        timeLabel.connectObject('notify::allocation', () => this._centerClockLabel(timeLabel), this);
        dateLabel.connectObject('notify::allocation', () => this._centerClockLabel(dateLabel), this);

        this._positionClock();

        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        const syncAlpha = () => this._updateClockAlpha();
        this._bgSettings.connectObject(
            'changed::picture-uri', syncAlpha,
            'changed::picture-uri-dark', syncAlpha,
            'changed::picture-options', syncAlpha,
            this
        );
        this._interfaceSettings.connectObject(
            'changed::color-scheme', syncAlpha,
            this
        );

        this._updateClockAlpha();

        // ── Hint Container Setup ──────────────────────────────────────────
        this._hintContainer = new Clutter.Actor();
        lockDialogGroup.add_child(this._hintContainer);

        const hint = dialog._clock._hint;
        this._hintContainer.add_child(hint);
        this._hint = hint;
        this._hintText = hint.text;

        hint.connectObject(
            'notify::text', () => {
                if (!this._overflowActive && !this._showingInhibitHint) {
                    this._hintText = hint.text;
                }
            },
            'notify::opacity', () => {
                const hasNotifs = this._notifManager.hasVisibleNotifs();
                const suppressHint = this._promptActive || (this._lockscreenMode === 'cupertino' && !hasNotifs && !this._overflowActive);
                if (suppressHint && hint.opacity > 0) {
                    hint.remove_all_transitions();
                    hint.set_opacity(0);
                }
            },
            this
        );
        this._positionHint();

        this._overflowLabel = new St.Label({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 255,
            visible: false,
        });
        this._overflowActive = false;
        this._hintContainer.add_child(this._overflowLabel);

        this._notifManager.setupNotifBlur(dialog._notificationsBox);
        this._promptActor = dialog._promptBox ?? dialog._stack;
        this._promptActor?.set_pivot_point(0.5, 0.5);

        // ── Input Handling ────────────────────────────────────────────────
        dialog.connectObject('key-press-event', (actor, event) => {
            const keysym = event.get_key_symbol();

            if (keysym === Clutter.KEY_Escape && !this._promptActive) {
                if (this._escToSleep) {
                    if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser) {
                        if (this._cupertinoShowNotifsOverride) {
                            this._cupertinoShowNotifsOverride = false;
                            this._updateCupertinoRestState(true);
                            return Clutter.EVENT_STOP;
                        }
                    }
                    if (Main.screenShield._loginManager) {
                        if (this._isSleepInhibited()) {
                            this._showInhibitHint(this.gettext('Sleep prevented by an active process'));
                        } else {
                            Main.screenShield._loginManager.suspend();
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser && !this._promptActive) {
                const state = event.get_state();
                const shiftPressed = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

                if (shiftPressed && (keysym === Clutter.KEY_N || keysym === Clutter.KEY_n)) {
                    if (this._notifManager.getNativeNotifCount() > 0 || this._cupertinoShowNotifsOverride) {
                        this._cupertinoHintIsToggle = false;
                        this._cupertinoShowNotifsOverride = !this._cupertinoShowNotifsOverride;
                        this._updateCupertinoRestState(true);
                    }
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);

        this._applyPromptModeLayout();

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
            this._notifManager.positionOverflow();
            this._applyPromptModeLayout();
        }, this);

        // ── Core Transition Logic Intercept ───────────────────────────────
        this._origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this._origSetTransitionProgress(progress);

            // Unified state derivation: no more redundant assignments
            const isNowActive = this._promptActive;

            if (isNowActive && !this._wasPromptActive) {
                this._onPromptShow();
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try { dialog._showPrompt(); }
                finally { dialog._adjustment.ease = origEase; }
            } else if (!isNowActive && this._wasPromptActive) {
                this._onPromptHide();
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try { dialog._showClock(); }
                finally { dialog._adjustment.ease = origEase; }
            }
            this._wasPromptActive = isNowActive;

            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const isCupertino = this._lockscreenMode === 'cupertino';
            const globalBlur = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress;
            const globalBrightness = isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;

            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect) effect.set({ radius: globalBlur, brightness: globalBrightness });
            }

            const hasNotifs = this._notifManager.hasVisibleNotifs();
            const cardBlur = hasNotifs ? NOTIF_BLUR_RADIUS * (1 - progress) : 0;

            if (this._notifManager._notifBox && this._notifManager._notifBox._notificationBox) {
                for (let child = this._notifManager._notifBox._notificationBox.get_first_child(); child !== null; child = child.get_next_sibling()) {
                    let effect = child.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                }
                for (const msg of this._notifManager._notifBox._players.values()) {
                    let effect = msg.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                }
            }

            const notifOpacity = hasNotifs ? Math.round(255 * (1 - progress)) : 0;

            if (this._hintContainer) {
                this._hintContainer.opacity = isCupertino ? notifOpacity : (progress > 0 ? 0 : 255);
            }

            if (isCupertino) {
                const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
                const mainBox = authPrompt?._mainBox;

                if (this._cupertinoRestPromptContainer) {
                    if (hasNotifs && progress === 0) {
                        this._cupertinoRestPromptContainer.opacity = 0;
                        this._cupertinoRestPromptContainer.visible = false;
                    } else {
                        const targetOpacity = hasNotifs ? Math.round(255 * progress) : 255;
                        this._cupertinoRestPromptContainer.opacity = targetOpacity;
                        this._cupertinoRestPromptContainer.visible = targetOpacity > 0;
                        const subOpacity = Math.round(255 * (1 - progress));
                        if (this._cupertinoRestPrompt?._hintBoxWrapper) {
                            this._cupertinoRestPrompt._hintBoxWrapper.opacity = subOpacity;
                        }
                        const nameLabel = this._cupertinoRestPrompt?._userWell?.get_child()?._label;
                        if (nameLabel) nameLabel.opacity = subOpacity;
                    }
                }

                if (this._cupertinoRestPrompt?._avatarButton) {
                    const shouldBeClickable = progress > 0;
                    if (shouldBeClickable) {
                        this._cupertinoRestPrompt._avatarButton.add_style_class_name('wack-avatar-clickable');
                    } else {
                        this._cupertinoRestPrompt._avatarButton.remove_style_class_name('wack-avatar-clickable');
                    }
                    this._cupertinoRestPrompt._avatarButton.reactive = shouldBeClickable;
                    if (!shouldBeClickable) this._cupertinoRestPrompt._avatarButton.hover = false;
                }

                if (this._promptActor) {
                    this._promptActor.set({ opacity: Math.round(255 * progress), scale_x: 1, scale_y: 1, translation_y: 0 });
                    this._promptActor.visible = progress > 0;
                }

                if (mainBox) mainBox.opacity = Math.round(255 * progress);

                if (this._notifManager._notifBox) {
                    this._notifManager._notifBox.opacity = notifOpacity;
                    this._notifManager._notifBox.visible = notifOpacity > 0;
                }

                if (progress === 0) {
                    this._notifManager.enforceCardLimit(this._notifManager._notifBox);
                    this._updateCupertinoRestState();
                }
            } else {
                applyClockAnimation(this._clockAnimation, this._clockWrapper, dialog._clock, progress, this._getClockAnimationParams(), this._animationState);
                applyPromptAnimation(this._promptAnimation, this._promptActor, progress);

                if (this._notifManager._notifBox) this._notifManager._notifBox.opacity = 255;
                if (progress === 0) this._notifManager.enforceCardLimit(this._notifManager._notifBox);
            }
        };

        const mainBox = dialog.get_child_at_index(dialog.get_n_children() - 1);
        if (mainBox) {
            this._origLayout = mainBox.layout_manager;
            mainBox.layout_manager = new WackLayout(this, dialog._stack, dialog._notificationsBox, dialog._otherUserButton);
            mainBox.queue_relayout();
            this._mainBox = mainBox;
        }
    }

    _updateClockAlpha() {
        const dialog = this._dialog;
        if (!dialog || !dialog._clock || typeof dialog._clock.setWallpaperAlpha !== 'function')
            return;

        try {
            if (!this._bgSettings)
                this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            if (!this._interfaceSettings)
                this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

            const colorScheme = this._interfaceSettings.get_enum('color-scheme');
            const style = this._bgSettings.get_enum('picture-options');
            const uri = this._bgSettings.get_string(
                colorScheme === 1
                    ? 'picture-uri-dark'
                    : 'picture-uri'
            );
            const isColor = (style === 0);
            const primaryColor = this._bgSettings.get_string('primary-color');
            const secondaryColor = this._bgSettings.get_string('secondary-color');
            const shadingType = this._bgSettings.get_enum('color-shading-type');

            const textLuminance = dialog._clock.getTextLuminance();
            getWallpaperAlpha({
                uri,
                isColor,
                primaryColor,
                secondaryColor,
                shadingType,
                textLuminance,
            }).then(alpha => {
                if (dialog._clock && typeof dialog._clock.setWallpaperAlpha === 'function')
                    dialog._clock.setWallpaperAlpha(alpha);
            }).catch(e => {
                console.error(`[WACK/Extension] Failed to get wallpaper alpha: ${e}`);
            });
        } catch (e) {
            console.error(`[WACK/Extension] Failed to update clock alpha: ${e}`);
        }
    }

    _loadSettings() {
        this._notifShowInLockScreen = true;
        this._notifSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._notifShowInLockScreen = this._notifSettings.get_boolean('show-in-lock-screen');
        this._notifSettings.connectObject('changed::show-in-lock-screen', () => {
            this._notifShowInLockScreen = this._notifSettings.get_boolean('show-in-lock-screen');
        }, this);

        this._settings = this.getSettings();

        const syncClockAnimation = () => {
            this._clockAnimation = getAnimationSetting(this._settings, 'clock-animation', DEFAULT_CLOCK_ANIMATION, CLOCK_ANIMATIONS);
        };
        const syncPromptAnimation = () => {
            this._promptAnimation = getAnimationSetting(this._settings, 'prompt-animation', DEFAULT_PROMPT_ANIMATION, PROMPT_ANIMATIONS);
        };
        const syncLockscreenMode = () => {
            this._lockscreenMode = this._settings.get_string('lockscreen-mode') ?? 'wack';
            this._applyPromptModeLayout?.();
            this._dialog?._updateUserSwitchVisibility?.();
            this._cupertinoShowNotifsOverride = false;

            const progress = this._dialog?._adjustment?.value ?? 0;
            const isCupertino = this._lockscreenMode === 'cupertino';
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const targetRadius = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress;
            const targetBrightness = isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;

            for (const widget of this._dialog?._backgroundGroup ?? []) {
                const effect = widget.get_effect('blur');
                if (effect) effect.set({ radius: targetRadius, brightness: targetBrightness });
            }

            if (this._notifManager._notifBox) {
                this._notifManager._notifBox.opacity = isCupertino ? Math.round(255 * (1 - progress)) : 255;
            }
            if (this._hintContainer) {
                this._hintContainer.opacity = isCupertino ? Math.round(255 * (1 - progress)) : (progress > 0 ? 0 : 255);
            }
        };

        syncClockAnimation();
        syncPromptAnimation();
        syncLockscreenMode();

        const syncCupertinoAlwaysShowUser = () => {
            this._cupertinoAlwaysShowUser = this._settings.get_boolean('cupertino-always-show-user');
            this._cupertinoShowNotifsOverride = false;
            this._updateCupertinoRestState?.(true);
        };
        syncCupertinoAlwaysShowUser();

        const syncEscToSleep = () => {
            this._escToSleep = this._settings.get_boolean('esc-to-sleep');
        };
        syncEscToSleep();

        const syncCupertinoUnlockFade = () => {
            this._cupertinoUnlockFade = this._settings.get_boolean('cupertino-unlock-fade');
        };
        syncCupertinoUnlockFade();

        this._settings.connectObject(
            'changed::clock-animation', syncClockAnimation,
            'changed::prompt-animation', syncPromptAnimation,
            'changed::lockscreen-mode', syncLockscreenMode,
            'changed::cupertino-always-show-user', syncCupertinoAlwaysShowUser,
            'changed::esc-to-sleep', syncEscToSleep,
            'changed::cupertino-unlock-fade', syncCupertinoUnlockFade,
            this
        );
    }

    _getClockAnimationParams() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorY = monitor ? monitor.y / scaleFactor : 0;
        const clockY = this._clockWrapper?.y ?? 0;
        const [, natHeight] = this._clockWrapper?.get_preferred_height(-1) ?? [0, 0];
        const [, dateHeight] = this._dateLabel?.get_preferred_height(-1) ?? [0, DATE_LABEL_HEIGHT];
        const [, timeHeight] = this._timeLabel?.get_preferred_height(-1) ?? [0, TIME_LABEL_HEIGHT_FALLBACK];
        const clockHeight = Math.max(natHeight, dateHeight + timeHeight, DATE_LABEL_HEIGHT + timeHeight);

        return {
            fadeOutScale: FADE_OUT_SCALE,
            slideUpDistance: Math.ceil(Math.max(128, clockY - monitorY + clockHeight + 48)),
        };
    }

    _idleAdd(priority, callback) {
        let id = GLib.idle_add(priority, () => {
            let result;
            try {
                result = callback();
            } catch (e) {
                this._idleSources.delete(id);
                throw e;
            }
            if (result !== GLib.SOURCE_CONTINUE) this._idleSources.delete(id);
            return result;
        });
        this._idleSources.add(id);
        return id;
    }

    // ── Side Effects Only: State is derived via getter ────────────────────
    _onPromptShow() {
        const isCupertino = this._lockscreenMode === 'cupertino';
        if (isCupertino) {
            this._promptActor?.remove_style_class_name('wack-cupertino-rest');
            this._promptActor?.add_style_class_name('wack-cupertino-prompt');
            this._cupertinoToPrompt = true;
            this._setupCupertinoAvatarOverride();
        }
    }

    _onPromptHide() {
        if (this._notifManager._notifBox) {
            this._notifManager.enforceCardLimit(this._notifManager._notifBox);
        }
        this._updateCupertinoRestState();

        if (this._lockscreenMode === 'cupertino') {
            const hasNotifs = this._notifManager.hasVisibleNotifs();
            this._cupertinoIconSnap = !hasNotifs;
            this._cupertinoToPrompt = false;
        }
    }

    _updateCupertinoRestState(animate = false) {
        if (this._lockscreenMode !== 'cupertino') return;
        const hasNotifs = this._notifManager.hasVisibleNotifs();

        if (this._cupertinoRestPromptContainer) {
            if (this._cupertinoRestPrompt?._avatarButton) {
                this._cupertinoRestPrompt._avatarButton.reactive = this._promptActive;
                if (!this._promptActive) this._cupertinoRestPrompt._avatarButton.hover = false;
            }

            const count = this._notifManager.getNativeNotifCount();
            let nextCount = 0;
            if (this._cupertinoAlwaysShowUser && count > 0 && !this._cupertinoShowNotifsOverride) {
                if (!this._cupertinoHintIsToggle) nextCount = count;
            }

            if (hasNotifs) {
                const targetOpacity = 0;
                if (animate) {
                    const restPromptContainer = this._cupertinoRestPromptContainer;
                    restPromptContainer.visible = true;
                    restPromptContainer.ease({
                        opacity: targetOpacity,
                        duration: CROSSFADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            if (this._cupertinoRestPromptContainer === restPromptContainer) {
                                restPromptContainer.visible = false;
                            }
                        },
                    });
                } else {
                    this._cupertinoRestPromptContainer.remove_all_transitions();
                    this._cupertinoRestPromptContainer.opacity = 0;
                    this._cupertinoRestPromptContainer.visible = false;
                }
            } else {
                this._cupertinoRestPrompt?.setNotifCount(nextCount);
                const hintBoxWrapper = this._cupertinoRestPrompt?._hintBoxWrapper;
                const nameLabel = this._cupertinoRestPrompt?._userWell?.get_child()?._label;

                if (animate && !this._promptActive) {
                    this._cupertinoRestPromptContainer.remove_all_transitions();
                    this._cupertinoRestPromptContainer.opacity = 0;
                    this._cupertinoRestPromptContainer.visible = true;
                    if (hintBoxWrapper) { hintBoxWrapper.remove_all_transitions(); hintBoxWrapper.opacity = 255; }
                    if (nameLabel) { nameLabel.remove_all_transitions(); nameLabel.opacity = 255; }
                    this._cupertinoRestPromptContainer.ease({
                        opacity: 255,
                        duration: CROSSFADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    this._cupertinoRestPromptContainer.remove_all_transitions();
                    this._cupertinoRestPromptContainer.opacity = 255;
                    this._cupertinoRestPromptContainer.visible = true;
                    if (!this._promptActive) {
                        if (hintBoxWrapper) { hintBoxWrapper.remove_all_transitions(); hintBoxWrapper.opacity = 255; }
                        if (nameLabel) { nameLabel.remove_all_transitions(); nameLabel.opacity = 255; }
                    }
                }
            }
        }

        if (this._notifManager._notifBox) {
            const targetOpacity = (!this._promptActive && hasNotifs) ? 255 : 0;
            const targetBlur = (!this._promptActive && hasNotifs) ? NOTIF_BLUR_RADIUS : 0;

            if (animate) {
                const notifBox = this._notifManager._notifBox;
                if (targetOpacity > 0) notifBox.visible = true;
                notifBox.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._notifManager._notifBox === notifBox) notifBox.visible = targetOpacity > 0;
                    },
                });

                const easeBlur = (actor) => {
                    const effect = actor.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set_enabled(true);
                        actor.ease_property(`@effects.${NOTIF_BLUR_NAME}.radius`, targetBlur, {
                            duration: CROSSFADE_TIME,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                };
                notifBox._notificationBox.get_children().forEach(easeBlur);
                for (const actor of notifBox._players.values()) easeBlur(actor);
            } else {
                this._notifManager._notifBox.remove_all_transitions();
                this._notifManager._notifBox.opacity = targetOpacity;
                this._notifManager._notifBox.visible = targetOpacity > 0;

                const setBlur = (actor) => {
                    const effect = actor.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        actor.remove_transition(`@effects.${NOTIF_BLUR_NAME}.radius`);
                        effect.set({ radius: targetBlur });
                        effect.set_enabled(targetBlur > 0.5);
                    }
                };
                this._notifManager._notifBox._notificationBox.get_children().forEach(setBlur);
                for (const actor of this._notifManager._notifBox._players.values()) setBlur(actor);
            }
        }

        if (this._hintContainer) {
            const targetHintOpacity = (!this._promptActive && hasNotifs) ? 255 : 0;
            if (animate) {
                this._hintContainer.ease({ opacity: targetHintOpacity, duration: CROSSFADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            } else {
                this._hintContainer.remove_all_transitions();
                this._hintContainer.opacity = targetHintOpacity;
            }
        }

        this._updateCupertinoHintCycle();
    }

    _setupCupertinoAvatarOverride() {
        if (this._cupertinoAvatarSetup) return;
        const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
        if (!authPrompt) return;
        this._cupertinoAvatarSetup = true;

        if (!this._cupertinoOrigUpdateUser) {
            const methodName = authPrompt.setUser ? 'setUser' : 'updateUser';
            this._cupertinoOrigMethodName = methodName;
            this._cupertinoOrigUpdateUser = authPrompt[methodName].bind(authPrompt);
            authPrompt[methodName] = (user) => {
                this._cupertinoOrigUpdateUser(user);
                const uw = authPrompt._userWell?.get_child();
                if (uw && uw._avatar) {
                    uw._avatar.visible = true;
                    uw._avatar.opacity = 0;
                }
            };
            const promptUserWidget = authPrompt._userWell?.get_child();
            if (promptUserWidget?._avatar) {
                promptUserWidget._avatar.visible = true;
                promptUserWidget._avatar.opacity = 0;
            }
        }

        authPrompt.connectObject('destroy', () => this._teardownCupertinoAvatarOverride(), this);
    }

    _teardownCupertinoAvatarOverride() {
        const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
        if (authPrompt) authPrompt.disconnectObject(this);

        if (authPrompt && this._cupertinoOrigUpdateUser && this._cupertinoOrigMethodName) {
            authPrompt[this._cupertinoOrigMethodName] = this._cupertinoOrigUpdateUser;
        }
        this._cupertinoOrigUpdateUser = null;
        this._cupertinoOrigMethodName = null;

        const promptUserWidget = authPrompt?._userWell?.get_child();
        if (promptUserWidget?._avatar) {
            promptUserWidget._avatar.visible = true;
            promptUserWidget._avatar.opacity = 255;
        }
        this._cupertinoAvatarSetup = false;
    }

    _applyPromptModeLayout() {
        if (!this._promptActor) return;
        const isCupertino = this._lockscreenMode === 'cupertino';

        if (isCupertino) {
            this._createCupertinoRestPrompt();
            this._promptActor.remove_style_class_name('wack-cupertino-rest');
            this._promptActor.add_style_class_name('wack-cupertino-prompt');
            if (this._origPromptActorYAlign === undefined) {
                this._origPromptActorYAlign = this._promptActor.y_align;
            }
            this._promptActor.y_align = Clutter.ActorAlign.START;
        } else {
            this._destroyCupertinoRestPrompt();
            this._promptActor.remove_style_class_name('wack-cupertino-prompt');
            this._promptActor.remove_style_class_name('wack-cupertino-rest');
            if (this._origPromptActorYAlign !== undefined) {
                this._promptActor.y_align = this._origPromptActorYAlign;
                this._origPromptActorYAlign = undefined;
            }
        }
        this._promptActor.set({ scale_x: 1, scale_y: 1 });
        this._updateCupertinoRestState();
        this._mainBox?.queue_relayout();
    }

    triggerSwitchUser() {
        if (this._lockscreenMode !== 'cupertino') return;

        try {
            Gdm.goto_login_session_sync(null);
        } catch (e) {
            _logError(`WACK lockscreen: failed to switch user: ${e.message}`);
        }
    }

    triggerToggleNotifications() {
        if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser && !this._promptActive) {
            if (this._notifManager.getNativeNotifCount() > 0 || this._cupertinoShowNotifsOverride) {
                this._cupertinoHintIsToggle = false;
                this._cupertinoShowNotifsOverride = !this._cupertinoShowNotifsOverride;
                this._updateCupertinoRestState(true);
            }
        }
    }

    _createCupertinoRestPrompt() {
        if (this._cupertinoRestPromptContainer) return;

        this._cupertinoRestPromptContainer = new St.BoxLayout({
            style_class: 'wack-cupertino-rest',
            vertical: true,
            reactive: false,
        });

        this._cupertinoRestPrompt = new WackCupertinoRestPrompt(this._dialog._user, this);
        this._cupertinoRestPromptContainer.add_child(this._cupertinoRestPrompt);
        this._dialog._stack.add_child(this._cupertinoRestPromptContainer);

        if (!this._cupertinoSeat) {
            const backend = this.get_context?.().get_backend() ?? Clutter.get_default_backend();
            this._cupertinoSeat = backend.get_default_seat();
            this._cupertinoSeat.connectObject('notify::touch-mode', () => this._syncCupertinoHint(), this);
        }
        this._syncCupertinoHint();
    }

    _syncCupertinoHint() {
        const touchMode = this._cupertinoSeat?.touch_mode ?? false;
        this._cupertinoBaseHintText = touchMode
            ? shellGettext('Swipe up to unlock')
            : shellGettext('Click or press a key to unlock');
        this._cupertinoToggleHintText = this.gettext('Press Shift + N to view notifications');
        this._updateCupertinoHintCycle();
    }

    _showInhibitHint(message) {
        if (this._inhibitHintTimeoutId) {
            GLib.source_remove(this._inhibitHintTimeoutId);
            this._inhibitHintTimeoutId = null;
        }

        const wackActor = this._overflowActive ? this._overflowLabel : this._hint;
        const cupertinoActor = (this._lockscreenMode === 'cupertino' && this._cupertinoRestPrompt)
            ? this._cupertinoRestPrompt._hintBox : null;

        this._showingInhibitHint = true;

        if (this._lockscreenMode === 'cupertino' && this._cupertinoHintCycleId) {
            GLib.source_remove(this._cupertinoHintCycleId);
            this._cupertinoHintCycleId = null;
        }

        wackActor?.remove_all_transitions();
        cupertinoActor?.remove_all_transitions();

        if (wackActor) {
            wackActor.opacity = 255;
            wackActor.visible = true;
            if (this._overflowActive) {
                const prefix = wackActor.text.split('  ·  ')[0];
                wackActor.text = `${prefix}  ·  ${message}`;
                this._notifManager.positionOverflow();
            } else {
                wackActor.text = message;
                this._positionHint();
            }
        }

        if (this._cupertinoRestPrompt) {
            if (cupertinoActor) {
                cupertinoActor.opacity = 255;
                cupertinoActor.visible = true;
            }
            this._cupertinoRestPrompt.setHintText(message);
            this._cupertinoRestPrompt.setNotifCount(0);
        }

        this._inhibitHintTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._showingInhibitHint = false;
            this._inhibitHintTimeoutId = null;

            wackActor?.remove_all_transitions();
            cupertinoActor?.remove_all_transitions();

            const fadeOutDuration = 150;
            const fadeInDuration = 150;

            if (wackActor) {
                wackActor.ease({
                    opacity: 0,
                    duration: fadeOutDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._overflowActive) {
                            this._notifManager.enforceCardLimit(this._dialog._notificationsBox);
                        } else {
                            wackActor.text = this._hintText;
                            this._positionHint();
                        }
                        wackActor.ease({ opacity: 255, duration: fadeInDuration, mode: Clutter.AnimationMode.EASE_IN_QUAD });
                    }
                });
            }

            if (cupertinoActor) {
                cupertinoActor.ease({
                    opacity: 0,
                    duration: fadeOutDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._cupertinoRestPrompt) {
                            this._cupertinoHintIsToggle = false;
                            const nativeCount = this._notifManager.getNativeNotifCount();
                            const count = (this._cupertinoAlwaysShowUser && !this._cupertinoShowNotifsOverride) ? nativeCount : 0;
                            const baseText = this._cupertinoShowNotifsOverride
                                ? shellGettext('Swipe up to unlock')
                                : shellGettext('Click or press a key to unlock');

                            this._cupertinoRestPrompt.setHintText(baseText);
                            this._cupertinoRestPrompt.setNotifCount(count);
                        }
                        cupertinoActor.ease({
                            opacity: 255,
                            duration: fadeInDuration,
                            mode: Clutter.AnimationMode.EASE_IN_QUAD,
                            onComplete: () => this._updateCupertinoHintCycle()
                        });
                    }
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _isSleepInhibited() {
        try {
            const result = Gio.DBus.system.call_sync(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'ListInhibitors',
                null, null, Gio.DBusCallFlags.NONE, -1, null
            );
            const [inhibitors] = result.deepUnpack();
            for (const [what, who, why, mode] of inhibitors) {
                if (what.includes('sleep') && mode === 'block') {
                    if (why === 'user-active-inhibitor' ||
                        who === 'gnome-session-binary' ||
                        who === 'gnome-session-service' ||
                        who === 'gnome-session-s' ||
                        who === 'gnome-shell' ||
                        who === 'gsd-power' ||
                        who === 'gsd-media-keys') {
                        continue;
                    }
                    return true;
                }
            }
        } catch (err) {
            // Ignore and assume not inhibited
        }
        return false;
    }

    _updateCupertinoHintCycle() {
        if (!this._cupertinoRestPrompt) return;

        const nativeCount = this._notifManager.getNativeNotifCount();
        const shouldCycle = this._lockscreenMode === 'cupertino' &&
            this._cupertinoAlwaysShowUser &&
            !this._cupertinoShowNotifsOverride &&
            nativeCount > 0 &&
            !this._promptActive;

        if (shouldCycle) {
            if (!this._cupertinoHintCycleId) {
                this._cupertinoHintIsToggle = false;
                this._cupertinoRestPrompt.setHintText(this._cupertinoBaseHintText);

                this._cupertinoHintCycleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                    this._cupertinoHintIsToggle = !this._cupertinoHintIsToggle;
                    const nextText = this._cupertinoHintIsToggle ? this._cupertinoToggleHintText : this._cupertinoBaseHintText;

                    if (this._cupertinoRestPrompt && this._cupertinoRestPrompt._hintBox) {
                        const hintBox = this._cupertinoRestPrompt._hintBox;
                        hintBox.ease({
                            opacity: 0,
                            duration: CROSSFADE_TIME / 2,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onComplete: () => {
                                if (!this._cupertinoRestPrompt) return;
                                this._cupertinoRestPrompt.setHintText(nextText);
                                if (this._cupertinoHintIsToggle) {
                                    this._cupertinoRestPrompt.setNotifCount(0);
                                } else {
                                    this._cupertinoRestPrompt.setNotifCount(this._notifManager.getNativeNotifCount());
                                }
                                hintBox.ease({ opacity: 255, duration: CROSSFADE_TIME / 2, mode: Clutter.AnimationMode.EASE_IN_QUAD });
                            }
                        });
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            if (this._cupertinoHintCycleId) {
                GLib.source_remove(this._cupertinoHintCycleId);
                this._cupertinoHintCycleId = null;
            }
            this._cupertinoHintIsToggle = false;
            if (this._cupertinoRestPrompt && this._cupertinoRestPrompt._hintBox) {
                this._cupertinoRestPrompt._hintBox.remove_all_transitions();
                this._cupertinoRestPrompt._hintBox.opacity = 255;
                if (!this._notifManager.hasVisibleNotifs() && !this._promptActive) {
                    this._cupertinoRestPrompt.setHintText(this._cupertinoBaseHintText || '');
                }
            }
        }
    }

    _destroyCupertinoRestPrompt() {
        if (this._cupertinoHintCycleId) {
            GLib.source_remove(this._cupertinoHintCycleId);
            this._cupertinoHintCycleId = null;
        }
        if (this._cupertinoSeat) {
            this._cupertinoSeat.disconnectObject(this);
            this._cupertinoSeat = null;
        }
        if (this._cupertinoRestPrompt) {
            this._cupertinoRestPrompt.destroy();
            this._cupertinoRestPrompt = null;
        }
        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
        }
    }

    _positionClock() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorX = monitor.x / scaleFactor;
        const monitorY = monitor.y / scaleFactor;
        const monitorWidth = monitor.width / scaleFactor;
        const monitorHeight = monitor.height / scaleFactor;

        const wrapper = this._clockWrapper;
        const dateLabel = this._dateLabel;
        const timeLabel = this._timeLabel;
        if (!wrapper || !dateLabel || !timeLabel) return;

        const topY = monitorY + Math.floor(monitorHeight * DATETIME_TOP_FRACTION);

        dateLabel.set_position(0, 0);
        timeLabel.set_position(0, DATE_LABEL_HEIGHT);

        wrapper.set_position(monitorX, topY);
        wrapper.set_width(monitorWidth);
        wrapper.set_pivot_point(0.5, 0.5);

        this._centerClockLabel(dateLabel);
        this._centerClockLabel(timeLabel);
    }

    // ── Modernized: Constraint-based Centering ────────────────────────────
    _centerClockLabel(label) {
        if (!label || !this._clockWrapper) return;
        const constraintName = 'wack-clock-center-x';
        const oldConstraint = label.get_constraint(constraintName);
        if (oldConstraint) {
            label.remove_constraint(constraintName);
        }
        label.add_constraint(new Clutter.AlignConstraint({
            name: constraintName,
            source: this._clockWrapper,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
    }

    _positionHint() {
        if (!this._hint) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorX = monitor.x / scaleFactor;
        const monitorY = monitor.y / scaleFactor;
        const monitorWidth = monitor.width / scaleFactor;
        const monitorHeight = monitor.height / scaleFactor;

        this._hint.set_width(-1);
        const [, natWidth] = this._hint.get_preferred_width(-1);
        const [, natHeight] = this._hint.get_preferred_height(-1);

        const notifBox = this._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitorY + Math.floor(monitorHeight * HINT_VERTICAL_FRACTION);
        const notifTop = monitorY + monitorHeight - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);

        const x = monitorX + Math.floor((monitorWidth - natWidth) / 2);
        this._hint.set_position(x, y);
        this._hint.set_width(natWidth);
    }

    _tempSessionModeOverride() {
        if (this._origSessionModeProps) return;
        this._origSessionModeProps = {
            hasWindows: Main.sessionMode.hasWindows,
            hasWorkspaces: Main.sessionMode.hasWorkspaces,
            panel: Main.sessionMode.panel,
            panelStyle: Main.sessionMode.panelStyle,
        };
        Main.sessionMode.hasWindows = true;
        Main.sessionMode.hasWorkspaces = true;
        Main.sessionMode.panel = {
            left: ['activities'],
            center: ['dateMenu'],
            right: ['screenRecording', 'screenSharing', 'dwellClick', 'a11y', 'keyboard', 'quickSettings'],
        };
        Main.sessionMode.panelStyle = null;
        Main.sessionMode.emit('updated');
    }

    _restoreSessionMode() {
        if (!this._origSessionModeProps) return;
        Main.sessionMode.hasWindows = this._origSessionModeProps.hasWindows;
        Main.sessionMode.hasWorkspaces = this._origSessionModeProps.hasWorkspaces;
        Main.sessionMode.panel = this._origSessionModeProps.panel;
        Main.sessionMode.panelStyle = this._origSessionModeProps.panelStyle;
        this._origSessionModeProps = null;
        Main.sessionMode.emit('updated');
    }


    _getUserThemeFile() {
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const enabledExtensions = shellSettings.get_strv('enabled-extensions');
        if (!enabledExtensions.includes('user-theme@gnome-shell-extensions.gcampax.github.com')) {
            return null;
        }
        const schemaSource = Gio.SettingsSchemaSource.get_default();
        if (!schemaSource) return null;
        const schema = schemaSource.lookup('org.gnome.shell.extensions.user-theme', true);
        if (!schema) return null;

        const themeSettings = new Gio.Settings({ settings_schema: schema });
        const themeName = themeSettings.get_string('name');
        if (!themeName) return null;

        const paths = [
            GLib.build_filenamev([GLib.get_home_dir(), '.themes', themeName, 'gnome-shell', 'gnome-shell.css']),
            GLib.build_filenamev([GLib.get_user_data_dir(), 'themes', themeName, 'gnome-shell', 'gnome-shell.css']),
            GLib.build_filenamev(['/usr/share/themes', themeName, 'gnome-shell', 'gnome-shell.css'])
        ];

        for (const path of paths) {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) return file;
        }
        return null;
    }

    // Guideline EGO-M-008: Documenting use of unlock-dialog.
    // This extension runs in the 'unlock-dialog' session mode to customize the
    // GNOME Shell lock screen. We perform the following modifications:
    // - Replace the default clock widget (dialog._clock) with our custom clock
    //   wrapper to display a macOS Sonoma-style clock layout.
    // - Override dialog._updateBackgroundEffects to customize background blur.
    // - Override dialog._updateUserSwitchVisibility to hide/show user options.
    // - Intercept dialog.finish to animate custom transitions when unlocking.
    //
    // In this disable() method, we cleanly revert all changes, restore all overridden
    // methods/injections to their original implementations, and destroy/nullify all
    // custom UI elements, ensuring no resource leaks or state contamination in the
    // GNOME Shell session.
    disable() {
        if (this._gdmManager) {
            this._gdmManager.disable();
            this._gdmManager = null;
        }

        if (this._wackShellStateChangedId) {
            Main.extensionManager.disconnect(this._wackShellStateChangedId);
            this._wackShellStateChangedId = null;
        }

        if (this._crossSessionManager) {
            this._crossSessionManager.disable();
            this._crossSessionManager = null;
        }

        if (this._bgSettings) {
            this._bgSettings.disconnectObject(this);
            this._bgSettings = null;
        }

        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }

        clearCache();

        if (this._dialog && this._origFinish) {
            this._dialog.finish = this._origFinish;
            this._origFinish = null;
        }

        if (this._origStylesheet !== undefined) {
            if (Main.sessionMode.currentMode !== 'user') {
                Main.setThemeStylesheet(this._origStylesheet ? this._origStylesheet.get_path() : null);
                Main.loadTheme();
            }
            this._origStylesheet = undefined;
        }

        if (this._origContinueDeactivate) {
            if (Main.screenShield) Main.screenShield._continueDeactivate = this._origContinueDeactivate;
            this._origContinueDeactivate = null;
        }

        if (this._finishTimeoutId) {
            GLib.source_remove(this._finishTimeoutId);
            this._finishTimeoutId = null;
        }

        if (this._windowFadeContainer) {
            this._windowFadeContainer.destroy();
            this._windowFadeContainer = null;
        }

        if (this._origSessionModeProps) {
            Main.sessionMode.panel = this._origSessionModeProps.panel;
            Main.sessionMode.panelStyle = this._origSessionModeProps.panelStyle;
            this._origSessionModeProps = null;
            Main.sessionMode.emit('updated');
        }

        if (Main.panel) {
            Main.panel.remove_all_transitions();
            Main.panel.translation_y = 0;
            Main.panel.opacity = 255;
        }

        if (this._unblankManager) {
            this._unblankManager.destroy();
            this._unblankManager = null;
        }

        if (Main.panel?.statusArea?.dateMenu?.container) {
            if (this._wasDateMenuVisible) Main.panel.statusArea.dateMenu.container.show();
            this._wasDateMenuVisible = null;
        }

        if (this._idleSources) {
            for (const id of this._idleSources) GLib.source_remove(id);
            this._idleSources.clear();
        }

        if (this._dialog && this._origUpdateBgEffects) {
            this._dialog._updateBackgroundEffects = this._origUpdateBgEffects;
            this._origUpdateBgEffects = null;
            this._dialog._updateBackgroundEffects();
        }

        if (this._dialog && this._origUpdateUserSwitchVisibility) {
            this._dialog._updateUserSwitchVisibility = this._origUpdateUserSwitchVisibility;
            this._origUpdateUserSwitchVisibility = null;
            this._dialog._updateUserSwitchVisibility();
        }

        if (this._notifManager) {
            this._notifManager.teardownNotifBlur();
            this._notifManager = null;
        }

        if (this._dialog && this._origSetTransitionProgress) {
            this._dialog._setTransitionProgress = this._origSetTransitionProgress;
            this._origSetTransitionProgress = null;
        }

        if (this._inhibitHintTimeoutId) {
            GLib.source_remove(this._inhibitHintTimeoutId);
            this._inhibitHintTimeoutId = null;
        }

        this._teardownCupertinoAvatarOverride();
        if (this._cupertinoHintCycleId) {
            GLib.source_remove(this._cupertinoHintCycleId);
            this._cupertinoHintCycleId = null;
        }
        this._destroyCupertinoRestPrompt();

        resetAnimationActors(this._clockWrapper, this._promptActor);
        const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
        const mainBox = authPrompt?._mainBox;
        if (mainBox) mainBox.opacity = 255;
        if (this._dialog) this._dialog.opacity = 255;

        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }

        if (this._notifSettings) {
            this._notifSettings.disconnectObject(this);
            this._notifSettings = null;
        }
        this._notifShowInLockScreen = false;

        this._injectionManager?.clear();
        this._injectionManager = null;

        if (this._dialog) {
            this._dialog._notificationsBox?.disconnectObject(this);
            this._dialog.disconnectObject(this);
        }
        Main.layoutManager.disconnectObject(this);

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        if (this._hint) {
            this._hint.disconnectObject(this);
            this._hint.visible = true;
            this._hint = null;
        }

        if (this._overflowLabel) {
            this._overflowLabel.destroy();
            this._overflowLabel = null;
        }

        if (this._hintContainer) {
            lockDialogGroup?.remove_child(this._hintContainer);
            this._hintContainer.destroy();
            this._hintContainer = null;
        }

        if (this._dateLabel) {
            this._dateLabel.disconnectObject(this);
            this._dateLabel = null;
        }
        if (this._timeLabel) {
            this._timeLabel.disconnectObject(this);
            this._timeLabel = null;
        }
        if (this._clockWrapper) {
            lockDialogGroup?.remove_child(this._clockWrapper);
            this._clockWrapper.destroy();
            this._clockWrapper = null;
        }

        if (this._dialog && this._dialog._clock) {
            lockDialogGroup?.remove_child(this._dialog._clock);
            this._dialog._clock.destroy();
            this._dialog._clock = null;
        }

        if (this._dialog && this._originalClock) {
            this._dialog._clock = this._originalClock;
            this._dialog._stack.add_child(this._originalClock);
        }

        if (this._mainBox && this._origLayout) {
            const oldLayout = this._mainBox.layout_manager;
            this._mainBox.layout_manager = this._origLayout;
            if (oldLayout && oldLayout !== this._origLayout) oldLayout._extension = null;
            this._mainBox.opacity = 255;
            this._mainBox.queue_relayout();
        }

        this._dialog = null;
        this._originalClock = null;
        this._mainBox = null;
        this._origLayout = null;
        this._overflowActive = false;
        this._hintText = null;

        if (this._promptActor && this._origPromptActorYAlign !== undefined) {
            this._promptActor.y_align = this._origPromptActorYAlign;
            this._origPromptActorYAlign = undefined;
        }
        this._promptActor?.remove_style_class_name('wack-cupertino-prompt');
        this._promptActor = null;
        this._animationState = null;
        this._wasPromptActive = false;
    }
}
