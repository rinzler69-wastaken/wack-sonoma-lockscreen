import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const DisplayConfigIface = `<node>
<interface name="org.gnome.Mutter.DisplayConfig">
    <property name="PowerSaveMode" type="i" access="readwrite"/>
</interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

const UPowerIface = `<node>
<interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
</interface>
</node>`;
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);

export class UnblankManager {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension._settings;
        this._displayProxy = new DisplayConfigProxy(Gio.DBus.session, 'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', () => {});
        this._upowerProxy = new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower', (proxy, error) => {
            if (error) {
                console.error(`[Sonoma Lockscreen] UPower proxy error: ${error.message}`);
                return;
            }
            this._upowerProxy.connect('g-properties-changed', () => this._onPowerChanged());
            this._onPowerChanged();
        });

        this._originalSetActive = Main.screenShield._setActive;
        this._originalActivateFade = Main.screenShield._activateFade;
        this._originalResetLockScreen = Main.screenShield._resetLockScreen;
        this._originalOnUserBecameActive = Main.screenShield._onUserBecameActive;

        this._pointerMoved = false;
        this._hideLightboxId = 0;
        this._turnOffMonitorId = 0;
        this._inLock = false;
        this._activeOnce = false;

        this._settings.connectObject(
            'changed::enable-unblank', () => this._sync(),
            'changed::unblank-on-ac-only', () => this._sync(),
            'changed::unblank-timeout', () => this._sync(),
            this
        );

        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('enable-unblank');
        this._destroyTimer();
        this._destroyLightboxTimer();

        if (enabled) {
            Main.screenShield._setActive = this._customSetActive.bind(this);
            Main.screenShield._activateFade = this._customActivateFade.bind(this);
            Main.screenShield._resetLockScreen = this._customResetLockScreen.bind(this);
            Main.screenShield._onUserBecameActive = this._customOnUserBecameActive.bind(this);
        } else {
            this._restore();
        }
    }

    _restore() {
        Main.screenShield._setActive = this._originalSetActive;
        Main.screenShield._activateFade = this._originalActivateFade;
        Main.screenShield._resetLockScreen = this._originalResetLockScreen;
        Main.screenShield._onUserBecameActive = this._originalOnUserBecameActive;
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._upowerProxy)
            this._upowerProxy.disconnectObject(this);
        this._destroyTimer();
        this._destroyLightboxTimer();
        this._restore();
        this._displayProxy = null;
        this._upowerProxy = null;
    }

    _isUnblankMode() {
        const acOnly = this._settings.get_boolean('unblank-on-ac-only');
        const onBattery = acOnly && this._upowerProxy && this._upowerProxy.OnBattery;
        return !onBattery;
    }

    _onPowerChanged() {
        if (Main.screenShield._isActive) {
            if (!this._isUnblankMode()) {
                Main.screenShield.emit('active-changed');
                Main.screenShield.activate(false);
                this._activeOnce = true;
            } else {
                this._turnOnMonitor();
            }
        }
    }

    _customSetActive(active) {
        console.log(`[Sonoma Lockscreen] _customSetActive(${active})`);
        let prevIsActive = Main.screenShield._isActive;
        Main.screenShield._isActive = active;
        this._inLock = active;

        if (prevIsActive != Main.screenShield._isActive) {
            if (!this._isUnblankMode() || this._activeOnce) {
                Main.screenShield.emit('active-changed');
                this._activeOnce = false;
            }
        }

        if (active) {
            this._activateTimer();
        } else {
            this._deactivateTimer();
        }

        if (Main.screenShield._loginSession)
            Main.screenShield._loginSession.SetLockedHintRemote(active);

        Main.screenShield._syncInhibitor();
    }

    _customActivateFade(lightbox, time) {
        if (this._inLock)
            return;

        Main.uiGroup.set_child_above_sibling(lightbox, null);
        if (this._isUnblankMode() && !Main.screenShield._isActive) {
            this._activateTimer();
        } else {
            lightbox.lightOn(time);
        }

        if (Main.screenShield._becameActiveId == 0) {
            Main.screenShield._becameActiveId = Main.screenShield.idleMonitor.add_user_active_watch(
                Main.screenShield._onUserBecameActive.bind(Main.screenShield)
            );
        }
    }

    _customOnUserBecameActive() {
        if (Main.screenShield._becameActiveId != 0) {
            Main.screenShield.idleMonitor.remove_watch(Main.screenShield._becameActiveId);
            Main.screenShield._becameActiveId = 0;
        }

        this._destroyLightboxTimer();

        if (Main.screenShield._isActive || Main.screenShield._isLocked) {
            Main.screenShield._longLightbox.lightOff();
            Main.screenShield._shortLightbox.lightOff();
            if (this._activeOnce) {
                // Display was blanked by our timer — wake it immediately and restart countdown
                this._turnOnMonitor();
                this._activeOnce = false;
                this._activateTimer();
            }
        } else {
            Main.screenShield.deactivate(false);
        }
    }

    _customResetLockScreen(params) {
        if (Main.screenShield._lockScreenState != MessageTray.State.HIDDEN)
            return;

        Main.screenShield._lockScreenGroup.show();
        Main.screenShield._lockScreenState = MessageTray.State.SHOWING;

        let fadeToBlack = this._isUnblankMode() ? false : params.fadeToBlack;

        if (params.animateLockScreen) {
            Main.screenShield._lockDialogGroup.translation_y = -global.screen_height;
            Main.screenShield._lockDialogGroup.remove_all_transitions();
            Main.screenShield._lockDialogGroup.ease({
                translation_y: 0,
                duration: Overview.ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    Main.screenShield._lockScreenShown({ fadeToBlack, animateFade: true });
                },
            });
        } else {
            Main.screenShield._lockDialogGroup.translation_y = 0;
            Main.screenShield._lockScreenShown({ fadeToBlack, animateFade: false });
        }

        Main.screenShield._dialog.grab_key_focus();
    }

    _changeToBlank() {
        if (!this._activeOnce) {
            console.log('[Sonoma Lockscreen] Blanking screen now (timeout elapsed)');
            Main.screenShield.emit('active-changed');
            this._activeOnce = true;
            this._turnOffMonitor();
            // Ensure a watch is live so user activity wakes the display promptly
            if (Main.screenShield._becameActiveId == 0) {
                Main.screenShield._becameActiveId = Main.screenShield.idleMonitor.add_user_active_watch(
                    Main.screenShield._onUserBecameActive.bind(Main.screenShield)
                );
            }
        }
    }

    _activateTimer() {
        if (this._turnOffMonitorId > 0)
            return;  // Timer already running — don't restart it
        let timeout = this._settings.get_int('unblank-timeout');
        if (timeout > 0) {
            console.log(`[Sonoma Lockscreen] Unblank timer started: ${timeout}s`);
            this._turnOffMonitorId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._changeToBlank();
                this._turnOffMonitorId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _deactivateTimer() {
        if (this._turnOffMonitorId > 0) {
            GLib.source_remove(this._turnOffMonitorId);
            this._turnOffMonitorId = 0;
        }
    }

    _destroyTimer() {
        this._deactivateTimer();
    }

    _destroyLightboxTimer() {
        if (this._hideLightboxId > 0) {
            GLib.source_remove(this._hideLightboxId);
            this._hideLightboxId = 0;
        }
    }

    _turnOnMonitor() {
        if (this._displayProxy) {
            this._displayProxy.PowerSaveMode = 0;
        }
    }

    _turnOffMonitor() {
        if (this._displayProxy) {
            this._displayProxy.PowerSaveMode = 1;
        }
    }
}
