import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gdm from 'gi://Gdm';
import Gettext from 'gettext';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import { CROSSFADE_TIME, NOTIF_BLUR_RADIUS, NOTIF_BLUR_NAME } from './constants.js';
import { _logError, _setActorVisible } from './mainUtils.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));

export class CupertinoPromptManager {
    constructor(extension) {
        this._extension = extension;
        this.restPromptContainer = null;
        this.restPrompt = null;
        this.seat = null;
        this.hintCycleId = null;
        this.inhibitHintTimeoutId = null;
        this.showingInhibitHint = false;
        this.hintIsToggle = false;
        this.baseHintText = '';
        this.toggleHintText = '';
    }

    triggerSwitchUser() {
        if (this._extension._lockscreenMode !== 'cupertino') return;
        try {
            Gdm.goto_login_session_sync(null);
        } catch (e) {
            _logError(`WACK lockscreen: failed to switch user: ${e.message}`);
        }
    }

    triggerToggleNotifications() {
        if (this._extension._lockscreenMode === 'cupertino' && this._extension._cupertinoAlwaysShowUser && !this._extension._promptActive) {
            if (this._extension._notifManager.getNativeNotifCount() > 0 || this._extension._cupertinoShowNotifsOverride) {
                this.hintIsToggle = false;
                this._extension._cupertinoShowNotifsOverride = !this._extension._cupertinoShowNotifsOverride;
                this.updateCupertinoRestState(true);
            }
        }
    }

    createCupertinoRestPrompt() {
        if (this.restPromptContainer) return;

        this.restPromptContainer = new St.BoxLayout({
            style_class: 'wack-cupertino-rest',
            vertical: true,
            reactive: false,
        });

        this.restPrompt = new WackCupertinoRestPrompt(this._extension._dialog._user, this._extension);
        this.restPromptContainer.add_child(this.restPrompt);
        this._extension._dialog._stack.add_child(this.restPromptContainer);
        this._extension._updateLockscreenMessage();

        if (!this.seat) {
            const backend = this._extension.get_context?.().get_backend() ?? Clutter.get_default_backend();
            this.seat = backend.get_default_seat();
            this.seat.connectObject('notify::touch-mode', () => this.syncCupertinoHint(), this);
        }
        this.syncCupertinoHint();
    }

    syncCupertinoHint() {
        const touchMode = this.seat?.touch_mode ?? false;
        this.baseHintText = touchMode
            ? shellGettext('Swipe up to unlock')
            : shellGettext('Click or press a key to unlock');
        this.toggleHintText = this._extension.gettext('Press Shift + N to view notifications');
        this.updateCupertinoHintCycle();
    }

