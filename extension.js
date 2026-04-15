import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import Gettext from 'gettext';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HINT_TIMEOUT = 4; // Seconds before the "swipe to unlock" hint appears
const CROSSFADE_TIME = 300; // Animation duration for transitions

// Visual positioning constants
const CLOCK_TOP_FRACTION = 0.12; // Clock offset from the top (percentage of screen height)
const HINT_VERTICAL_FRACTION = 0.85; // Hint offset from the top
const HINT_NOTIF_MARGIN = 16; // Minimum vertical gap between hint and notifications
const FADE_OUT_SCALE = 0.3; // Scale factor when the clock shrinks during unlock transition

// Background blur settings when entering the password prompt
const PROMPT_BLUR_RADIUS = 50;
const PROMPT_BLUR_BRIGHTNESS = 0.85;
const PROMPT_BLUR_DURATION = 300;

// Individual notification card blur settings
const NOTIF_BLUR_RADIUS = 30;
const NOTIF_BLUR_BRIGHTNESS = 1.0;
const NOTIF_BLUR_NAME = 'wack-notif-blur';

// UI limits
const MAX_VISIBLE_CARDS = 3; // Maximum number of notification cards to show simultaneously

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/**
 * Formats the current date using the system 'date' command for better localization support.
 * If the command fails, it falls back to a standard JavaScript Date string.
 * 
 * @returns {Promise<string>} The formatted date string.
 */
