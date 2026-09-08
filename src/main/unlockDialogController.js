import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    NOTIF_BLUR_RADIUS,
    NOTIF_BLUR_NAME,
    CUPERTINO_UNLOCK_PANEL_FADE,
    CUPERTINO_UNLOCK_TSO_DELAY,
} from './constants.js';
import { applyClockAnimation, applyPromptAnimation } from './anims.js';
import { _setActorVisible } from './mainUtils.js';

export class UnlockDialogController {
    constructor(extension) {
        this._extension = extension;
        this.origUpdateBgEffects = null;
        this.origUpdateUserSwitchVisibility = null;
        this.origFinish = null;
        this.origContinueDeactivate = null;
        this.origSetTransitionProgress = null;
        this.finishTimeoutId = null;
        this.finishFallbackId = null;
        this.windowFadeContainer = null;
    }

    install(dialog, lockDialogGroup) {
        // 1. Background Effects Override
        if (dialog._updateBackgroundEffects) {
            this.origUpdateBgEffects = dialog._updateBackgroundEffects.bind(dialog);
            dialog._updateBackgroundEffects = () => {
                for (const widget of dialog._backgroundGroup ?? []) {
                    const effect = widget.get_effect('blur');
                    if (effect) effect.set({ brightness: 1.0, radius: 0 });
                }
                if (this._extension._wallpaperManager?.customWallpaperOverlay) {
                    this._extension._wallpaperManager.setCustomWallpaperBlur(0, 1.0);
                }
            };
            dialog._updateBackgroundEffects();
        }

        // 2. User Switch Visibility Override
        this.origUpdateUserSwitchVisibility = dialog._updateUserSwitchVisibility.bind(dialog);
        dialog._updateUserSwitchVisibility = () => {
            this.origUpdateUserSwitchVisibility();
            if (this._extension._lockscreenMode === 'cupertino' && dialog._otherUserButton) {
                dialog._otherUserButton.visible = false;
            }
        };
        dialog._updateUserSwitchVisibility();

        // 3. Finish Intercept for Cupertino Fade-out
        this.origFinish = dialog.finish.bind(dialog);
        dialog.finish = (onComplete) => {
            const isCupertino = this._extension._lockscreenMode === 'cupertino';
            if (isCupertino && this._extension._cupertinoUnlockFade) {
                const capturedSnapshots = global.wack_window_snapshots
                    ? global.wack_window_snapshots.slice()
                    : [];

                const panel = Main.panel;
                if (panel) {
                    panel.ease({ opacity: 0, duration: CUPERTINO_UNLOCK_PANEL_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                }

                if (this.finishTimeoutId) {
                    GLib.source_remove(this.finishTimeoutId);
                    this.finishTimeoutId = null;
                }

                this.finishTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CUPERTINO_UNLOCK_TSO_DELAY, () => {
                    this.finishTimeoutId = null;
                    this._extension._themeManager.tempSessionModeOverride();

                    const duration = this._extension._cupertinoUnlockFadeDuration;
                    const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

                    if (panel) {
                        panel.remove_all_transitions();
                        const panelHeight = panel.height || 60;
                        panel.translation_y = -panelHeight;
                        panel.opacity = 255;
                        panel.ease({ translation_y: 0, duration, mode });
                    }

                    if (capturedSnapshots.length > 0) {
                        this.windowFadeContainer = new Clutter.Actor({
                            width: global.screen_width,
                            height: global.screen_height,
                        });

                        lockDialogGroup.add_child(this.windowFadeContainer);
                        lockDialogGroup.set_child_above_sibling(this.windowFadeContainer, dialog);

                        const STAGGER_MS = 16;
                        capturedSnapshots.forEach((snapshot, index) => {
                            const actor = new Clutter.Actor({
                                content: snapshot.content,
                                x: snapshot.rect.x,
                                y: snapshot.rect.y,
                                width: snapshot.rect.width,
                                height: snapshot.rect.height,
                                opacity: 0,
                            });

                            const w = Math.max(1, snapshot.rect.width);
                            const h = Math.max(1, snapshot.rect.height);
                            const pivotX = (global.screen_width / 2 - snapshot.rect.x) / w;
                            const pivotY = (global.screen_height / 2 - snapshot.rect.y) / h;
                            actor.set_pivot_point(pivotX, pivotY);

                            actor.scale_x = 0.92;
                            actor.scale_y = 0.92;

                            this.windowFadeContainer.add_child(actor);

                            const revIndex = capturedSnapshots.length - 1 - index;
                            const delay = revIndex * STAGGER_MS;

                            actor.ease({
                                scale_x: 1.0,
                                scale_y: 1.0,
                                opacity: 255,
                                duration: duration - delay,
                                delay,
                                mode,
                            });
                        });
                    }

                    const clockWrapper = this._extension._clockLayoutManager?.clockWrapper;
                    const hintContainer = this._extension._clockLayoutManager?.hintContainer;
                    const customOverlay = this._extension._wallpaperManager?.customWallpaperOverlay;
                    const actorsToFade = [clockWrapper, hintContainer, this._extension._mainBox, customOverlay].filter(a => a != null);
                    actorsToFade.forEach(actor => {
                        actor.ease({ opacity: 0, duration, mode });
                    });

                    if (this.finishTimeoutId) {
                        GLib.source_remove(this.finishTimeoutId);
                        this.finishTimeoutId = null;
                    }
                    this.finishTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                        this.finishTimeoutId = null;

                        let called = false;
                        const safeOnComplete = () => {
                            if (called) return;
                            called = true;
                            if (this.finishFallbackId) {
                                GLib.source_remove(this.finishFallbackId);
                                this.finishFallbackId = null;
                            }
                            this._extension._themeManager.restoreSessionMode();
                            if (this.windowFadeContainer) {
                                this.windowFadeContainer.destroy();
                                this.windowFadeContainer = null;
                            }
                            if (this._extension._wallpaperManager?.customWallpaperOverlay) {
                                this._extension._wallpaperManager.customWallpaperOverlay.destroy();
                                this._extension._wallpaperManager.customWallpaperOverlay = null;
                            }
                            global.wack_window_snapshots = [];
                            onComplete();
                        };

                        this.origFinish(safeOnComplete);

                        if (this.finishFallbackId) {
                            GLib.source_remove(this.finishFallbackId);
                            this.finishFallbackId = null;
                        }
                        this.finishFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                            this.finishFallbackId = null;
                            safeOnComplete();
                            return GLib.SOURCE_REMOVE;
                        });

                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this.origFinish(onComplete);
            }
        };

        // 4. Skip Slide-up in Cupertino Mode
        const shield = Main.screenShield;
        this.origContinueDeactivate = shield._continueDeactivate.bind(shield);
        shield._continueDeactivate = (animate) => {
            const isCupertino = this._extension._lockscreenMode === 'cupertino';
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
                this.origContinueDeactivate(animate);
            }
        };

        // 5. NotificationsBox changes tracking
        if (dialog._notificationsBox) {
            dialog._notificationsBox.connectObject(
                'notify::height', () => {
                    this._extension._clockLayoutManager?.positionHint();
                    this._extension._notifManager?.positionOverflow();
                },
                'notify::visible', () => {
                    this._extension._clockLayoutManager?.positionHint();
                    this._extension._notifManager?.positionOverflow();
                },
                this
            );
        }

        // 6. Core Transition Logic Intercept
        this.origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this.origSetTransitionProgress(progress);

            const isNowActive = this._extension._promptActive;

            if (isNowActive && !this._extension._wasPromptActive) {
                this._extension._onPromptShow();
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try { dialog._showPrompt(); }
                finally { dialog._adjustment.ease = origEase; }
            } else if (!isNowActive && this._extension._wasPromptActive) {
                this._extension._onPromptHide();
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try { dialog._showClock(); }
                finally { dialog._adjustment.ease = origEase; }
            }
            this._extension._wasPromptActive = isNowActive;

            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const isCupertino = this._extension._lockscreenMode === 'cupertino';
            const globalBlur = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress;
            const globalBrightness = isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;

            for (const widget of dialog._backgroundGroup ?? []) {
                const effect = widget.get_effect('blur');
                if (effect) effect.set({ radius: globalBlur, brightness: globalBrightness });
            }
            this._extension._wallpaperManager?.setCustomWallpaperBlur(globalBlur, globalBrightness);

            const hasNotifs = this._extension._notifManager.hasVisibleNotifs();
            const cardBlur = hasNotifs ? NOTIF_BLUR_RADIUS * (1 - progress) : 0;

            if (this._extension._notifManager._notifBox && this._extension._notifManager._notifBox._notificationBox) {
                for (let child = this._extension._notifManager._notifBox._notificationBox.get_first_child(); child !== null; child = child.get_next_sibling()) {
                    let effect = child.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                }
                for (const msg of this._extension._notifManager._notifBox._players.values()) {
                    let effect = msg.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                }
            }

            const notifOpacity = hasNotifs ? Math.round(255 * (1 - progress)) : 0;
            const hintContainer = this._extension._clockLayoutManager?.hintContainer;

            if (hintContainer) {
                hintContainer.opacity = isCupertino ? notifOpacity : (progress > 0 ? 0 : 255);
            }

            if (isCupertino) {
                const authPrompt = dialog._authPrompt ?? dialog._promptBox?._authPrompt;
                const mainBox = authPrompt?._mainBox;
                const cupertinoMgr = this._extension._cupertinoPromptManager;

                if (cupertinoMgr?.restPromptContainer) {
                    if (hasNotifs && progress === 0) {
                        cupertinoMgr.restPromptContainer.opacity = 0;
                        cupertinoMgr.restPromptContainer.visible = false;
                    } else {
                        const targetOpacity = hasNotifs ? Math.round(255 * progress) : 255;
                        cupertinoMgr.restPromptContainer.opacity = targetOpacity;
                        cupertinoMgr.restPromptContainer.visible = targetOpacity > 0;
                        const subOpacity = Math.round(255 * (1 - progress));
                        if (cupertinoMgr.restPrompt?._hintBoxWrapper) {
                            cupertinoMgr.restPrompt._hintBoxWrapper.opacity = subOpacity;
                        }
                        const nameLabel = cupertinoMgr.restPrompt?._userWell?.get_child()?._label;
                        if (nameLabel) nameLabel.opacity = subOpacity;
                    }
                }

                if (cupertinoMgr?.restPrompt?._avatarButton) {
                    const shouldBeClickable = progress > 0;
                    if (shouldBeClickable) {
                        cupertinoMgr.restPrompt._avatarButton.add_style_class_name('wack-avatar-clickable');
                    } else {
                        cupertinoMgr.restPrompt._avatarButton.remove_style_class_name('wack-avatar-clickable');
                    }
                    cupertinoMgr.restPrompt._avatarButton.reactive = shouldBeClickable;
                    if (!shouldBeClickable) cupertinoMgr.restPrompt._avatarButton.hover = false;
                }

                if (this._extension._promptActor) {
                    this._extension._promptActor.set({ opacity: Math.round(255 * progress), scale_x: 1, scale_y: 1, translation_y: 0 });
                    this._extension._promptActor.visible = progress > 0;
                }

                if (mainBox) mainBox.opacity = Math.round(255 * progress);

                const messageActor = this._extension._getLockscreenMessageActor();
                const messageManager = this._extension._messageManager;
                const messageLabel = messageManager?.label ?? this._extension._lockscreenMessageLabel;
                if (messageActor && messageLabel) {
                    if (hasNotifs && progress === 0) {
                        _setActorVisible(messageActor, false, 0);
                    } else {
                        const targetOpacity = hasNotifs ? Math.round(255 * progress) : 255;
                        _setActorVisible(messageActor,
                            targetOpacity > 0 && messageLabel.text !== '',
                            targetOpacity);
                    }
                }

                if (this._extension._notifManager._notifBox) {
                    this._extension._notifManager._notifBox.opacity = notifOpacity;
                    this._extension._notifManager._notifBox.visible = notifOpacity > 0;
                }

                if (progress === 0) {
                    this._extension._notifManager.enforceCardLimit(this._extension._notifManager._notifBox);
                    cupertinoMgr?.updateCupertinoRestState();
                }
            } else {
                applyClockAnimation(
                    this._extension._clockAnimation,
                    this._extension._clockLayoutManager?.clockWrapper,
                    dialog._clock,
                    progress,
                    this._extension._getClockAnimationParams(),
                    this._extension._animationState
                );
                applyPromptAnimation(this._extension._promptAnimation, this._extension._promptActor, progress);

                if (this._extension._notifManager._notifBox) this._extension._notifManager._notifBox.opacity = 255;
                if (progress === 0) this._extension._notifManager.enforceCardLimit(this._extension._notifManager._notifBox);
            }
        };
    }

    uninstall(dialog) {
        if (dialog && this.origUpdateBgEffects) {
            dialog._updateBackgroundEffects = this.origUpdateBgEffects;
            this.origUpdateBgEffects = null;
        }

        if (dialog && this.origUpdateUserSwitchVisibility) {
            dialog._updateUserSwitchVisibility = this.origUpdateUserSwitchVisibility;
            this.origUpdateUserSwitchVisibility = null;
        }

        if (dialog && this.origFinish) {
            dialog.finish = this.origFinish;
            this.origFinish = null;
        }

        if (this.origContinueDeactivate) {
            if (Main.screenShield) Main.screenShield._continueDeactivate = this.origContinueDeactivate;
            this.origContinueDeactivate = null;
        }

        if (dialog && this.origSetTransitionProgress) {
            dialog._setTransitionProgress = this.origSetTransitionProgress;
            this.origSetTransitionProgress = null;
        }

        if (dialog?._notificationsBox) {
            dialog._notificationsBox.disconnectObject(this);
        }

        if (this.finishTimeoutId) {
            GLib.source_remove(this.finishTimeoutId);
            this.finishTimeoutId = null;
        }

        if (this.finishFallbackId) {
            GLib.source_remove(this.finishFallbackId);
            this.finishFallbackId = null;
        }

        if (this.windowFadeContainer) {
            this.windowFadeContainer.destroy();
            this.windowFadeContainer = null;
        }
    }
}
