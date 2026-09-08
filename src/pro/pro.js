import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
} from '../main/constants.js';
import { _log, _logError, _setActorVisible, GDM_CROSSFADE_DURATION } from './gdmUtils.js';
import { GdmClockManager } from './gdmClockManager.js';
import { GdmWallpaperManager } from './gdmWallpaperManager.js';
import { GdmUserListManager } from './gdmUserListManager.js';
import { GdmMessageManager } from './gdmMessageManager.js';
import { GdmPromptStyling } from './gdmPromptStyling.js';
import { GdmAvatarManager } from './gdmAvatarManager.js';
import { GdmAnimationController } from './gdmAnimationController.js';

const MESSAGE_PROMPT_GAP = 48;

export class GdmManager {
    constructor(extension) {
        this._extension = extension;
        this._active = false;
        this._dialog = null;
        this._dialogParent = null;

        // Subsystems
        this._clockManager = new GdmClockManager(this);
        this._wallpaperManager = new GdmWallpaperManager(this);
        this._userListManager = new GdmUserListManager(this);
        this._messageManager = new GdmMessageManager(this);
        this._promptStyling = new GdmPromptStyling(this);
        this._avatarManager = new GdmAvatarManager(this);
        this._animController = new GdmAnimationController(this);

        this._origEnsureUnlockDialog = null;
        this._findDialogTimeoutId = null;
        this._origShowPrompt = null;
        this._origOnReset = null;
        this._origVfuncAllocate = null;
        this._allocationHandlers = [];
        this._opacityId = null;
        this._cupertinoRestPromptContainer = null;
        this._cupertinoRestPrompt = null;
        this._currentWallpaperMetadata = null;
        this._lastWellH = undefined;
        this._lastYCenterFraction = undefined;
        this._selectedPromptMode = 'cupertino';
        this._legacyPromptChromeVisible = false;
        this._origAuthPromptReset = null;
        this._promptResetAnimating = false;
        this._verificationSucceeded = false;
        this._legacyPromptAnimationState = 'idle';
        this._skipLegacyPromptEntryAnimation = false;
        this._origLoginScreenSessionActivated = null;
        this._origOnSessionOpened = null;
        this._origStartSession = null;
        this._origOnVerificationComplete = null;
        this._userVerifierCompleteId = 0;
        this._userVerifierSessionOpenedId = 0;
        this._isNotListed = false;
        this._notListedButtonId = 0;
        this._origAskForUsername = null;
        this._origBeginVerificationForItem = null;
        this._origOnPrompted = null;
        this._origSetUserListExpanded = null;
        this._origAuthPromptCancel = null;
    }

    enable() {
        _log('[WACK/GdmManager] enable() called, mode=' + Main.sessionMode.currentMode);
        if (Main.sessionMode.currentMode !== 'gdm') return;

        this._active = true;

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.connectObject('notify::theme', () => this._ensureStylesheetLoaded(), this);
        this._ensureStylesheetLoaded();

        this._origEnsureUnlockDialog = Main.screenShield._ensureUnlockDialog;
        Main.screenShield._ensureUnlockDialog = (allowCancel) => {
            const res = this._origEnsureUnlockDialog.call(Main.screenShield, allowCancel);

            if (Main.screenShield._dialog && this._dialog !== Main.screenShield._dialog) {
                if (this._dialog) {
                    this._teardown();
                }
                this._dialog = Main.screenShield._dialog;
                this._setup();
                this._applyWallpaper();
                this._restartDialogFadeIn();
            }
            return res;
        };

        const existingDialog = this._findLoginDialog();
        if (existingDialog) {
            this._dialog = existingDialog;
            this._setup();
            this._applyWallpaper();
            this._restartDialogFadeIn();
        } else {
            let attempts = 0;
            const pollForDialog = () => {
                const dlg = this._findLoginDialog();
                if (dlg && !this._dialog) {
                    this._dialog = dlg;
                    this._setup();
                    this._applyWallpaper();
                    this._restartDialogFadeIn();
                    this._findDialogTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
                attempts++;
                if (attempts < 100 && this._active) {
                    return GLib.SOURCE_CONTINUE;
                }
                this._findDialogTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            };
            this._findDialogTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, pollForDialog);
        }
    }

