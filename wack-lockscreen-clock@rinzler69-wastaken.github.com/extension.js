import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { UnblankManager } from './src/main/unblank.js';
import {
    CLOCK_ANIMATIONS,
    DEFAULT_CLOCK_ANIMATION,
    DEFAULT_PROMPT_ANIMATION,
    PROMPT_ANIMATIONS,
    createAnimationState,
    getAnimationSetting,
    resetAnimationActors,
} from './src/main/anims.js';
import { WackClock } from './src/main/wackClock.js';
import { getWallpaperAlpha, getWallpaperPromptColor, clearCache, initCache } from './src/main/alphaManager.js';
import { WackLayout } from './src/main/layoutManager.js';
import { NotificationManager } from './src/main/notificationManager.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    CUPERTINO_UNLOCK_FADE_DURATION,
    CROSSFADE_SPEED_SLOW,
    CROSSFADE_SPEED_FAST,
} from './src/main/constants.js';
import { _log, _logError, _setActorVisible, PowerProfilesIface } from './src/main/mainUtils.js';

import { LockscreenMessageManager } from './src/main/lockscreenMessageManager.js';
import { PromptStyling } from './src/main/promptStyling.js';
import { AvatarManager } from './src/main/avatarManager.js';
import { WallpaperManager } from './src/main/wallpaperManager.js';
import { ClockLayoutManager } from './src/main/clockLayoutManager.js';
import { ThemeManager } from './src/main/themeManager.js';
import { CupertinoPromptManager } from './src/main/cupertinoPromptManager.js';
import { UnlockDialogController } from './src/main/unlockDialogController.js';

export default class WackLockscreenClockExtension extends Extension {
    get _promptActive() {
        return (this._dialog?._adjustment?.value ?? 0) > 0;
    }

    // Backwards-compatibility getters for sub-managers
    get _clockWrapper() { return this._clockLayoutManager?.clockWrapper ?? null; }
    get _hintContainer() { return this._clockLayoutManager?.hintContainer ?? null; }
    get _hint() { return this._clockLayoutManager?.hint ?? null; }
    get _overflowLabel() { return this._clockLayoutManager?.overflowLabel ?? null; }
    get _overflowActive() { return this._clockLayoutManager?.overflowActive ?? false; }
    set _overflowActive(v) { if (this._clockLayoutManager) this._clockLayoutManager.overflowActive = v; }
    get _hintText() { return this._clockLayoutManager?.hintText ?? ''; }
    set _hintText(v) { if (this._clockLayoutManager) this._clockLayoutManager.hintText = v; }

    get _customWallpaperOverlay() { return this._wallpaperManager?.customWallpaperOverlay ?? null; }

    get _lockscreenMessageScrollView() { return this._messageManager?.scrollView ?? null; }
    get _lockscreenMessageLabel() { return this._messageManager?.label ?? null; }
    get _lockscreenMessageContent() { return this._messageManager?.content ?? null; }
    get _lockscreenMessageWidth() { return this._messageManager?.width ?? 0; }
    get _lockscreenMessageHeight() { return this._messageManager?.height ?? 0; }

    get _cupertinoRestPromptContainer() { return this._cupertinoPromptManager?.restPromptContainer ?? null; }
    get _cupertinoRestPrompt() { return this._cupertinoPromptManager?.restPrompt ?? null; }

    enable() {
        const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PowerProfilesIface);
        this._powerProfilesProxy = null;
        try {
            this._powerProfilesProxy = new PowerProfilesProxy(
                Gio.DBus.system,
                'net.hadess.PowerProfiles',
                '/net/hadess/PowerProfiles',
                (proxy, error) => {
                    if (error) {
                        _logError(`WACK Lockscreen: PowerProfiles proxy error: ${error.message}`);
                        return;
                    }
                    this._powerProfilesProxy.connectObject('g-properties-changed', () => {
                        this._syncCupertinoUnlockFade();
                    }, this);
                    this._syncCupertinoUnlockFade();
                }
            );
        } catch (e) {
            _logError(`WACK Lockscreen: Failed to initialize PowerProfiles DBus proxy: ${e.message}`);
        }

        this._isActive = true;
        
        
        

        

        const dialog = Main.screenShield._dialog;
        _log(`[WACK] enable() called, dialog=${!!dialog}`);
        if (!dialog) return;