async function getPrettyDate() {
    try {
        const proc = new Gio.Subprocess({
            argv: ['date', '+%A, %B %-d'],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return stdout.trim();
    } catch (e) {
        // Fallback to JS localization if the system call fails
        const now = new Date();
        return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
}

/**
 * WackClock handles the custom clock widget for the lock screen.
 * It manages the time, date, and the interaction hint (e.g., "Swipe up to unlock").
 */
const WackClock = GObject.registerClass(
    class WackClock extends St.BoxLayout {
        _init() {
            super._init({
                style_class: 'unlock-dialog-clock',
                orientation: Clutter.Orientation.VERTICAL,
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
            this._wallClock.connect('notify::clock', this._updateTime.bind(this));

            // Update the hint based on whether the device is in touch mode
            const backend = this.get_context().get_backend();
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

            // Fire up updates
            this._updateTime();
            this._updateDate();
            this._updateHint();

            this.connect('destroy', this._onDestroy.bind(this));
        }

        /**
         * Updates the clock text, stripping AM/PM markers if present.
         */
        _updateTime() {
            this._time.text = this._wallClock.clock.trim().replace(/\s*(AM|PM)\s*/i, '');
        }

        /**
         * Refreshes the date label using the formatted system date.
         */
        async _updateDate() {
            this._dateOutput.text = await getPrettyDate();
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
         * Clean up timers, monitors, and signal handlers.
         */
        _onDestroy() {
            this._wallClock.run_dispose();
            this._idleMonitor.remove_watch(this._idleWatchId);
            if (this._dateTimeoutId)
                GLib.source_remove(this._dateTimeoutId);
        }
    });

/**
 * WackLayout is a custom layout manager for the screen shield's main box.
 * It ensures that the clock and notifications are positioned correctly,
 * especially when the unlock prompt is visible.
 */
const WackLayout = GObject.registerClass(
    class WackLayout extends Clutter.LayoutManager {
        _init(stack, notifications, switchUserButton) {
            super._init();
            this._stack = stack;
            this._notifications = notifications;
            this._switchUserButton = switchUserButton;
        }

        /**
         * Standard Clutter layout delegation for width requests.
         */
        vfunc_get_preferred_width(container, forHeight) {
            return this._stack.get_preferred_width(forHeight);
        }

        /**
         * Standard Clutter layout delegation for height requests.
         */
        vfunc_get_preferred_height(container, forWidth) {
            return this._stack.get_preferred_height(forWidth);
        }

        /**
         * Orchestrates the spatial arrangement of the lock screen UI elements.
         * This is called by Clutter whenever the main box needs to be laid out.
         */
        vfunc_allocate(container, box) {
            const [width, height] = box.get_size();
            const tenthOfHeight = height / 10.0;

            const [, , stackWidth, stackHeight] = this._stack.get_preferred_size();
            const [, , notificationsWidth, notificationsHeight] = this._notifications.get_preferred_size();

            const columnWidth = Math.max(stackWidth, notificationsWidth);
            const columnX1 = Math.floor((width - columnWidth) / 2.0);
            const actorBox = new Clutter.ActorBox();

            // Calculate maximum allowed height for notifications to prevent overlap
            const maxNotificationsHeight = Math.min(
                notificationsHeight,
                height - tenthOfHeight - stackHeight);
            actorBox.x1 = columnX1;
            actorBox.y1 = height - maxNotificationsHeight;
            actorBox.x2 = columnX1 + columnWidth;
            actorBox.y2 = actorBox.y1 + maxNotificationsHeight;
            this._notifications.allocate(actorBox);

            // Position the stack (which contains the auth prompt)
            const stackY = Math.min(
                Math.floor(height / 3.0),
                height - stackHeight - maxNotificationsHeight);
            actorBox.x1 = columnX1;
            actorBox.y1 = stackY;
            actorBox.x2 = columnX1 + columnWidth;
            actorBox.y2 = stackY + stackHeight;
            this._stack.allocate(actorBox);

            // Position the "Switch User" button if it's visible
            if (this._switchUserButton.visible) {
                const [, , natWidth, natHeight] = this._switchUserButton.get_preferred_size();
                const textDirection = this._switchUserButton.get_text_direction();
                if (textDirection === Clutter.TextDirection.RTL)
                    actorBox.x1 = box.x1 + natWidth;
                else
                    actorBox.x1 = box.x2 - (natWidth * 2);
                actorBox.y1 = box.y2 - (natHeight * 2);
                actorBox.x2 = actorBox.x1 + natWidth;
                actorBox.y2 = actorBox.y1 + natHeight;
                this._switchUserButton.allocate(actorBox);
            }
        }
    });

export default class WackLockscreenClockExtension extends Extension {
    enable() {
        const dialog = Main.screenShield._dialog;
        if (!dialog) return;

        this._dialog = dialog;
        this._originalClock = dialog._clock;
        this._injectionManager = new InjectionManager();
        const lockDialogGroup = Main.screenShield._lockDialogGroup;

        // Initialize background effects.
        // We override the default blur behavior to allow for more controlled animations.
        this._origUpdateBgEffects = dialog._updateBackgroundEffects.bind(dialog);
        dialog._updateBackgroundEffects = () => {
            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({ brightness: 1.0, radius: 0 });
            }
        };
        dialog._updateBackgroundEffects();

        this._notifHeightId = dialog._notificationsBox.connect('notify::height', () => {
            this._positionHint();
            this._positionOverflow();
        });
        this._notifVisibleId = dialog._notificationsBox.connect('notify::visible', () => {
            this._positionHint();
            this._positionOverflow();
        });

        // Handle background blur animations during transitions between clock and prompt.
        this._injectionManager.overrideMethod(
            dialog, '_showPrompt',
            (original) => {
                const self = this;
                return function (...args) {
                    original.call(this, ...args);
                    self._onPromptShow();
                };
            }
        );

        this._injectionManager.overrideMethod(
            dialog, '_showClock',
            (original) => {
                const self = this;
                return function (...args) {
                    original.call(this, ...args);
                    self._onPromptHide();
                };
            }
        );

        // Seamlessly replace the default shell clock with our custom WackClock instance.
        dialog._stack.remove_child(dialog._clock);
        dialog._clock = new WackClock();
        dialog._clock.set_pivot_point(0.5, 0.5);
        lockDialogGroup.add_child(dialog._clock);
        this._positionClock();

        // Reparent hint into lockDialogGroup
        const hint = dialog._clock._hint;
        lockDialogGroup.add_child(hint);
        this._hint = hint;
        // _hintText caches the real hint string so overflow can inherit it
        this._hintText = hint.text;
        // keep hint text in sync if seat touch-mode changes
        this._hintTextSyncId = hint.connect('notify::text', () => {
            if (!this._overflowActive)
                this._hintText = hint.text;
        });
        // hard wall — if idle watch tries to show hint while prompt is active, kill it
        this._hintOpacityGuardId = hint.connect('notify::opacity', () => {
            if (this._promptActive && hint.opacity > 0)
                hint.set_opacity(0);
        });
        this._positionHint();

        // Initialize an overflow label to show when there are too many notifications.
        // This label replaces the hint when necessary.
        this._overflowLabel = new St.Label({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 255,
            visible: false,
        });
        this._overflowActive = false;
        lockDialogGroup.add_child(this._overflowLabel);
        this._positionOverflow();



        // Configure individual background blurs for each notification card.
        this._lastPlayingPlayer = null;
        this._promptActive = false;
        this._setupNotifBlur(dialog._notificationsBox);

        // Monitor changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
            this._positionOverflow();
        });

        // Patch the transition logic to implement our custom clock scaling and prompt blur transition
        this._origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this._origSetTransitionProgress(progress);

            // 1. Clock: scale in place
            const clockOpacity = Math.round(255 * (1 - progress));
            const clockScale = FADE_OUT_SCALE + (1 - FADE_OUT_SCALE) * (1 - progress);
            dialog._clock.set({
                opacity: clockOpacity,
                scale_x: clockScale,
                scale_y: clockScale,
                translation_y: 0,
            });

            // 2. Global Background: Blur IN
            const globalBlur = PROMPT_BLUR_RADIUS * progress;
            const globalBrightness = 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;

            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({ radius: globalBlur, brightness: globalBrightness });
            }

            // 3. Notification Cards: Blur OUT (Crossfade)
            const cardBlur = NOTIF_BLUR_RADIUS * (1 - progress);
            if (this._notifBox) {
                // Standard Cards
                this._notifBox._notificationBox.get_children().forEach(child => {
                    let effect = child.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                });

                // Media Cards
                this._notifBox._players.values().forEach(msg => {
                    let effect = msg.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                });
            }

            // 4. Label Management
            const activeLabel = this._overflowActive ? this._overflowLabel : this._hint;
            if (progress > 0) {
                activeLabel.opacity = 0;
                if (this._overflowLabel) this._overflowLabel.visible = false;
            } else if (progress === 0) {
                if (this._overflowActive) {
                    this._overflowLabel.visible = true;
                    this._overflowLabel.opacity = 255;
                }
                this._enforceCardLimit(this._notifBox);
            }
        };

        // Apply our custom layout manager to the main lock screen container.
        const mainBox = dialog.get_child_at_index(dialog.get_n_children() - 1);
        if (mainBox) {
            this._origLayout = mainBox.layout_manager;
            mainBox.layout_manager = new WackLayout(
                dialog._stack,
                dialog._notificationsBox,
                dialog._otherUserButton);
            mainBox.queue_relayout();
            this._mainBox = mainBox;
        }
    }

    /**
     * Creates a new blur effect for notification cards.
     * 
     * @returns {Shell.BlurEffect} The configured blur effect.
     */
    _makeCardBlur() {
        return new Shell.BlurEffect({
            name: NOTIF_BLUR_NAME,
            mode: Shell.BlurMode.BACKGROUND,
            radius: NOTIF_BLUR_RADIUS,
            brightness: NOTIF_BLUR_BRIGHTNESS,
        });
    }

    /**
     * Attaches a blur effect to a notification actor if it doesn't already have one.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */
    _addCardBlur(actor) {
        if (!actor.get_effect(NOTIF_BLUR_NAME))
            actor.add_effect(this._makeCardBlur());
    }

    /**
     * Removes the custom blur effect from a notification actor.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */
    _removeCardBlur(actor) {
        const effect = actor.get_effect(NOTIF_BLUR_NAME);
        if (effect) actor.remove_effect(effect);
    }

    /**
     * Toggles the enabled state of blur effects across all current notifications.
     * 
     * @param {boolean} enabled Whether the blurs should be active.
     */
    _setNotifBlursEnabled(enabled) {
        const nb = this._dialog?._notificationsBox;
        if (!nb) return;
        for (const child of nb._notificationBox) {
            const effect = child.get_effect(NOTIF_BLUR_NAME);
            if (effect) effect.set_enabled(enabled);
        }
        for (const msg of nb._players.values()) {
            const effect = msg.get_effect(NOTIF_BLUR_NAME);
            if (effect) effect.set_enabled(enabled);
        }
    }

    /**
     * Checks if a given actor represents a media player card.
     * 
     * @param {object} nb The notifications box.
     * @param {Clutter.Actor} actor The actor to check.
     * @returns {boolean} True if it's a media card.
     */
    _isMediaCard(nb, actor) {
        for (const msg of nb._players.values()) {
            if (msg === actor) return true;
        }
        return false;
    }

    /**
     * Retrieves the media player associated with a specific UI actor.
     * 
     * @param {object} nb The notifications box.
     * @param {Clutter.Actor} actor The UI actor.
     * @returns {object|null} The media player object, or null if not found.
     */
    _getMediaPlayer(nb, actor) {
        for (const [player, msg] of nb._players.entries()) {
            if (msg === actor) return player;
        }
        return null;
    }

    /**
     * Ensures only one media player is visible at a time, prioritizing active sessions.
     * 
     * @param {object} nb The notifications box.
     */
    _enforceMediaLimit(nb) {
        // Priority logic for media cards:
        // 1. Currently playing player that was most recently active.
        // 2. Any other currently playing player.
        // 3. The last player to have been playing (even if now paused).
        // 4. Default to the first available player.
        const players = [...nb._players.entries()];

        // Hide all players initially
        for (const [, msg] of players) msg.visible = false;

        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg && this._lastPlayingPlayer.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        for (const [player, msg] of players) {
            if (player.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg) { msg.visible = true; return; }
        }

        const firstMsg = nb._players.values().next().value;
        if (firstMsg) firstMsg.visible = true;
    }

    /**
     * Sets up signal handlers to manage blurs and visibility for the notification container.
     * 
     * @param {object} nb The notifications box.
     */
    _setupNotifBlur(nb) {
        // Identify which media player was last playing to set initial priority
        for (const [player] of nb._players.entries()) {
            if (player.status === 'Playing')
                this._lastPlayingPlayer = player;
        }

        // Initialize blur effects and visibility constraints for existing notifications
        for (const child of nb._notificationBox.get_children())
            this._addCardBlur(child);
        this._enforceCardLimit(nb);

        // Listen for new notifications being added
        this._actorAddedId = nb._notificationBox.connect('child-added', (container, actor) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._addCardBlur(actor);

                const player = this._getMediaPlayer(nb, actor);
                if (player) {
                    // Track playback status to prioritize active media players in the UI
                    let prevStatus = player.status;
                    const id = player.connect('changed', () => {
                        const newStatus = player.status;
                        if (newStatus === 'Playing' && prevStatus !== 'Playing')
                            this._lastPlayingPlayer = player;
                        prevStatus = newStatus;
                        this._enforceCardLimit(nb);
                    });
                    if (!this._playerSignalIds) this._playerSignalIds = new Map();
                    this._playerSignalIds.set(player, id);
                    if (player.status === 'Playing')
                        this._lastPlayingPlayer = player;
                } else {
                    // Re-enforce limits if the shell explicitly changes a card's visibility
                    const visId = actor.connect('notify::visible', () => {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            this._enforceCardLimit(nb);
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    if (!this._cardVisSignalIds) this._cardVisSignalIds = new Map();
                    this._cardVisSignalIds.set(actor, visId);
                }
                this._enforceCardLimit(nb);
                return GLib.SOURCE_REMOVE;
            });
        });

        // Listen for notifications being removed
        this._actorRemovedId = nb._notificationBox.connect('child-removed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._enforceCardLimit(nb);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._notifBox = nb;
    }

    /**
     * Manages the visibility of notification cards to respect the defined limits.
     * 
     * @param {object} nb The notifications box.
     */
    _enforceCardLimit(nb) {
        this._enforceMediaLimit(nb);

        const children = nb._notificationBox.get_children();
        let notifCount = 0;
        let hiddenCount = 0;

        const shellVisible = new Set();
        // Determine which notifications are actually intended to be shown by GNOME Shell
        for (const [source, obj] of nb._sources.entries()) {
            if (obj.sourceBox && source.unseenCount > 0 && obj.visible) {
                shellVisible.add(obj.sourceBox);
            }
        }

        children.forEach(child => {
            if (!child || this._isMediaCard(nb, child)) return;

            // Hide notifications that don't meet the shell's visibility criteria
            if (!shellVisible.has(child)) {
                child.visible = false;
                return;
            }

            // Limit the total number of visible notification cards
            if (notifCount < MAX_VISIBLE_CARDS) {
                child.visible = true;
            } else {
                child.visible = false;
                hiddenCount++;
            }
            notifCount++;
        });

        this._updateOverflow(hiddenCount);
    }

    /**
     * Updates the text and visibility of the notification overflow label.
     * 
     * @param {number} hiddenCount The number of hidden notifications.
     */
    _updateOverflow(hiddenCount) {
        if (!this._overflowLabel) return;

        // Hide the overflow label if the auth prompt is shown
        const progress = this._dialog._adjustment.value;
        if (progress > 0 || this._promptActive) {
            this._overflowLabel.visible = false;
            this._overflowLabel.opacity = 0;
            return;
        }

        // Revert to standard hint if no notifications are overflowing
        if (hiddenCount <= 0) {
            this._overflowActive = false;
            this._overflowLabel.visible = false;
            this._hint.visible = true;
            return;
        }

        this._overflowActive = true;
        this._hint.visible = false;
        this._hint.set_opacity(0);

        // Attempt to localize the "More" text
        let moreText = Gettext.pgettext('calendar', 'More').toLowerCase();
        if (moreText === 'more') {
            moreText = shellGettext('More').toLowerCase();
        }

        const overflowText = `${hiddenCount}+ ${moreText}`;
        this._overflowLabel.text = `${overflowText}  ·  ${this._hintText}`;
        this._overflowLabel.visible = true;
        this._overflowLabel.set_opacity(255);
        this._positionOverflow();
    }

    /**
     * Positions the overflow label relative to the screen and notifications.
     */
    _positionOverflow() {
        if (!this._overflowLabel) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const [, natWidth] = this._overflowLabel.get_preferred_width(-1);
        const [, natHeight] = this._overflowLabel.get_preferred_height(-1);

        const notifBox = this._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitor.y + Math.floor(monitor.height * HINT_VERTICAL_FRACTION);
        const notifTop = monitor.y + monitor.height - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);
        const x = monitor.x + Math.floor((monitor.width - natWidth) / 2);

        this._overflowLabel.set_position(x, y);
    }

    /**
     * Reverts all notification-related changes when the extension is disabled.
     */
    _teardownNotifBlur() {
        const nb = this._notifBox;
        if (!nb) return;

        if (this._actorAddedId) {
            nb._notificationBox.disconnect(this._actorAddedId);
            this._actorAddedId = null;
        }

        if (this._actorRemovedId) {
            nb._notificationBox.disconnect(this._actorRemovedId);
            this._actorRemovedId = null;
        }

        if (this._playerSignalIds) {
            for (const [player, id] of this._playerSignalIds.entries()) {
                try { player.disconnect(id); } catch (_) { }
            }
            this._playerSignalIds = null;
        }

        if (this._cardVisSignalIds) {
            for (const [actor, id] of this._cardVisSignalIds.entries()) {
                try { actor.disconnect(id); } catch (_) { }
            }
            this._cardVisSignalIds = null;
        }

        // Explicitly restore visibility and remove effects from all cards
        for (const child of nb._notificationBox.get_children()) {
            child.visible = true;
            this._removeCardBlur(child);
        }
        for (const msg of nb._players.values())
            msg.visible = true;

        this._notifBox = null;
    }

    /**
     * Triggered when the authentication prompt begins to show.
     * Initiates the background blur transition.
     */
    _onPromptShow() {
        this._promptActive = true;

        for (const widget of this._dialog._backgroundGroup) {
            widget.ease_property('@effects.blur.radius', PROMPT_BLUR_RADIUS, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            widget.ease_property('@effects.blur.brightness', PROMPT_BLUR_BRIGHTNESS, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Triggered when the clock view returns.
     * Removes background blur and re-enforces notification card limits.
     */
    _onPromptHide() {
        this._promptActive = false;
        if (this._notifBox)
            this._enforceCardLimit(this._notifBox);

        for (const widget of this._dialog._backgroundGroup) {
            widget.ease_property('@effects.blur.radius', 0, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            widget.ease_property('@effects.blur.brightness', 1.0, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Calculates and sets the position of the custom clock on the primary monitor.
     */
    _positionClock() {
        const clock = this._dialog?._clock;
        if (!clock) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        clock.set_position(monitor.x, monitor.y + Math.floor(monitor.height * CLOCK_TOP_FRACTION));
        clock.set_width(monitor.width);
    }

    /**
     * Positions the interaction hint relative to the notifications area.
     */
    _positionHint() {
        if (!this._hint) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const [, natWidth] = this._hint.get_preferred_width(-1);
        const [, natHeight] = this._hint.get_preferred_height(-1);

        const notifBox = this._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitor.y + Math.floor(monitor.height * HINT_VERTICAL_FRACTION);
        const notifTop = monitor.y + monitor.height - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);

        const x = monitor.x + Math.floor((monitor.width - natWidth) / 2);
        this._hint.set_position(x, y); this._hint.set_width(natWidth);
    }

    /**
     * Cleans up all modifications and returns the GNOME Shell lock screen to its original state.
     */
    disable() {
        if (!this._dialog) return;

        // Restore the original background effect update method
        if (this._origUpdateBgEffects) {
            this._dialog._updateBackgroundEffects = this._origUpdateBgEffects;
            this._origUpdateBgEffects = null;
            this._dialog._updateBackgroundEffects();
        }

        this._teardownNotifBlur();

        // Restore the original transition progress handler
        if (this._origSetTransitionProgress) {
            this._dialog._setTransitionProgress = this._origSetTransitionProgress;
            this._origSetTransitionProgress = null;
        }

        // Remove all method injections
        this._injectionManager?.clear();
        this._injectionManager = null;

        // Disconnect from UI signals
        if (this._notifHeightId) {
            this._dialog._notificationsBox?.disconnect(this._notifHeightId);
            this._notifHeightId = null;
        }
        if (this._notifVisibleId) {
            this._dialog._notificationsBox?.disconnect(this._notifVisibleId);
            this._notifVisibleId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        // Restore the standard interaction hint
        if (this._hint) {
            if (this._hintTextSyncId) {
                this._hint.disconnect(this._hintTextSyncId);
                this._hintTextSyncId = null;
            }
            if (this._hintOpacityGuardId) {
                this._hint.disconnect(this._hintOpacityGuardId);
                this._hintOpacityGuardId = null;
            }
            this._hint.visible = true;
            lockDialogGroup?.remove_child(this._hint);
            this._hint = null;
        }

        // Remove our custom overflow label
        if (this._overflowLabel) {
            lockDialogGroup?.remove_child(this._overflowLabel);
            this._overflowLabel.destroy();
            this._overflowLabel = null;
        }

        // Destroy our custom clock and restore the original shell clock
        if (this._dialog._clock) {
            lockDialogGroup?.remove_child(this._dialog._clock);
            this._dialog._clock.destroy();
            this._dialog._clock = null;
        }

        this._dialog._clock = this._originalClock;
        this._dialog._stack.add_child(this._originalClock);

        // Restore the original layout manager for the main container
        if (this._mainBox && this._origLayout) {
            this._mainBox.layout_manager = this._origLayout;
            this._mainBox.queue_relayout();
        }

        // Reset all internal state
        this._dialog = null;
        this._originalClock = null;
        this._mainBox = null;
        this._origLayout = null;
        this._hintOpacity = 0;
        this._activeLabelOpacity = 0;
        this._overflowActive = false;
        this._hintText = null;
        this._lastPlayingPlayer = null;
    }
}