    disable() {
        this._active = false;

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.disconnectObject(this);
        this._unloadStylesheet();

        if (this._origEnsureUnlockDialog) {
            Main.screenShield._ensureUnlockDialog = this._origEnsureUnlockDialog;
            this._origEnsureUnlockDialog = null;
        }

        if (this._findDialogTimeoutId) {
            GLib.source_remove(this._findDialogTimeoutId);
            this._findDialogTimeoutId = null;
        }

        this._teardown();
    }

    _findLoginDialog() {
        return Main.screenShield._dialog || null;
    }

    _ensureStylesheetLoaded() {
        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            const stylesheetFile = this._extension.dir.get_child('stylesheet.css');
            if (stylesheetFile.query_exists(null) && theme) {
                theme.load_stylesheet(stylesheetFile);
                _log('[WACK/GdmManager] Stylesheet loaded successfully');
            }
        } catch (e) {
            _logError('[WACK/GdmManager] Failed to load stylesheet: ' + e);
        }
    }

    _unloadStylesheet() {
        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            const stylesheetFile = this._extension.dir.get_child('stylesheet.css');
            if (stylesheetFile.query_exists(null) && theme) {
                theme.unload_stylesheet(stylesheetFile);
                _log('[WACK/GdmManager] Stylesheet unloaded');
            }
        } catch (e) {
            _logError('[WACK/GdmManager] Failed to unload stylesheet: ' + e);
        }
    }

    _setup() {
        const dialog = this._dialog;
        this._dialogParent = dialog.get_parent();

        this._verificationSucceeded = false;
        this._legacyPromptAnimationState = 'idle';
        this._skipLegacyPromptEntryAnimation = false;
        this._promptResetAnimating = false;
        this._isNotListed = false;

        if (dialog.vfunc_allocate) {
            this._origVfuncAllocate = dialog.vfunc_allocate;
            dialog.vfunc_allocate = (dialogBox) => {
                this._origVfuncAllocate.call(dialog, dialogBox);
                this._positionUserList(dialogBox);
                this._positionAuthPrompt(dialogBox);
            };
        }

        if (dialog._loginScreenSessionActivated) {
            this._origLoginScreenSessionActivated = dialog._loginScreenSessionActivated.bind(dialog);
            dialog._loginScreenSessionActivated = (...args) => {
                _log('[WACK/GdmManager] _loginScreenSessionActivated called, resetting GDM state to idle');
                this._verificationSucceeded = false;
                this._legacyPromptAnimationState = 'idle';
                this._skipLegacyPromptEntryAnimation = false;
                this._promptResetAnimating = false;
                this._isNotListed = false;
                this._animController._legacySuccessFadeRunning = false;

                if (this._clockManager?.clockWrapper) {
                    this._clockManager.clockWrapper.remove_all_transitions();
                    this._clockManager.clockWrapper.opacity = 255;
                    this._clockManager.clockWrapper.scale_x = 1;
                    this._clockManager.clockWrapper.scale_y = 1;
                    this._clockManager.positionClock();
                }

                if (this._cupertinoRestPromptContainer) {
                    this._cupertinoRestPromptContainer.destroy();
                    this._cupertinoRestPromptContainer = null;
                    this._cupertinoRestPrompt = null;
                }

                if (dialog._authPrompt) {
                    dialog._authPrompt.remove_style_class_name('wack-cupertino-prompt');
                    dialog._authPrompt.remove_style_class_name('wack-gdm-legacy-prompt');
                    this._clearCupertinoPromptBackground();
                    dialog._authPrompt.translation_x = 0;
                    dialog._authPrompt.translation_y = 0;
                    dialog._authPrompt.scale_x = 1;
                    dialog._authPrompt.scale_y = 1;
                    dialog._authPrompt.opacity = 0;
                    dialog._authPrompt.visible = false;
                }

                this._setLegacyPromptChrome(false, false);
                this._setPromptBackgroundBlur(false, false);
                this._applyWallpaper(null);

                dialog._user = null;

                const res = this._origLoginScreenSessionActivated(...args);

                if (dialog._userSelectionBox) {
                    dialog._userSelectionBox.remove_all_transitions();
                    this._positionUserList();
                    dialog._userSelectionBox.opacity = 255;
                    dialog._userSelectionBox.visible = true;
                }

                return res;
            };
        }

        this._wallpaperManager.setup(dialog, this._dialogParent);
        this._clockManager.setup(dialog, this._dialogParent);
        this._messageManager.setup(this._dialogParent);
        this._userListManager.setup(dialog);

        // Shift user selection list down
        if (dialog._userSelectionBox) {
            this._connectAllocation(dialog._userSelectionBox, () => this._positionUserList());
        }
        this._positionUserList();

        // Shift auth prompt and message label
        if (dialog._authPrompt) {
            this._connectAllocation(dialog._authPrompt, () => this._positionAuthPrompt());
        }
        if (this._messageManager.scrollView) {
            this._connectAllocation(this._messageManager.scrollView, () => this._positionAuthPrompt());
        }

        // Ensure auth prompt and lockscreen message are hidden initially when no user is selected
        if (!dialog._user) {
            if (dialog._authPrompt) {
                dialog._authPrompt.visible = false;
                dialog._authPrompt.opacity = 0;
            }
            if (this._messageManager.scrollView) {
                this._messageManager.scrollView.visible = false;
                this._messageManager.scrollView.opacity = 0;
            }
            if (dialog._sessionMenuButton) {
                _setActorVisible(dialog._sessionMenuButton, false, 0);
            }
            if (dialog._userSelectionBox && dialog._userSelectionBox.visible) {
                dialog._userSelectionBox.remove_all_transitions();
                dialog._userSelectionBox.opacity = 0;
                dialog._userSelectionBox.ease({
                    opacity: 255,
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }

        // Distro logo opacity override
        if (dialog._logoBin) {
            dialog._logoBin.opacity = 0;
        }

        let hasBeenFullyVisible = false;
        this._opacityId = dialog.connect('notify::opacity', () => {
            const op = dialog.opacity;
            if (op === 255) {
                if (!hasBeenFullyVisible) {
                    hasBeenFullyVisible = true;
                }
                if (!this._legacyPromptChromeVisible && this._clockManager.clockWrapper && !this._clockManager.clockWrapper.get_transition('opacity'))
                    this._clockManager.clockWrapper.opacity = 255;
                const messageActor = this._getLockscreenMessageActor();
                if (messageActor) {
                    if (this._selectedPromptMode !== 'wack' && !this._isNotListed && messageActor.visible) {
                        messageActor.opacity = 255;
                    } else {
                        _setActorVisible(messageActor, false, 0);
                    }
                }
            } else if (hasBeenFullyVisible) {
                if (!this._legacyPromptChromeVisible && this._clockManager.clockWrapper && !this._clockManager.clockWrapper.get_transition('opacity'))
                    this._clockManager.clockWrapper.opacity = op;
                const messageActor = this._getLockscreenMessageActor();
                if (messageActor && !messageActor.get_transition('opacity')) {
                    if (this._selectedPromptMode !== 'wack' && !this._isNotListed && messageActor.visible) {
                        messageActor.opacity = op;
                    } else {
                        _setActorVisible(messageActor, false, 0);
                    }
                }
            }
        });

        this._origShowPrompt = dialog._showPrompt.bind(dialog);
        dialog._showPrompt = (...args) => {
            if (this._verificationSucceeded || this._legacyPromptAnimationState === 'success') {
                if (this._selectedPromptMode === 'wack')
                    this._yeetLegacyPromptTransform();
                return;
            }

            if (this._promptResetAnimating || (!dialog._user && !this._isNotListed)) {
                return;
            }

            const wasAlreadyVisible = dialog._authPrompt?.visible;
            this._origShowPrompt(...args);

            // Guard against re-entering selection on a spurious _showPrompt re-fire
            // (e.g. GDM re-arming the entry after a wrong-password retry). If the
            // prompt is already visible and already mid-selection, _onUserSelected()
            // must not run again for either mode — otherwise animateCupertinoPromptIn()
            // re-fades an already-opaque authPrompt from 0, producing the double
            // fade-in, and _cupertinoRestPromptContainer gets needlessly rebuilt.
            if (wasAlreadyVisible && this._legacyPromptAnimationState === 'selection')
                return;

            this._onUserSelected();
        };

        this._origOnReset = dialog._onReset.bind(dialog);
        dialog._onReset = (...args) => {
            const resetType = args[1];

            // If there is no active user selected and not entering username:
            // Any reset other than PROVIDE_USERNAME (0) is a trailing verifier artifact.
            // If passed to _origOnReset, GNOME Shell's fallback 'else' branch would execute
            // _hideUserListAndBeginVerification(), hiding the user list and resurrecting the prompt!
            if (!dialog._user && !this._isNotListed) {
                if (resetType === 0) {
                    this._origOnReset(...args);
                }
                return;
            }

            // If resetType is REUSE_USERNAME (2), GDM is retrying for the current user.
            // Do NOT tear down prompt state or return to idle!
            if (resetType === 2) {
                this._origOnReset(...args);
                return;
            }

            this._origOnReset(...args);

            if (!this._promptResetAnimating && !this._verificationSucceeded)
                this._onReset();
        };

        const markVerificationSuccess = () => {
            this._verificationSucceeded = true;
            this._legacyPromptAnimationState = 'success';
            this._skipLegacyPromptEntryAnimation = true;
            this._stopCursorBlink();
            if (this._selectedPromptMode === 'wack')
                this._yeetLegacyPromptTransform();
        };

        const fadeOutOverlayActors = (duration = 250) => {
            if (this._clockManager?.clockWrapper) {
                this._clockManager.clockWrapper.remove_all_transitions();
                this._clockManager.clockWrapper.ease({
                    opacity: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            const messageActor = this._getLockscreenMessageActor();
            if (messageActor && messageActor.visible) {
                messageActor.remove_all_transitions();
                messageActor.ease({
                    opacity: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        };

        if (dialog._onSessionOpened) {
            this._origOnSessionOpened = dialog._onSessionOpened.bind(dialog);
            dialog._onSessionOpened = (...args) => {
                markVerificationSuccess();
                fadeOutOverlayActors(250);
                if (this._selectedPromptMode === 'wack') {
                    this._animateLegacyPromptSuccessFadeOut();
                    this._setLegacyPromptChrome(false, true);
                }
                return this._origOnSessionOpened(...args);
            };
        }

        if (dialog._startSession) {
            this._origStartSession = dialog._startSession.bind(dialog);
            dialog._startSession = (...args) => {
                markVerificationSuccess();
                fadeOutOverlayActors(250);
                if (this._selectedPromptMode === 'wack') {
                    this._animateLegacyPromptSuccessFadeOut();
                    this._setLegacyPromptChrome(false, true);
                }
                return this._origStartSession(...args);
            };
        }

        if (dialog._onVerificationComplete) {
            this._origOnVerificationComplete = dialog._onVerificationComplete.bind(dialog);
            dialog._onVerificationComplete = (...args) => {
                markVerificationSuccess();
                return this._origOnVerificationComplete(...args);
            };
        }

        const userVerifier = dialog._userVerifier || dialog._authPrompt?._userVerifier;
        if (userVerifier) {
            this._userVerifierCompleteId = userVerifier.connect('verification-complete', () => {
                markVerificationSuccess();
            });
            this._userVerifierSessionOpenedId = userVerifier.connect('session-opened', () => {
                markVerificationSuccess();
            });
        }

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

        if (dialog._onPrompted) {
            this._origOnPrompted = dialog._onPrompted.bind(dialog);
            dialog._onPrompted = (...args) => {
                if (this._promptResetAnimating || (!dialog._user && !this._isNotListed))
                    return;
                this._origOnPrompted(...args);
                this._animateSessionMenuButtonIn();
            };
        }

        if (dialog._setUserListExpanded) {
            this._origSetUserListExpanded = dialog._setUserListExpanded.bind(dialog);
            dialog._setUserListExpanded = (expanded) => {
                const wasVisible = dialog._userSelectionBox?.visible;
                this._origSetUserListExpanded(expanded);
                if (expanded && dialog._userSelectionBox && (!wasVisible || dialog._userSelectionBox.opacity === 0)) {
                    this._positionUserList();
                    dialog._userSelectionBox.remove_all_transitions();
                    dialog._userSelectionBox.opacity = 0;
                    dialog._userSelectionBox.ease({
                        opacity: 255,
                        duration: GDM_CROSSFADE_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            };
        }

        this._origAuthPromptReset = dialog._authPrompt.reset.bind(dialog._authPrompt);
        dialog._authPrompt.reset = (...args) => {
            const isVerified = this._verificationSucceeded ||
                this._legacyPromptAnimationState === 'success' ||
                (dialog._authPrompt?.verificationStatus === 3);

            if (isVerified) {
                markVerificationSuccess();
                return this._origAuthPromptReset(...args);
            }

            // Soft reset (e.g. wrong password retry): do NOT animate out or return to picker!
            if (args[0]?.softReset) {
                if (!dialog._user && !this._isNotListed)
                    return undefined;
                return this._origAuthPromptReset(...args);
            }

            if (!dialog._user && !this._isNotListed && !dialog._authPrompt?.visible) {
                return this._origAuthPromptReset(...args);
            }

            if (this._promptResetAnimating)
                return undefined;

            this._promptResetAnimating = true;
            this._legacyPromptAnimationState = 'idle';

            if (this._selectedPromptMode === 'wack') {
                this._animateLegacyReturnToPicker();
                this._animateLegacyPromptOut(() => {
                    this._promptResetAnimating = false;
                    if (this._dialog?._authPrompt && this._origAuthPromptReset)
                        this._origAuthPromptReset(...args);
                });
            } else {
                this._animateCupertinoReturnToPicker();
                this._animateCupertinoPromptOut(() => {
                    this._promptResetAnimating = false;
                    if (this._dialog?._authPrompt && this._origAuthPromptReset)
                        this._origAuthPromptReset(...args);
                });
            }
            return undefined;
        };

        this._origAuthPromptCancel = dialog._authPrompt.cancel.bind(dialog._authPrompt);
        dialog._authPrompt.cancel = () => {
            if (dialog._authPrompt.verificationStatus === 3) // VERIFICATION_SUCCEEDED
                return;

            dialog._user = null;
            this._isNotListed = false;

            // Force status to VERIFICATION_CANCELLED (4) so authPrompt.reset() emits
            // ResetType.PROVIDE_USERNAME (0) instead of REUSE_USERNAME (2), ensuring
            // GDM returns to user list and does not restart verification.
            dialog._authPrompt.verificationStatus = 4; // VERIFICATION_CANCELLED
            this._origAuthPromptCancel();
        };
    }

    _restartDialogFadeIn() {
        const dialog = this._dialog;
        if (!dialog) return;
        dialog.remove_all_transitions();
        dialog.opacity = 0;
        dialog.ease({
            opacity: 255,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    _teardown() {
        this._verificationSucceeded = false;
        this._animController._legacySuccessFadeRunning = false;
        this._stopCursorBlink();
        this._promptResetAnimating = false;
        this._legacyPromptAnimationState = 'idle';
        this._skipLegacyPromptEntryAnimation = false;
        if (!this._dialog) return;
        const dialog = this._dialog;

        this._wallpaperManager.teardown();
        this._clockManager.teardown();
        this._messageManager.teardown();
        this._userListManager.teardown(dialog);
        this._promptStyling.teardown();
        this._avatarManager.teardown();

        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
            this._cupertinoRestPrompt = null;
        }

        if (this._opacityId && dialog) {
            dialog.disconnect(this._opacityId);
            this._opacityId = null;
        }

        if (this._origAuthPromptReset && dialog?._authPrompt) {
            dialog._authPrompt.reset = this._origAuthPromptReset;
            this._origAuthPromptReset = null;
        }
        if (this._origAuthPromptCancel && dialog?._authPrompt) {
            dialog._authPrompt.cancel = this._origAuthPromptCancel;
            this._origAuthPromptCancel = null;
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
        if (this._origOnVerificationComplete && dialog) {
            dialog._onVerificationComplete = this._origOnVerificationComplete;
            this._origOnVerificationComplete = null;
        }
        if (this._userVerifierCompleteId) {
            const uv = dialog?._userVerifier || dialog?._authPrompt?._userVerifier;
            if (uv)
                uv.disconnect(this._userVerifierCompleteId);
            this._userVerifierCompleteId = 0;
        }
        if (this._userVerifierSessionOpenedId) {
            const uv = dialog?._userVerifier || dialog?._authPrompt?._userVerifier;
            if (uv)
                uv.disconnect(this._userVerifierSessionOpenedId);
            this._userVerifierSessionOpenedId = 0;
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
        if (this._origOnPrompted && dialog) {
            dialog._onPrompted = this._origOnPrompted;
            this._origOnPrompted = null;
        }
        if (this._origLoginScreenSessionActivated && dialog) {
            dialog._loginScreenSessionActivated = this._origLoginScreenSessionActivated;
            this._origLoginScreenSessionActivated = null;
        }
        if (this._origSetUserListExpanded && dialog) {
            dialog._setUserListExpanded = this._origSetUserListExpanded;
            this._origSetUserListExpanded = null;
        }

        if (dialog?._logoBin)
            dialog._logoBin.opacity = 255;

        if (dialog?._authPrompt) {
            dialog._authPrompt.translation_x = 0;
            dialog._authPrompt.translation_y = 0;
            dialog._authPrompt.remove_style_class_name('wack-cupertino-prompt');
            this._clearCupertinoPromptBackground();
            if (dialog._authPrompt._message)
                dialog._authPrompt._message.remove_style_class_name('wack-cupertino-message');
            if (dialog._authPrompt._capsLockWarningLabel)
                dialog._authPrompt._capsLockWarningLabel.remove_style_class_name('wack-cupertino-caps-lock-warning');
        }

        if (dialog?._userSelectionBox) {
            dialog._userSelectionBox.translation_x = 0;
            dialog._userSelectionBox.translation_y = 0;
        }

        const systemBgActor = Main.layoutManager?._systemBackground;
        if (systemBgActor && systemBgActor.content?.background) {
            const bg = systemBgActor.content.background;
            bg.set_file(null, 0);
            let [res, color] = Cogl.Color.from_string('#282828');
            if (res)
                bg.set_color(color);
        }

        this._dialogParent = null;
        this._dialog = null;
    }

    _connectAllocation(actor, fn) {
        const id = actor.connect('notify::allocation', fn);
        this._allocationHandlers.push({ actor, id });
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
        const [, , , wellH] = userWell ? userWell.get_preferred_size() : [0, 0, 0, 0];
        const [, , promptW, promptH] = authPrompt.get_preferred_size();

        const anchorH = wellH > 0 ? Math.floor(wellH * 1.3) : promptH;
        const targetY = Math.floor(h * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
        const currentY = authPrompt.get_allocation_box().y1;
        authPrompt.translation_y = targetY - currentY;
        authPrompt.translation_x = Math.floor(w / 2 - promptW / 2) - (authPrompt.x || 0);

        const messageActor = this._getLockscreenMessageActor();
        if (!dialogBox && messageActor && messageActor.visible && !this._isNotListed && this._selectedPromptMode !== 'wack') {
            this._syncLockscreenMessageLayout();
            const msgW = this._messageManager.width;
            const msgH = this._messageManager.height;
            const msgX = alloc.x1 + Math.floor((w - msgW) / 2.0);
            const msgY = alloc.y1 + targetY - MESSAGE_PROMPT_GAP - msgH;
            messageActor.set_position(msgX, msgY);
        } else if (messageActor && (this._selectedPromptMode === 'wack' || this._isNotListed)) {
            _setActorVisible(messageActor, false, 0);
        }

        let yCenterFraction = null;
        let promptBounds = null;
        const entry = this._findPromptEntry(authPrompt) ?? restPrompt?._hintBox;
        if (entry) {
            const [xTrans, yTrans] = entry.get_transformed_position();
            const wTrans = entry.get_width() || 0;
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (yTrans > 0 && monitorHeight > 0)
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            if (wTrans > 0 && hTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && xTrans >= monitorX && yTrans >= monitorY) {
                promptBounds = {
                    x1: Math.max(0, Math.min(1, (xTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (xTrans + wTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (yTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (yTrans + hTrans - monitorY) / monitorHeight)),
                };
            }
        }

        const wellChanged = wellH !== this._lastWellH;
        const yCenterChanged = yCenterFraction !== null &&
            (this._lastYCenterFraction === undefined || Math.abs(yCenterFraction - this._lastYCenterFraction) > 0.001);
        const boundsChanged = promptBounds && (!this._lastPromptBounds ||
            Math.abs(promptBounds.x1 - this._lastPromptBounds.x1) > 0.002 ||
            Math.abs(promptBounds.x2 - this._lastPromptBounds.x2) > 0.002 ||
            Math.abs(promptBounds.y1 - this._lastPromptBounds.y1) > 0.002);

        if (wellChanged || yCenterChanged || boundsChanged) {
            if (wellChanged) this._lastWellH = wellH;
            if (yCenterChanged) this._lastYCenterFraction = yCenterFraction;
            if (boundsChanged) this._lastPromptBounds = promptBounds;
            this._updateCupertinoPromptBackground().catch(e => {
                _logError('[WACK/GdmManager] Failed to update prompt background in allocation: ' + e);
            });
        }
    }

    // Delegations to sub-managers
    _getLockscreenMessageActor() { return this._messageManager.getMessageActor(); }
    _syncLockscreenMessageLayout() { this._messageManager.syncLayout(); }
    _updateLockscreenMessage(metadata = null) { this._messageManager.update(metadata); }

    _setPromptBackgroundBlur(active, animate = true) { this._wallpaperManager.setPromptBackgroundBlur(active, animate); }
    _applyWallpaper(userName = null) { this._wallpaperManager.applyWallpaper(userName); }

    _positionClock(dialogBox = null) { this._clockManager.positionClock(dialogBox); }
    _positionUserList(dialogBox = null) { this._userListManager.positionUserList(dialogBox); }

    _startCursorBlink() { this._promptStyling.startCursorBlink(); }
    _stopCursorBlink() { this._promptStyling.stopCursorBlink(); }
    _findPromptEntry(actor) { return this._promptStyling.findPromptEntry(actor); }
    _clearCupertinoPromptBackground() { this._promptStyling.clearCupertinoPromptBackground(); }
    _updateCupertinoPromptBackground(metadata = null) { return this._promptStyling.updateCupertinoPromptBackground(metadata); }

    _setupGdmAvatarOverride() { this._avatarManager.setup(); }
    _teardownGdmAvatarOverride() { this._avatarManager.teardown(); }

    _setLegacyPromptChrome(visible, animate = true) { this._animController.setLegacyPromptChrome(visible, animate); }
    _yeetLegacyPromptTransform() { this._animController.yeetLegacyPromptTransform(); }
    _animateSessionMenuButtonIn() { this._animController.animateSessionMenuButtonIn(); }
    _animateLegacyPromptOut(onComplete) { this._animController.animateLegacyPromptOut(onComplete); }
    _animateLegacyPromptSuccessFadeOut(onComplete) { this._animController.animateLegacyPromptSuccessFadeOut(onComplete); }
    _animateLegacyReturnToPicker() { this._animController.animateLegacyReturnToPicker(); }
    _animateCupertinoPromptOut(onComplete) { this._animController.animateCupertinoPromptOut(onComplete); }
    _animateCupertinoReturnToPicker() { this._animController.animateCupertinoReturnToPicker(); }
    _onUserSelected() { this._animController.onUserSelected(); }
    _onReset() { this._animController.onReset(); }
}