        // Subsystem instantiations
        this._themeManager = new ThemeManager(this);
        this._wallpaperManager = new WallpaperManager(this);
        this._clockLayoutManager = new ClockLayoutManager(this);
        this._messageManager = new LockscreenMessageManager(this);
        this._promptStyling = new PromptStyling(this);
        this._avatarManager = new AvatarManager(this);
        this._cupertinoPromptManager = new CupertinoPromptManager(this);
        this._unlockDialogController = new UnlockDialogController(this);
        this._notifManager = new NotificationManager(this);

        this._themeManager.applyUserTheme();

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
        this._wallpaperUpdateSeq = 0;
        this._animationState = createAnimationState();

        initCache();

        if (Main.screenShield) {
            Main.screenShield.connectObject('active-changed', () => {
                if (Main.screenShield.active) {
                    this._updateCustomWallpaperOverlay();
                }
            }, this);
        }

        this._loadSettings();
        this._unblankManager = new UnblankManager(this);

        const lockDialogGroup = Main.screenShield._lockDialogGroup;

        // Clock replacement & setup
        dialog._stack.remove_child(dialog._clock);
        dialog._clock = new WackClock();
        lockDialogGroup.add_child(dialog._clock);

        this._clockLayoutManager.setup(dialog, lockDialogGroup);

        this._notifManager.setupNotifBlur(dialog._notificationsBox);
        this._promptActor = dialog._promptBox ?? dialog._stack;
        this._promptActor?.set_pivot_point(0.5, 0.5);

        // Wallpaper settings
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

        // Install UnlockDialog controller hooks
        this._unlockDialogController.install(dialog, lockDialogGroup);

        // Setup MainBox layout and lockscreen message
        const mainBox = dialog.get_child_at_index(dialog.get_n_children() - 1);
        if (mainBox) {
            this._origLayout = mainBox.layout_manager;
            this._messageManager.setup(mainBox);
            mainBox.layout_manager = new WackLayout(
                this,
                dialog._stack,
                dialog._notificationsBox,
                dialog._otherUserButton,
                this._messageManager.scrollView
            );
            mainBox.queue_relayout();
            this._mainBox = mainBox;
            this._messageManager.update();
        }