    showInhibitHint(message) {
        if (this.inhibitHintTimeoutId) {
            GLib.source_remove(this.inhibitHintTimeoutId);
            this.inhibitHintTimeoutId = null;
        }

        const clockManager = this._extension._clockLayoutManager;
        const wackActor = clockManager.overflowActive ? clockManager.overflowLabel : clockManager.hint;
        const cupertinoActor = (this._extension._lockscreenMode === 'cupertino' && this.restPrompt)
            ? this.restPrompt._hintBox : null;

        this.showingInhibitHint = true;
        this._extension._showingInhibitHint = true;

        if (this._extension._lockscreenMode === 'cupertino' && this.hintCycleId) {
            GLib.source_remove(this.hintCycleId);
            this.hintCycleId = null;
        }

        wackActor?.remove_all_transitions();
        cupertinoActor?.remove_all_transitions();

        if (wackActor) {
            wackActor.opacity = 255;
            wackActor.visible = true;
            if (clockManager.overflowActive) {
                const prefix = wackActor.text.split('  ·  ')[0];
                wackActor.text = `${prefix}  ·  ${message}`;
                this._extension._notifManager.positionOverflow();
            } else {
                wackActor.text = message;
                clockManager.positionHint();
            }
        }

        if (this.restPrompt) {
            if (cupertinoActor) {
                cupertinoActor.opacity = 255;
                cupertinoActor.visible = true;
            }
            this.restPrompt.setHintText(message);
            this.restPrompt.setNotifCount(0);
        }

        this.inhibitHintTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this.showingInhibitHint = false;
            this._extension._showingInhibitHint = false;
            this.inhibitHintTimeoutId = null;

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
                        if (clockManager.overflowActive) {
                            this._extension._notifManager.enforceCardLimit(this._extension._dialog._notificationsBox);
                        } else {
                            wackActor.text = clockManager.hintText;
                            clockManager.positionHint();
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
                        if (this.restPrompt) {
                            this.hintIsToggle = false;
                            const nativeCount = this._extension._notifManager.getNativeNotifCount();
                            const count = (this._extension._cupertinoAlwaysShowUser && !this._extension._cupertinoShowNotifsOverride) ? nativeCount : 0;
                            const baseText = this._extension._cupertinoShowNotifsOverride
                                ? shellGettext('Swipe up to unlock')
                                : shellGettext('Click or press a key to unlock');

                            this.restPrompt.setHintText(baseText);
                            this.restPrompt.setNotifCount(count);
                        }
                        cupertinoActor.ease({
                            opacity: 255,
                            duration: fadeInDuration,
                            mode: Clutter.AnimationMode.EASE_IN_QUAD,
                            onComplete: () => this.updateCupertinoHintCycle()
                        });
                    }
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    isSleepInhibited() {
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
                if (what.includes('sleep') && (mode === 'block' || mode === 'block-weak')) {
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

    updateCupertinoHintCycle() {
        if (!this.restPrompt) return;

        const nativeCount = this._extension._notifManager.getNativeNotifCount();
        const shouldCycle = this._extension._lockscreenMode === 'cupertino' &&
            this._extension._cupertinoAlwaysShowUser &&
            !this._extension._cupertinoShowNotifsOverride &&
            nativeCount > 0 &&
            !this._extension._promptActive;

        if (shouldCycle) {
            if (!this.hintCycleId) {
                this.hintIsToggle = false;
                this.restPrompt.setHintText(this.baseHintText);

                this.hintCycleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                    this.hintIsToggle = !this.hintIsToggle;
                    const nextText = this.hintIsToggle ? this.toggleHintText : this.baseHintText;

                    if (this.restPrompt && this.restPrompt._hintBox) {
                        const hintBox = this.restPrompt._hintBox;
                        hintBox.ease({
                            opacity: 0,
                            duration: CROSSFADE_TIME / 2,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onComplete: () => {
                                if (!this.restPrompt) return;
                                this.restPrompt.setHintText(nextText);
                                if (this.hintIsToggle) {
                                    this.restPrompt.setNotifCount(0);
                                } else {
                                    this.restPrompt.setNotifCount(this._extension._notifManager.getNativeNotifCount());
                                }
                                hintBox.ease({ opacity: 255, duration: CROSSFADE_TIME / 2, mode: Clutter.AnimationMode.EASE_IN_QUAD });
                            }
                        });
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            if (this.hintCycleId) {
                GLib.source_remove(this.hintCycleId);
                this.hintCycleId = null;
            }
            this.hintIsToggle = false;
            if (this.restPrompt && this.restPrompt._hintBox) {
                this.restPrompt._hintBox.remove_all_transitions();
                this.restPrompt._hintBox.opacity = 255;
                if (!this._extension._notifManager.hasVisibleNotifs() && !this._extension._promptActive) {
                    this.restPrompt.setHintText(this.baseHintText || '');
                }
            }
        }
    }

    updateCupertinoRestState(animate = false) {
        if (this._extension._lockscreenMode !== 'cupertino') return;
        const hasNotifs = this._extension._notifManager.hasVisibleNotifs();

        if (this.restPromptContainer) {
            if (this.restPrompt?._avatarButton) {
                this.restPrompt._avatarButton.reactive = this._extension._promptActive;
                if (!this._extension._promptActive) this.restPrompt._avatarButton.hover = false;
            }

            const count = this._extension._notifManager.getNativeNotifCount();
            let nextCount = 0;
            if (this._extension._cupertinoAlwaysShowUser && count > 0 && !this._extension._cupertinoShowNotifsOverride) {
                if (!this.hintIsToggle) nextCount = count;
            }

            if (hasNotifs) {
                const targetOpacity = 0;
                if (animate) {
                    const restPromptContainer = this.restPromptContainer;
                    restPromptContainer.visible = true;
                    restPromptContainer.ease({
                        opacity: targetOpacity,
                        duration: CROSSFADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            if (this.restPromptContainer === restPromptContainer) {
                                restPromptContainer.visible = false;
                            }
                        },
                    });
                } else {
                    this.restPromptContainer.remove_all_transitions();
                    this.restPromptContainer.opacity = 0;
                    this.restPromptContainer.visible = false;
                }
            } else {
                this.restPrompt?.setNotifCount(nextCount);
                const hintBoxWrapper = this.restPrompt?._hintBoxWrapper;
                const nameLabel = this.restPrompt?._userWell?.get_child()?._label;

                if (animate && !this._extension._promptActive) {
                    this.restPromptContainer.remove_all_transitions();
                    this.restPromptContainer.opacity = 0;
                    this.restPromptContainer.visible = true;
                    if (hintBoxWrapper) { hintBoxWrapper.remove_all_transitions(); hintBoxWrapper.opacity = 255; }
                    if (nameLabel) { nameLabel.remove_all_transitions(); nameLabel.opacity = 255; }
                    this.restPromptContainer.ease({
                        opacity: 255,
                        duration: CROSSFADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    this.restPromptContainer.remove_all_transitions();
                    this.restPromptContainer.opacity = 255;
                    this.restPromptContainer.visible = true;
                    if (!this._extension._promptActive) {
                        if (hintBoxWrapper) { hintBoxWrapper.remove_all_transitions(); hintBoxWrapper.opacity = 255; }
                        if (nameLabel) { nameLabel.remove_all_transitions(); nameLabel.opacity = 255; }
                    }
                }
            }
        }

        if (this._extension._notifManager._notifBox) {
            const targetOpacity = (!this._extension._promptActive && hasNotifs) ? 255 : 0;
            const targetBlur = (!this._extension._promptActive && hasNotifs) ? NOTIF_BLUR_RADIUS : 0;

            if (animate) {
                const notifBox = this._extension._notifManager._notifBox;
                if (targetOpacity > 0) notifBox.visible = true;
                notifBox.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._extension._notifManager._notifBox === notifBox) notifBox.visible = targetOpacity > 0;
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
                this._extension._notifManager._notifBox.remove_all_transitions();
                this._extension._notifManager._notifBox.opacity = targetOpacity;
                this._extension._notifManager._notifBox.visible = targetOpacity > 0;

                const setBlur = (actor) => {
                    const effect = actor.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        actor.remove_transition(`@effects.${NOTIF_BLUR_NAME}.radius`);
                        effect.set({ radius: targetBlur });
                        effect.set_enabled(targetBlur > 0.5);
                    }
                };
                this._extension._notifManager._notifBox._notificationBox.get_children().forEach(setBlur);
                for (const actor of this._extension._notifManager._notifBox._players.values()) setBlur(actor);
            }
        }

        const hintContainer = this._extension._clockLayoutManager?.hintContainer ?? this._extension._hintContainer;
        if (hintContainer) {
            const targetHintOpacity = (!this._extension._promptActive && hasNotifs) ? 255 : 0;
            if (animate) {
                hintContainer.ease({ opacity: targetHintOpacity, duration: CROSSFADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            } else {
                hintContainer.remove_all_transitions();
                hintContainer.opacity = targetHintOpacity;
            }
        }

        const messageActor = this._extension._getLockscreenMessageActor?.();
        const messageManager = this._extension._messageManager;
        const messageLabel = messageManager?.label ?? this._extension._lockscreenMessageLabel;
        if (messageActor && messageLabel && messageLabel.text !== '') {
            const targetMessageOpacity = hasNotifs ? 0 : 255;
            if (animate) {
                const messageContainer = messageActor;
                messageContainer.visible = true;
                messageContainer.ease({
                    opacity: targetMessageOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._extension._getLockscreenMessageActor() === messageContainer) {
                            messageContainer.visible = targetMessageOpacity > 0;
                        }
                    },
                });
            } else {
                messageActor.remove_all_transitions();
                _setActorVisible(messageActor, targetMessageOpacity > 0, targetMessageOpacity);
            }
        }

        this.updateCupertinoHintCycle();
    }

    applyPromptModeLayout() {
        const promptActor = this._extension._promptActor;
        if (!promptActor) return;
        const isCupertino = this._extension._lockscreenMode === 'cupertino';
        const dialog = this._extension._dialog;
        const authPrompt = dialog?._authPrompt ?? dialog?._promptBox?._authPrompt;

        if (isCupertino) {
            this.createCupertinoRestPrompt();
            this._extension._avatarManager?.setupCupertinoAvatarOverride();

            if (this._extension._origPromptActorYAlign === undefined) {
                this._extension._origPromptActorYAlign = promptActor.y_align;
                this._extension._origPromptActorYExpand = promptActor.y_expand;
            }
            promptActor.y_align = Clutter.ActorAlign.FILL;
            promptActor.y_expand = true;

            if (authPrompt && !this._extension._authPromptAllocationId) {
                this._extension._authPromptAllocationId = authPrompt.connect('notify::allocation', () => {
                    this._extension._onAuthPromptAllocation();
                });
            }

            if (this._extension._promptActive)
                promptActor.add_style_class_name('wack-cupertino-prompt');
            else
                promptActor.remove_style_class_name('wack-cupertino-prompt');

            this.updateCupertinoRestState(false);
        } else {
            this.destroyCupertinoRestPrompt();
            this._extension._avatarManager?.teardownCupertinoAvatarOverride();
            this._extension._promptStyling?.clearCupertinoPromptBackground();

            if (this._extension._origPromptActorYAlign !== undefined) {
                promptActor.y_align = this._extension._origPromptActorYAlign;
                promptActor.y_expand = this._extension._origPromptActorYExpand;
                this._extension._origPromptActorYAlign = undefined;
                this._extension._origPromptActorYExpand = undefined;
            }

            if (this._extension._authPromptAllocationId) {
                if (authPrompt) {
                    authPrompt.disconnect(this._extension._authPromptAllocationId);
                }
                this._extension._authPromptAllocationId = 0;
            }

            promptActor.remove_style_class_name('wack-cupertino-prompt');
            this.updateCupertinoRestState(false);
        }
    }

    destroyCupertinoRestPrompt() {
        if (this.hintCycleId) {
            GLib.source_remove(this.hintCycleId);
            this.hintCycleId = null;
        }
        if (this.seat) {
            this.seat.disconnectObject(this);
            this.seat = null;
        }
        if (this.restPrompt) {
            this.restPrompt.destroy();
            this.restPrompt = null;
        }
        if (this.restPromptContainer) {
            this.restPromptContainer.destroy();
            this.restPromptContainer = null;
        }
    }

    teardown() {
        if (this.inhibitHintTimeoutId) {
            GLib.source_remove(this.inhibitHintTimeoutId);
            this.inhibitHintTimeoutId = null;
        }
        this.destroyCupertinoRestPrompt();
    }
}
