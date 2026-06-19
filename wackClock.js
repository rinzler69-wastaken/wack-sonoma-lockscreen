import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gettext from 'gettext';

import { HINT_TIMEOUT, CROSSFADE_TIME, getPrettyDate } from './constants.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));

/**
 * WackClock handles the custom clock widget for the lock screen.
 * It manages the time, date, and the interaction hint (e.g., "Swipe up to unlock").
 */
export const WackClock = GObject.registerClass(
    class WackClock extends St.BoxLayout {
        _init() {
            super._init({
                style_class: 'unlock-dialog-clock',
                vertical: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // Initialize UI components for the clock
            this._dateOutput = new St.Label({
                style_class: 'wack-date',
                x_align: Clutter.ActorAlign.CENTER,
            });

            this._time = new St.Label({
                style_class: 'unlock-dialog-clock-time wack-time',
                x_align: Clutter.ActorAlign.CENTER,
            });

            this._hint = new St.Label({
                style_class: 'unlock-dialog-clock-hint',
                x_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
                visible: true,
            });

            this.add_child(this._dateOutput);
            this.add_child(this._time);

            // Setup the wall clock to update every minute
            this._wallClock = new GnomeDesktop.WallClock({ time_only: true });
            this._wallClock.connectObject('notify::clock',
                this._updateTime.bind(this), this);

            // 12h/24h preference — may be overridden externally via setClockFormat()
            // for GDM where the system dconf doesn't reflect the user's own setting.
            this._clockFormatOverride = null;
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._interfaceSettings.connectObject(
                'changed::clock-format', () => this._updateTime(), this);

            // Update the hint based on whether the device is in touch mode
            // get_context() was added in GNOME 48; fall back to Clutter.get_default_backend() on 47.
            const backend = this.get_context?.().get_backend() ?? Clutter.get_default_backend();
            this._seat = backend.get_default_seat();
            this._seat.connectObject('notify::touch-mode',
                this._updateHint.bind(this), this);

            // Handle power save mode changes to prevent flicker
            this._monitorManager = global.backend.get_monitor_manager();
            this._monitorManager.connectObject('power-save-mode-changed',
                () => (this._hint.opacity = 0), this);

            // Show the hint only after a period of user inactivity
            this._idleMonitor = global.backend.get_core_idle_monitor();
            this._idleWatchId = this._idleMonitor.add_idle_watch(HINT_TIMEOUT * 1000, () => {
                this._hint.ease({ opacity: 255, duration: CROSSFADE_TIME });
            });

            // Periodically refresh the date string
            this._dateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60,
                () => { this._updateDate(); return GLib.SOURCE_CONTINUE; });

            this._updateTime();
            this._updateDate();
            this._updateHint();
        }

        /**
         * Override the 12h/24h format independently of the system gsettings.
         * Used by GdmManager to inject the last logged-in user's preference.
         * Pass null to revert to the system setting.
         * @param {'12h'|'24h'|null} format
         */
        setClockFormat(format) {
            this._clockFormatOverride = format;
            this._updateTime();
        }

        _updateTime() {
            const clockFormat = this._clockFormatOverride
                ?? this._interfaceSettings.get_string('clock-format');

            const now = GLib.DateTime.new_now_local();

            if (clockFormat === '12h') {
                // %-I strips leading zero on hour (Linux only)
                this._time.text = now.format('%-I:%M');
            } else {
                this._time.text = now.format('%H:%M');
            }
        }

        _updateDate() {
            this._dateOutput.text = getPrettyDate();
        }

        /**
         * Standardizes the unlock hint text for desktop and touch devices.
         */
        _updateHint() {
            this._hint.text = this._seat.touch_mode
                ? shellGettext('Swipe up to unlock')
                : shellGettext('Click or press a key to unlock');
        }

        /**
         * Gets the relative luminance of the clock's current base text color.
         * @returns {number}
         */
        getTextLuminance() {
            return 1.0; // Statically white text
        }

        setWallpaperAlpha(alpha) {
            try {
                this._time.set_style(`color: rgba(255, 255, 255, ${alpha});`);
                this._dateOutput.set_style(`color: rgba(255, 255, 255, ${alpha});`);
            } catch (e) {
                console.error(`[WACK/Clock] Failed to set wallpaper alpha: ${e}`);
            }
        }



        /**
         * Clean up timers, monitors, and signal handlers.
         */
        destroy() {
            this._wallClock.disconnectObject(this);
            this._wallClock = null;

            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
            this._clockFormatOverride = null;

            this._seat.disconnectObject(this);
            this._seat = null;

            this._monitorManager.disconnectObject(this);
            this._monitorManager = null;

            if (this._idleMonitor && this._idleWatchId) {
                this._idleMonitor.remove_watch(this._idleWatchId);
                this._idleWatchId = null;
            }
            this._idleMonitor = null;

            if (this._dateTimeoutId) {
                GLib.source_remove(this._dateTimeoutId);
                this._dateTimeoutId = null;
            }

            super.destroy();
        }
    });