        // Input handling
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
                            if (Main.screenShield._loginManager?.suspend) {
                                Main.screenShield._loginManager.suspend();
                            } else {
                                try {
                                    SystemActions.getDefault().activateSuspend();
                                } catch (e) {
                                    const session = SystemActions.getDefault()._session;
                                    if (session?.SuspendAsync)
                                        session.SuspendAsync().catch(err => console.error(err));
                                }
                            }
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
                        this._cupertinoPromptManager.hintIsToggle = false;
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
            this._syncLockscreenMessageLayout();
        }, this);
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
            this._setCustomWallpaperBlur(targetRadius, targetBrightness);

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
            this._syncCupertinoUnlockFade();
        };
        syncCupertinoUnlockFade();

        const syncCrossfadeSpeed = () => {
            const speed = this._settings.get_string('cupertino-crossfade-speed') || 'slow';
            if (speed === 'slow')
                this._cupertinoUnlockFadeDuration = CROSSFADE_SPEED_SLOW;
            else if (speed === 'fast')
                this._cupertinoUnlockFadeDuration = CROSSFADE_SPEED_FAST;
            else
                this._cupertinoUnlockFadeDuration = CUPERTINO_UNLOCK_FADE_DURATION;
        };
        syncCrossfadeSpeed();

        const syncPromptVibrancy = () => {
            this._updateClockAlphaAndPromptColor();
        };
        syncPromptVibrancy();

        const syncCursorBlink = () => {
            this._cursorBlink = this._settings.get_boolean('cursor-blink') ?? true;
            if (this._promptActive) {
                this._startCursorBlink();
            } else {
                this._stopCursorBlink();
            }
        };
        syncCursorBlink();

        const syncCustomWallpaper = () => {
            this._updateCustomWallpaperOverlay();
            this._updateClockAlphaAndPromptColor();
        };
        syncCustomWallpaper();

        this._wackShellStateChangedId = Main.extensionManager.connect('extension-state-changed', (_obj, ext) => {
            if (ext.uuid === 'wack-shell@rinzler69-wastaken.github.com') {
                syncCupertinoUnlockFade();
            }
        });

        this._settings.connectObject(
            'changed::clock-animation', syncClockAnimation,
            'changed::prompt-animation', syncPromptAnimation,
            'changed::lockscreen-mode', syncLockscreenMode,
            'changed::cupertino-always-show-user', syncCupertinoAlwaysShowUser,
            'changed::esc-to-sleep', syncEscToSleep,
            'changed::cupertino-unlock-fade', syncCupertinoUnlockFade,
            'changed::cupertino-crossfade-speed', syncCrossfadeSpeed,
            'changed::prompt-vibrancy', syncPromptVibrancy,
            'changed::cursor-blink', syncCursorBlink,
            'changed::cupertino-lockscreen-message-enable', () => this._updateLockscreenMessage(),
            'changed::cupertino-lockscreen-message-text', () => this._updateLockscreenMessage(),
            'changed::lockscreen-wallpaper-enable', syncCustomWallpaper,
            'changed::lockscreen-wallpaper-path', syncCustomWallpaper,
            this
        );
    }

    _updateClockAlpha() {
        this._updateClockAlphaAndPromptColor();
    }

    async _updateClockAlphaAndPromptColor() {
        const dialog = this._dialog;
        const seq = ++this._wallpaperUpdateSeq;

        if (!this._bgSettings)
            this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        if (!this._interfaceSettings)
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        const colorScheme = this._interfaceSettings.get_enum('color-scheme');
        const style = this._bgSettings.get_enum('picture-options');

        const customWallpaperEnabled = this._settings?.get_boolean('lockscreen-wallpaper-enable') ?? false;
        const customWallpaperPath = this._settings?.get_string('lockscreen-wallpaper-path') ?? '';
        let uri;
        if (customWallpaperEnabled && customWallpaperPath && Gio.File.new_for_path(customWallpaperPath).query_exists(null)) {
            uri = customWallpaperPath.startsWith('file://') ? customWallpaperPath : `file://${customWallpaperPath}`;
        } else {
            uri = this._bgSettings.get_string(
                colorScheme === 1 ? 'picture-uri-dark' : 'picture-uri'
            );
        }

        const isColor = (style === 0 && !customWallpaperEnabled);
        const primaryColor = this._bgSettings.get_string('primary-color');
        const secondaryColor = this._bgSettings.get_string('secondary-color');
        const shadingType = this._bgSettings.get_enum('color-shading-type');

        const promptVibrancy = this._settings?.get_boolean('prompt-vibrancy') ?? true;

        let wellH = 0;
        if (this._cupertinoPromptManager?.restPrompt?._userWell) {
            const [, , , hSize] = this._cupertinoPromptManager.restPrompt._userWell.get_preferred_size();
            wellH = hSize > 0 ? hSize : 0;
        }

        let yCenterFraction = null;
        const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
        const entry = this._findPromptEntry(authPrompt);
        if (entry) {
            const pos = entry.get_transformed_position();
            const yTrans = pos[1];
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            if (yTrans > 0 && monitorHeight > 0) {
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            }
        }

        const wallpaperParams = {
            uri,
            isColor,
            primaryColor,
            secondaryColor,
            shadingType,
            wellH,
            yCenterFraction,
        };
        const textLuminance = dialog?._clock?.getTextLuminance?.() ?? 1.0;

        const [alpha, promptColor] = await Promise.all([
            getWallpaperAlpha({ ...wallpaperParams, textLuminance }),
            promptVibrancy
                ? getWallpaperPromptColor(wallpaperParams)
                : Promise.resolve(null),
        ]);

        if (seq !== this._wallpaperUpdateSeq)
            return;

        _log(`[WACK/Extension] _updateClockAlphaAndPromptColor - uri: ${uri}, promptColor: ${JSON.stringify(promptColor)}, alpha: ${alpha}, yCenterFraction: ${yCenterFraction}`);

        if (dialog?._clock)
            dialog._clock.setWallpaperAlpha(alpha);

        if (this._crossSessionManager)
            this._crossSessionManager.setClockAlphaAndPromptColor(alpha, promptColor);

        const isCupertinoPromptActive = this._promptActor?.has_style_class_name('wack-cupertino-prompt');
        if (isCupertinoPromptActive) {
            const currentAuthPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
            if (promptVibrancy && promptColor)
                this._applyPromptEntryBackground(this._findPromptEntry(currentAuthPrompt), promptColor);
            else
                this._clearCupertinoPromptBackground();
        }
    }

    _idleAdd(priority, func, binding = null) {
        let id;
        const wrapped = () => {
            const result = binding ? func.call(binding) : func();
            if (result === GLib.SOURCE_REMOVE)
                this._idleSources.delete(id);
            return result;
        };
        id = GLib.idle_add(priority, wrapped);
        this._idleSources.add(id);
        return id;
    }

    _onPromptShow() {
        const isCupertino = this._lockscreenMode === 'cupertino';
        if (isCupertino) {
            this._promptActor?.remove_style_class_name('wack-cupertino-rest');
            this._promptActor?.add_style_class_name('wack-cupertino-prompt');
            this._cupertinoToPrompt = true;
            this._setupCupertinoAvatarOverride();
            this._updateClockAlphaAndPromptColor();
        }
        this._startCursorBlink();
    }

    _onPromptHide() {
        this._stopCursorBlink();
        if (this._notifManager._notifBox) {
            this._notifManager.enforceCardLimit(this._notifManager._notifBox);
        }
        this._updateCupertinoRestState();
        this._clearCupertinoPromptBackground();
        if (this._promptStyling) {
            this._promptStyling.lastWellH = undefined;
            this._promptStyling.lastYCenterFraction = undefined;
        }

        if (this._lockscreenMode === 'cupertino') {
            const hasNotifs = this._notifManager.hasVisibleNotifs();
            this._cupertinoIconSnap = !hasNotifs;
            this._cupertinoToPrompt = false;
        }
    }

    // Delegations to sub-managers
    _getLockscreenMessageActor() { return this._messageManager?.getMessageActor() ?? null; }
    _syncLockscreenMessageFade() { this._messageManager?.syncFade(); }
    _syncLockscreenMessageLayout() { this._messageManager?.syncLayout(); }
    _updateLockscreenMessage() { this._messageManager?.update(); }

    _findPromptEntry(actor) { return this._promptStyling?.findPromptEntry(actor) ?? null; }
    _startCursorBlink() { this._promptStyling?.startCursorBlink(); }
    _stopCursorBlink() { this._promptStyling?.stopCursorBlink(); }
    _applyPromptEntryBackground(entry, color) { this._promptStyling?.applyPromptEntryBackground(entry, color); }
    _clearCupertinoPromptBackground() { this._promptStyling?.clearCupertinoPromptBackground(); }
    _onAuthPromptAllocation() { this._promptStyling?.onAuthPromptAllocation(); }

    _setupCupertinoAvatarOverride() { this._avatarManager?.setupCupertinoAvatarOverride(); }
    _teardownCupertinoAvatarOverride() { this._avatarManager?.teardownCupertinoAvatarOverride(); }

    _updateCustomWallpaperOverlay() { this._wallpaperManager?.updateCustomWallpaperOverlay(); }
    _setCustomWallpaperBlur(radius, brightness) { this._wallpaperManager?.setCustomWallpaperBlur(radius, brightness); }

    _positionClock() { this._clockLayoutManager?.positionClock(); }
    _positionHint() { this._clockLayoutManager?.positionHint(); }
    _getClockAnimationParams() { return this._clockLayoutManager?.getClockAnimationParams() ?? {}; }

    _tempSessionModeOverride() { this._themeManager?.tempSessionModeOverride(); }
    _restoreSessionMode() { this._themeManager?.restoreSessionMode(); }
    _getUserThemeFile() { return this._themeManager?.getUserThemeFile() ?? null; }

    triggerSwitchUser() { this._cupertinoPromptManager?.triggerSwitchUser(); }
    triggerToggleNotifications() { this._cupertinoPromptManager?.triggerToggleNotifications(); }
    _createCupertinoRestPrompt() { this._cupertinoPromptManager?.createCupertinoRestPrompt(); }
    _syncCupertinoHint() { this._cupertinoPromptManager?.syncCupertinoHint(); }
    _showInhibitHint(message) { this._cupertinoPromptManager?.showInhibitHint(message); }
    _isSleepInhibited() { return this._cupertinoPromptManager?.isSleepInhibited() ?? false; }
    _updateCupertinoHintCycle() { this._cupertinoPromptManager?.updateCupertinoHintCycle(); }
    _destroyCupertinoRestPrompt() { this._cupertinoPromptManager?.destroyCupertinoRestPrompt(); }
    _updateCupertinoRestState(animate = false) { this._cupertinoPromptManager?.updateCupertinoRestState(animate); }
    _applyPromptModeLayout() { this._cupertinoPromptManager?.applyPromptModeLayout(); }

    

    _syncCupertinoUnlockFade() {
        if (!this._settings)
            return;

        const wackShell = Main.extensionManager.lookup('wack-shell@rinzler69-wastaken.github.com');
        const wackShellEnabled = wackShell && wackShell.state === 1;
        const isPowerSaver = this._powerProfilesProxy?.ActiveProfile === 'power-saver';
        this._cupertinoUnlockFade = this._settings.get_string('lockscreen-mode') === 'cupertino' &&
            wackShellEnabled &&
            this._settings.get_boolean('cupertino-unlock-fade') &&
            !isPowerSaver;
    }

    // Guideline EGO-M-008: Documenting use of unlock-dialog.
    // This extension runs in the 'unlock-dialog' session mode to customize the
    // GNOME Shell lock screen. We perform the following modifications:
    // - Replace the default clock widget (dialog._clock) with our WackClock to
    //   display a macOS-style lockscreen clock, wallpaper-tinted and repositioned
    //   via ClockLayoutManager.
    // - Install UnlockDialogController hooks on the UnlockDialog to drive our
    //   custom unlock crossfade animations.
    // - Replace mainBox's layout_manager with WackLayout to reposition the
    //   prompt stack, notifications box, and other-user button.
    // - Apply blur styling to the notifications box (NotificationManager) and
    //   custom rendering to the lockscreen message (LockscreenMessageManager).
    // - Hook Main.screenShield's 'active-changed' signal to refresh the custom
    //   wallpaper overlay, and intercept key-press-event on the dialog for our
    //   Escape-to-sleep and Cupertino rest-state behavior.
    //
    // In this disable() method, we cleanly revert all changes, restore all overridden
    // methods/injections to their original implementations, and destroy/nullify all
    // custom UI elements, ensuring no resource leaks or state contamination in the
    // GNOME Shell session.
    disable() {
        if (Main.screenShield) {
            Main.screenShield.disconnectObject(this);
        }

        this._isActive = false;
        this._wallpaperUpdateSeq = (this._wallpaperUpdateSeq ?? 0) + 1;

        
        

        if (this._bgSettings) {
            this._bgSettings.disconnectObject(this);
            this._bgSettings = null;
        }

        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }

        clearCache();

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

        if (this._unlockDialogController) {
            this._unlockDialogController.uninstall(this._dialog);
            this._unlockDialogController = null;
        }

        if (this._wallpaperManager) {
            this._wallpaperManager.teardown();
            this._wallpaperManager = null;
        }

        if (this._notifManager) {
            this._notifManager.teardownNotifBlur();
            this._notifManager = null;
        }

        if (this._cupertinoPromptManager) {
            this._cupertinoPromptManager.teardown();
            this._cupertinoPromptManager = null;
        }

        if (this._avatarManager) {
            this._avatarManager.teardownCupertinoAvatarOverride();
            this._avatarManager = null;
        }

        if (this._promptStyling) {
            this._promptStyling.teardown();
            this._promptStyling = null;
        }

        if (this._themeManager) {
            this._themeManager.teardown();
            this._themeManager = null;
        }

        resetAnimationActors(this._clockWrapper, this._promptActor);
        const authPrompt = this._dialog?._authPrompt ?? this._dialog?._promptBox?._authPrompt;
        const mainBox = authPrompt?._mainBox;
        if (mainBox) mainBox.opacity = 255;
        if (this._dialog) this._dialog.opacity = 255;

        if (this._wackShellStateChangedId) {
            Main.extensionManager.disconnect(this._wackShellStateChangedId);
            this._wackShellStateChangedId = 0;
        }

        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }

        if (this._powerProfilesProxy) {
            this._powerProfilesProxy.disconnectObject(this);
            this._powerProfilesProxy = null;
        }

        if (this._notifSettings) {
            this._notifSettings.disconnectObject(this);
            this._notifSettings = null;
        }
        this._notifShowInLockScreen = false;

        this._injectionManager?.clear();
        this._injectionManager = null;

        if (this._authPromptAllocationId) {
            if (authPrompt) {
                authPrompt.disconnect(this._authPromptAllocationId);
            }
            this._authPromptAllocationId = 0;
        }

        if (this._dialog) {
            this._dialog._notificationsBox?.disconnectObject(this);
            this._dialog.disconnectObject(this);
        }
        Main.layoutManager.disconnectObject(this);

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        if (this._clockLayoutManager) {
            this._clockLayoutManager.teardown(this._dialog, lockDialogGroup);
            this._clockLayoutManager = null;
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
            if (this._messageManager) {
                this._messageManager.teardown(this._mainBox);
                this._messageManager = null;
            }
            this._mainBox.layout_manager = this._origLayout;
            if (oldLayout && oldLayout !== this._origLayout) oldLayout._extension = null;
            this._mainBox.opacity = 255;
            this._mainBox.queue_relayout();
        }

        this._dialog = null;
        this._originalClock = null;
        this._mainBox = null;
        this._origLayout = null;
        this._showingInhibitHint = false;

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