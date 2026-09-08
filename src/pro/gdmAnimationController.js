import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WackCupertinoRestPrompt } from '../main/cupertinoPrompt.js';
import { GDM_CROSSFADE_DURATION } from '../main/constants.js';
import { _log, _setActorVisible } from './gdmUtils.js';

export class GdmAnimationController {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this._legacySuccessFadeRunning = false;
    }

    setLegacyPromptChrome(visible, animate = true) {
        const clock = this._gdm._clockManager?.clockWrapper;
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        this._gdm._legacyPromptChromeVisible = visible;

        if (clock && !this._gdm._verificationSucceeded) {
            clock.remove_all_transitions();
            if (animate) {
                clock.ease({
                    opacity: visible ? 0 : 255,
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

    yeetLegacyPromptTransform() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        if (!this._legacySuccessFadeRunning)
            authPrompt.remove_all_transitions();
        authPrompt.set_pivot_point(0.5, 0.5);
        authPrompt.scale_x = 1;
        authPrompt.scale_y = 1;
        authPrompt.translation_x = 0;
        authPrompt.translation_y = 0;
    }

    animateLegacyPromptSuccessFadeOut(onComplete) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) {
            onComplete?.();
            return;
        }

        if (this._legacySuccessFadeRunning) {
            onComplete?.();
            return;
        }

        this.yeetLegacyPromptTransform();
        authPrompt.visible = true;
        this._legacySuccessFadeRunning = true;
        authPrompt.remove_all_transitions();
        authPrompt.ease({
            opacity: 0,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._legacySuccessFadeRunning = false;
                authPrompt.visible = false;
                onComplete?.();
            },
        });
    }

    animateLegacyPromptIn() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        if (this._gdm._legacyPromptAnimationState !== 'selection') {
            this.yeetLegacyPromptTransform();
            authPrompt.opacity = 255;
            authPrompt.visible = true;
            return;
        }

        authPrompt.remove_all_transitions();
        authPrompt.visible = true;
        authPrompt.set_pivot_point(0.5, 0.5);

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

    animateSessionMenuButtonIn() {
        const btn = this._gdm._dialog?._sessionMenuButton;
        if (!btn) return;

        if (!btn.visible && this._gdm._dialog._shouldShowSessionMenuButton?.())
            btn.visible = true;
        if (!btn.visible) return;

        btn.remove_all_transitions();
        btn.opacity = 0;
        btn.ease({
            opacity: 255,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    animateSessionMenuButtonOut() {
        const btn = this._gdm._dialog?._sessionMenuButton;
        if (!btn || !btn.visible) return;

        btn.close?.();
        btn.remove_all_transitions();
        btn.ease({
            opacity: 0,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                _setActorVisible(btn, false, 0);
            },
        });
    }

    animateLegacyPromptOut(onComplete) {
        _log('[WACK/GdmManager] _animateLegacyPromptOut called');
        _setActorVisible(this._gdm._getLockscreenMessageActor(), false, 0);
        this.animateSessionMenuButtonOut();
        if (this._gdm._verificationSucceeded || this._gdm._legacyPromptAnimationState === 'success') {
            this.animateLegacyPromptSuccessFadeOut(onComplete);
            return;
        }

        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) {
            _log('[WACK/GdmManager] _animateLegacyPromptOut: no authPrompt, bailing');
            onComplete?.();
            return;
        }

        authPrompt.remove_all_transitions();
        authPrompt.visible = true;
        authPrompt.set_pivot_point(0.5, 0.5);

        authPrompt.ease({
            opacity: 0,
            scale_x: 0.5,
            scale_y: 0.5,
            translation_y: 200,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                _log('[WACK/GdmManager] _animateLegacyPromptOut: animation complete');
                this.yeetLegacyPromptTransform();
                authPrompt.visible = false;
                authPrompt.opacity = 255;
                onComplete?.();
            },
        });
    }

    animateLegacyReturnToPicker() {
        this.animateSessionMenuButtonOut();
        _setActorVisible(this._gdm._getLockscreenMessageActor(), false, 0);
        this.setLegacyPromptChrome(false, true);
        this._gdm._setPromptBackgroundBlur(false, true);
        this._gdm._applyWallpaper(null);

        const userSelection = this._gdm._dialog?._userSelectionBox;
        if (!userSelection)
            return;

        userSelection.remove_all_transitions();
        userSelection.opacity = 0;
        userSelection.show();
        this._gdm._positionUserList();
        userSelection.ease({
            opacity: 255,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    animateCupertinoPromptOut(onComplete) {
        _log('[WACK/GdmManager] _animateCupertinoPromptOut called');
        this.animateSessionMenuButtonOut();
        if (this._gdm._verificationSucceeded || this._gdm._legacyPromptAnimationState === 'success') {
            onComplete?.();
            return;
        }

        const authPrompt = this._gdm._dialog?._authPrompt;
        const messageActor = this._gdm._getLockscreenMessageActor();

        if (messageActor && messageActor.visible) {
            messageActor.remove_all_transitions();
            messageActor.ease({
                opacity: 0,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    _setActorVisible(messageActor, false, 0);
                },
            });
        }

        if (!authPrompt) {
            onComplete?.();
            return;
        }

        authPrompt.remove_all_transitions();
        authPrompt.visible = true;
        authPrompt.ease({
            opacity: 0,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                _log('[WACK/GdmManager] _animateCupertinoPromptOut: animation complete');
                authPrompt.visible = false;
                authPrompt.opacity = 255;
                onComplete?.();
            },
        });
    }

    animateCupertinoPromptIn() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        if (this._gdm._legacyPromptAnimationState !== 'selection') {
            authPrompt.opacity = 255;
            authPrompt.visible = true;
            return;
        }

        authPrompt.remove_all_transitions();
        authPrompt.visible = true;
        authPrompt.opacity = 0;
        authPrompt.ease({
            opacity: 255,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    animateCupertinoReturnToPicker() {
        this._gdm._applyWallpaper(null);

        const userSelection = this._gdm._dialog?._userSelectionBox;
        if (!userSelection)
            return;

        userSelection.remove_all_transitions();
        userSelection.opacity = 0;
        userSelection.show();
        this._gdm._positionUserList();
        userSelection.ease({
            opacity: 255,
            duration: GDM_CROSSFADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    onUserSelected() {
        _log('[WACK/GdmManager] _onUserSelected called');
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;
        this._gdm._verificationSucceeded = false;
        this._gdm._promptResetAnimating = false;
        this._gdm._skipLegacyPromptEntryAnimation = false;
        this._gdm._legacyPromptAnimationState = 'selection';
        this.animateSessionMenuButtonIn();

        if (this._gdm._dialog._user)
            this._gdm._applyWallpaper(this._gdm._dialog._user.get_user_name());
        this._gdm._selectedPromptMode = this._gdm._currentWallpaperMetadata?.lockscreenMode === 'wack'
            ? 'wack'
            : 'cupertino';
        this._gdm._setPromptBackgroundBlur(this._gdm._selectedPromptMode === 'wack');

        if (this._gdm._selectedPromptMode === 'wack') {
            this._gdm._teardownGdmAvatarOverride();
            authPrompt.translation_x = 0;
            authPrompt.translation_y = 0;
            authPrompt.add_style_class_name('wack-gdm-legacy-prompt');
            authPrompt.remove_style_class_name('wack-cupertino-prompt');
            authPrompt._message?.remove_style_class_name('wack-cupertino-message');
            authPrompt._capsLockWarningLabel?.remove_style_class_name('wack-cupertino-caps-lock-warning');
            this._gdm._clearCupertinoPromptBackground();
            _setActorVisible(this._gdm._getLockscreenMessageActor(), false, 0);
            this.setLegacyPromptChrome(true);
            this.animateLegacyPromptIn();
            this._gdm._startCursorBlink();
            return;
        }

        this.setLegacyPromptChrome(false);
        this._gdm._setupGdmAvatarOverride();
        authPrompt.remove_style_class_name('wack-gdm-legacy-prompt');

        if (this._gdm._cupertinoRestPromptContainer) {
            this._gdm._cupertinoRestPromptContainer.destroy();
        }

        this._gdm._cupertinoRestPromptContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'wack-cupertino-rest',
            opacity: 0,
            visible: true,
        });
        this._gdm._cupertinoRestPromptContainer.set_position(-1000, -1000);
        this._gdm._cupertinoRestPrompt = new WackCupertinoRestPrompt(this._gdm._dialog._user, this._gdm._extension);
        this._gdm._cupertinoRestPromptContainer.add_child(this._gdm._cupertinoRestPrompt);
        this._gdm._dialog.add_child(this._gdm._cupertinoRestPromptContainer);

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

        const uw = authPrompt._userWell?.get_child();
        if (uw) {
            if (uw._avatar) uw._avatar.opacity = 255;
            if (uw._avatarButton) {
                uw._avatarButton.opacity = 255;
                uw._avatarButton.visible = true;
            }
        }

        this._gdm._updateCupertinoPromptBackground().catch(e => {
            _log('[WACK/GdmManager] Failed to apply Cupertino prompt color: ' + e);
        });

        this._gdm._updateLockscreenMessage();
        this._gdm._positionAuthPrompt();
        this._gdm._startCursorBlink();

        this.animateCupertinoPromptIn();
    }

    onReset() {
        this._legacySuccessFadeRunning = false;
        this._gdm._stopCursorBlink();
        _log('[WACK/GdmManager] _onReset called');
        this._gdm._isNotListed = false;

        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;

        this._gdm._setPromptBackgroundBlur(false, false);
        if (this._gdm._selectedPromptMode === 'wack')
            this.setLegacyPromptChrome(false, false);
        this._gdm._selectedPromptMode = 'cupertino';
        this._gdm._teardownGdmAvatarOverride();

        if (this._gdm._cupertinoRestPromptContainer) {
            this._gdm._cupertinoRestPromptContainer.destroy();
            this._gdm._cupertinoRestPromptContainer = null;
            this._gdm._cupertinoRestPrompt = null;
        }
        this._gdm._lastWellH = undefined;
        this._gdm._lastYCenterFraction = undefined;

        authPrompt.translation_x = 0;
        authPrompt.translation_y = 0;
        authPrompt.scale_x = 1;
        authPrompt.scale_y = 1;
        authPrompt.set_pivot_point(0, 0);
        authPrompt.opacity = 0;

        _setActorVisible(this._gdm._getLockscreenMessageActor(), false, 0);
        if (this._gdm._dialog?._sessionMenuButton)
            _setActorVisible(this._gdm._dialog._sessionMenuButton, false, 0);

        authPrompt.remove_style_class_name('wack-cupertino-prompt');
        authPrompt.remove_style_class_name('wack-gdm-legacy-prompt');
        this._gdm._clearCupertinoPromptBackground();

        if (authPrompt._message) {
            authPrompt._message.remove_style_class_name('wack-cupertino-message');
        }
        if (authPrompt._capsLockWarningLabel) {
            authPrompt._capsLockWarningLabel.remove_style_class_name('wack-cupertino-caps-lock-warning');
        }

        this._gdm._applyWallpaper(null);

        this._gdm._legacyPromptAnimationState = 'idle';
        this._gdm._skipLegacyPromptEntryAnimation = false;
        this._gdm._verificationSucceeded = false;
    }
}
