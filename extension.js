import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
let Blur = null;
try {
    Blur = (await import('gi://Blur')).default;
} catch (_) {
    // gnome-rounded-blur not installed — falling back to Shell.BlurEffect
}

import Gettext from 'gettext';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
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
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';

const HINT_TIMEOUT = 4; // Seconds before the "swipe to unlock" hint appears
const CROSSFADE_TIME = 500; // Animation duration for transitions

// Visual positioning constants
const DATETIME_TOP_FRACTION = 0.09; // Date/Time offset from the top (percentage of screen height)
const HINT_VERTICAL_FRACTION = 0.875; // Hint offset from the top
const HINT_NOTIF_MARGIN = 16; // Minimum vertical gap between hint and notifications
const FADE_OUT_SCALE = 0.3; // Scale factor when the clock shrinks during unlock transition

// Date label height/gap from the clock
const DATE_LABEL_HEIGHT = 25;

// Background blur settings when entering the password prompt
const PROMPT_BLUR_RADIUS = 50;
const PROMPT_BLUR_BRIGHTNESS = 0.85;
const PROMPT_BLUR_DURATION = 300;

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.wack-lockscreen-clock';

// Individual notification card blur settings
const NOTIF_BLUR_RADIUS = 30;
const NOTIF_BLUR_BRIGHTNESS = 1.0;
const NOTIF_BLUR_NAME = 'wack-notif-blur';
const NOTIF_CARD_RADIUS = 12;

// Cupertino mode prompt positioning
const CUPERTINO_PROMPT_VERTICAL_FRACTION = 0.86; // Prompt center Y as fraction of screen height
// UI limits
const MAX_VISIBLE_CARDS = 3; // Maximum number of notification cards to show simultaneously

function getPrettyDate() {
    try {
        const now = GLib.DateTime.new_now_local();
        const day = now.get_day_of_month();
        return `${now.format('%A, %B')} ${day}`;
    } catch (e) {
        const now = new Date();
        return now.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
        });
    }
}



const WackCupertinoRestPrompt = GObject.registerClass(
    class WackCupertinoRestPrompt extends St.BoxLayout {
        _init(user) {
            super._init({
                style_class: 'login-dialog-prompt-layout',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });

            this._userWell = new St.Bin({
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._userWell);

            // Inline hint label — mirrors the regular unlock hint but is
            // anchored to the user widget stack instead of floating separately.
            // Only visible in rest state (no notif cards); fades out on prompt.
            this._hintLabel = new St.Label({
                style_class: 'wack-cupertino-hint',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                opacity: 255,
                text: '',
            });
            this._hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._hintLabel.clutter_text.line_wrap = true;
            this.add_child(this._hintLabel);

            this.setUser(user);
        }

        setUser(user) {
            let oldChild = this._userWell.get_child();
            if (oldChild)
                oldChild.destroy();

            let userWidget = new UserWidget.UserWidget(user, Clutter.Orientation.VERTICAL);
            // Headless: keep the avatar for spacing but make it invisible
            if (userWidget._avatar)
                userWidget._avatar.opacity = 0;
            this._userWell.set_child(userWidget);
        }

        setHintText(text) {
            if (this._hintLabel)
                this._hintLabel.text = text ?? '';
        }
    });

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
            this._wallClockId = this._wallClock.connect('notify::clock',
                this._updateTime.bind(this));

            // Track 12h/24h preference so we can un-pad hours in 24h mode.
            // Reading system schema (org.gnome.desktop.interface) — no custom .gschema.xml needed
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._clockFormatChangedId = this._interfaceSettings.connect(
                'changed::clock-format',
                () => this._updateTime()
            );

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

            this._updateTime();
            this._updateDate();
            this._updateHint();

            this.connect('destroy', this._onDestroy.bind(this));
        }

        _updateTime() {
            const raw = this._wallClock.clock.trim();
            let timeText = raw.replace(/\s*(AM|PM)\s*/i, '').trim();

            this._time.text = timeText;
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
         * Clean up timers, monitors, and signal handlers.
         */
        _onDestroy() {
            if (this._wallClockId) {
                this._wallClock.disconnect(this._wallClockId);
                this._wallClockId = null;
            }
            this._wallClock = null;

            if (this._clockFormatChangedId) {
                this._interfaceSettings.disconnect(this._clockFormatChangedId);
                this._clockFormatChangedId = null;
            }
            this._interfaceSettings = null;

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
        _init(extension, stack, notifications, switchUserButton) {
            super._init();
            this._extension = extension;
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
            let stackY;
            if (this._extension._lockscreenMode === 'cupertino') {
                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const refHeight = 180 * scaleFactor;
                stackY = Math.floor(height * CUPERTINO_PROMPT_VERTICAL_FRACTION) - Math.floor(refHeight / 2);
            } else {
                stackY = Math.min(
                    Math.floor(height / 3.0),
                    height - stackHeight - maxNotificationsHeight);
            }

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
        this._idleSources = new Set();
        this._settingsSignals = [];
        this._clockAnimation = DEFAULT_CLOCK_ANIMATION;
        this._promptAnimation = DEFAULT_PROMPT_ANIMATION;
        this._lockscreenMode = 'wack';
        this._cupertinoAlwaysShowUser = false;
        this._cupertinoShowNotifsOverride = false; // Toggled via Shift+N
        this._animationState = createAnimationState();
        this._loadSettings();
        const lockDialogGroup = Main.screenShield._lockDialogGroup;

        // Initialize background effects.
        // We override _updateBackgroundEffects to prevent the shell from re-applying
        // its default BLUR_BRIGHTNESS/BLUR_RADIUS values and stomping our transitions.
        // The 'blur' effect itself is created in _createBackground, so get_effect('blur')
        // is always valid — we just hard-zero it here and let _setTransitionProgress drive it.
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

        // Seamlessly replace the default shell clock with our custom WackClock instance.
        dialog._stack.remove_child(dialog._clock);
        dialog._clock = new WackClock();
        lockDialogGroup.add_child(dialog._clock);

        // Decouple date and time into a wrapper actor so they scale as one package
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
        this._timeTextId = timeLabel.connect('notify::text', () => this._positionClock());
        this._positionClock();

        // Create a parent container actor for hint and overflow labels
        this._hintContainer = new Clutter.Actor();
        lockDialogGroup.add_child(this._hintContainer);

        // Reparent hint into hints container
        const hint = dialog._clock._hint;
        this._hintContainer.add_child(hint);
        this._hint = hint;
        // _hintText caches the real hint string so overflow can inherit it
        this._hintText = hint.text;
        // keep hint text in sync if seat touch-mode changes
        this._hintTextSyncId = hint.connect('notify::text', () => {
            if (!this._overflowActive)
                this._hintText = hint.text;
        });

        // Guard: kill any idle-watch ease on the hint when it should be suppressed
        this._hintOpacityGuardId = hint.connect('notify::opacity', () => {
            const hasNotifs = this._hasVisibleNotifs();
            const suppressHint = this._promptActive ||
                (this._lockscreenMode === 'cupertino' && !hasNotifs && !this._overflowActive);
            if (suppressHint && hint.opacity > 0) {
                hint.remove_all_transitions();
                hint.set_opacity(0);
            }
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
        this._hintContainer.add_child(this._overflowLabel);
        this._positionOverflow();



        // Configure individual background blurs for each notification card.
        this._lastPlayingPlayer = null;
        this._promptActive = false;
        this._setupNotifBlur(dialog._notificationsBox);
        this._promptActor = dialog._promptBox ?? dialog._stack;
        this._promptActor?.set_pivot_point(0.5, 0.5);

        this._keyPressId = dialog.connect('key-press-event', (actor, event) => {
            if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser && !this._promptActive) {
                const keysym = event.get_key_symbol();
                const state = event.get_state();
                const shiftPressed = (state & imports.gi.Clutter.ModifierType.SHIFT_MASK) !== 0;

                if (shiftPressed && (keysym === imports.gi.Clutter.KEY_N || keysym === imports.gi.Clutter.KEY_n)) {
                    this._cupertinoShowNotifsOverride = !this._cupertinoShowNotifsOverride;
                    this._updateCupertinoRestState(true);
                    return imports.gi.Clutter.EVENT_STOP;
                }
            }
            return imports.gi.Clutter.EVENT_PROPAGATE;
        });

        this._applyPromptModeLayout();

        // Monitor changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
            this._positionOverflow();
            this._applyPromptModeLayout();
        });

        // Patch the transition logic to implement our custom clock scaling and prompt blur transition
        this._origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this._origSetTransitionProgress(progress);

            // Swipe gestures bypass _showPrompt/_showClock entirely, so derive
            // _promptActive from progress to keep the hint guard working correctly,
            // and manually fire _showPrompt/_showClock so other extensions hooking
            // those methods (e.g. LiveLockscreen) stay in sync on swipe gestures
            const wasActive = this._promptActive;
            this._promptActive = progress > 0;
            if (this._promptActive && !wasActive) {
                this._onPromptShow();
                // Fire _showPrompt with adjustment stubbed so LLS and other hooks
                // run without re-triggering the ease transition
                const origEase = dialog._adjustment.ease.bind(dialog._adjustment);
                dialog._adjustment.ease = () => { };
                dialog._showPrompt();
                dialog._adjustment.ease = origEase;
            } else if (!this._promptActive && wasActive) {
                this._onPromptHide();
                const origEase = dialog._adjustment.ease.bind(dialog._adjustment);
                dialog._adjustment.ease = () => { };
                dialog._showClock();
                dialog._adjustment.ease = origEase;
            }

            // ── Global Background Blur (both modes) ────────────────────────
            // Shell.BlurEffect radius is in physical pixels, scale by scaleFactor.
            // Cupertino mode explicitly zeroes blur — clean and deliberate, not accidental.
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const isCupertino = this._lockscreenMode === 'cupertino';
            const globalBlur = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress;
            const globalBrightness = isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;

            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({ radius: globalBlur, brightness: globalBrightness });
            }

            const hasNotifs = this._hasVisibleNotifs();

            // Notification Cards: Blur OUT (Crossfade)
            const cardBlur = hasNotifs ? NOTIF_BLUR_RADIUS * (1 - progress) : 0;
            if (this._notifBox) {
                this._notifBox._notificationBox.get_children().forEach(child => {
                    let effect = child.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                });
                this._notifBox._players.values().forEach(msg => {
                    let effect = msg.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        effect.set({ radius: cardBlur });
                        effect.set_enabled(cardBlur > 0.5);
                    }
                });
            }

            const notifOpacity = hasNotifs ? Math.round(255 * (1 - progress)) : 0;

            // Hint/Overflow container opacity
            if (this._hintContainer) {
                this._hintContainer.opacity = isCupertino
                    ? notifOpacity
                    : (progress > 0 ? 0 : 255);
            }

            if (isCupertino) {
                // ── Cupertino mode ──────────────────────────────────────────
                const mainBox = this._dialog?._promptBox?._authPrompt?._mainBox;

                // Headless architecture: the persistent avatar NEVER fades during
                // rest <-> prompt transitions if there are NO notifications.
                // If there ARE notifications, it crossfades so it's solid at prompt and hidden at rest.
                if (this._cupertinoAvatarContainer) {
                    this._cupertinoAvatarContainer.opacity = hasNotifs ? Math.round(255 * progress) : 255;
                    this._cupertinoAvatarContainer.visible = progress > 0 || !hasNotifs;
                }

                // Both rest container and prompt container cross-fade smoothly below the avatar
                if (this._cupertinoRestPromptContainer) {
                    this._cupertinoRestPromptContainer.opacity = hasNotifs ? 0 : Math.round(255 * (1 - progress));
                    this._cupertinoRestPromptContainer.visible = progress < 1 && !hasNotifs;
                }

                if (this._promptActor) {
                    this._promptActor.set({
                        opacity: Math.round(255 * progress),
                        scale_x: 1, scale_y: 1, translation_y: 0,
                    });
                    this._promptActor.visible = progress > 0;
                }

                // If entering prompt state, the native password field and status label fade in
                if (mainBox) mainBox.opacity = Math.round(255 * progress);

                if (this._notifBox)
                    this._notifBox.opacity = notifOpacity;

                if (progress === 0) {
                    this._enforceCardLimit(this._notifBox);
                    this._updateCupertinoRestState();
                }
            } else {
                // ── WACK mode (default) ─────────────────────────────────────
                applyClockAnimation(
                    this._clockAnimation,
                    this._clockWrapper,
                    dialog._clock,
                    progress,
                    this._getClockAnimationParams(),
                    this._animationState);
                applyPromptAnimation(this._promptAnimation, this._promptActor, progress);

                if (this._notifBox)
                    this._notifBox.opacity = 255;

                if (progress === 0)
                    this._enforceCardLimit(this._notifBox);
            }
        };

        // Apply our custom layout manager to the main lock screen container.
        const mainBox = dialog.get_child_at_index(dialog.get_n_children() - 1);
        if (mainBox) {
            this._origLayout = mainBox.layout_manager;
            mainBox.layout_manager = new WackLayout(
                this,
                dialog._stack,
                dialog._notificationsBox,
                dialog._otherUserButton);
            mainBox.queue_relayout();
            this._mainBox = mainBox;
        }
    }

    _loadSettings() {
        try {
            this._settings = this.getSettings(SETTINGS_SCHEMA);
        } catch (e) {
            console.warn(`WACK lockscreen: preferences schema unavailable, using animation defaults: ${e.message}`);
            this._settings = null;
            return;
        }

        const syncClockAnimation = () => {
            this._clockAnimation = getAnimationSetting(
                this._settings,
                'clock-animation',
                DEFAULT_CLOCK_ANIMATION,
                CLOCK_ANIMATIONS);
        };
        const syncPromptAnimation = () => {
            this._promptAnimation = getAnimationSetting(
                this._settings,
                'prompt-animation',
                DEFAULT_PROMPT_ANIMATION,
                PROMPT_ANIMATIONS);
        };
        const syncLockscreenMode = () => {
            try {
                this._lockscreenMode = this._settings.get_string('lockscreen-mode') ?? 'wack';
            } catch (e) {
                this._lockscreenMode = 'wack';
            }
            this._applyPromptModeLayout?.();

            // Reset toggle state when mode changes
            this._cupertinoShowNotifsOverride = false;

            // Resync background blur to current progress after mode switch.
            // Cupertino never touches blur, so switching to WACK while at the prompt
            // would leave blur at 0 until the next _setTransitionProgress tick.
            const progress = this._dialog?._adjustment?.value ?? 0;
            const isCupertino = this._lockscreenMode === 'cupertino';
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const targetRadius = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress;
            const targetBrightness = isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress;
            for (const widget of this._dialog?._backgroundGroup ?? []) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({ radius: targetRadius, brightness: targetBrightness });
            }

            if (this._notifBox) {
                this._notifBox.opacity = isCupertino ? Math.round(255 * (1 - progress)) : 255;
            }
            if (this._hintContainer) {
                this._hintContainer.opacity = isCupertino
                    ? Math.round(255 * (1 - progress))
                    : (progress > 0 ? 0 : 255);
            }
        };

        syncClockAnimation();
        syncPromptAnimation();
        syncLockscreenMode();
        
        const syncCupertinoAlwaysShowUser = () => {
            try {
                this._cupertinoAlwaysShowUser = this._settings.get_boolean('cupertino-always-show-user');
            } catch (e) {
                this._cupertinoAlwaysShowUser = false;
            }
            this._cupertinoShowNotifsOverride = false;
            this._updateCupertinoRestState?.(true);
        };
        syncCupertinoAlwaysShowUser();

        this._settingsSignals.push(
            this._settings.connect('changed::clock-animation', syncClockAnimation),
            this._settings.connect('changed::prompt-animation', syncPromptAnimation),
            this._settings.connect('changed::lockscreen-mode', syncLockscreenMode),
            this._settings.connect('changed::cupertino-always-show-user', syncCupertinoAlwaysShowUser));
    }

    _getClockAnimationParams() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorY = monitor ? monitor.y / scaleFactor : 0;
        const clockY = this._clockWrapper?.y ?? 0;
        const [, natHeight] = this._clockWrapper?.get_preferred_height(-1) ?? [0, 0];
        const [, dateHeight] = this._dateLabel?.get_preferred_height(-1) ?? [0, DATE_LABEL_HEIGHT];
        const [, timeHeight] = this._timeLabel?.get_preferred_height(-1) ?? [0, 128];
        const clockHeight = Math.max(natHeight, dateHeight + timeHeight, DATE_LABEL_HEIGHT + timeHeight);

        return {
            fadeOutScale: FADE_OUT_SCALE,
            slideUpDistance: Math.ceil(Math.max(128, clockY - monitorY + clockHeight + 48)),
        };
    }

    /**
     * Helper to track GLib.idle_add sources for cleanup.
     * 
     * @param {number} priority Priority level.
     * @param {Function} callback Callback function.
     * @returns {number} The source ID.
     */
    _idleAdd(priority, callback) {
        let id = GLib.idle_add(priority, () => {
            this._idleSources.delete(id);
            return callback();
        });
        this._idleSources.add(id);
        return id;
    }

    /**
     * Creates a new blur effect for notification cards.
     * 
     * @returns {Blur.BlurEffect} The configured blur effect.
     */
    _makeCardBlur() {
        if (Blur) {
            return new Blur.BlurEffect({
                name: NOTIF_BLUR_NAME,
                mode: Blur.BlurMode.BACKGROUND,
                radius: NOTIF_BLUR_RADIUS,
                brightness: NOTIF_BLUR_BRIGHTNESS,
                corner_radius: NOTIF_CARD_RADIUS,
            });
        } else {
            // Fallback: use the stock "Shell.BlurEffect" (no background mode or corner radius)
            return new Shell.BlurEffect({
                name: NOTIF_BLUR_NAME,
                mode: Shell.BlurMode.BACKGROUND,
                radius: NOTIF_BLUR_RADIUS,
                brightness: NOTIF_BLUR_BRIGHTNESS,
            });
        }
    }

    /**
     * Attaches a blur effect to a notification actor if it doesn't already have one.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */
    _addCardBlur(actor) {
        if (!actor.get_effect(NOTIF_BLUR_NAME)) {
            actor.add_effect(this._makeCardBlur());
            actor.set_style(`border-radius: ${NOTIF_CARD_RADIUS}px;`);
        }
    }
    /**
     * Removes the custom blur effect from a notification actor.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */
    _removeCardBlur(actor) {
        const effect = actor.get_effect(NOTIF_BLUR_NAME);
        if (effect) actor.remove_effect(effect);
        actor.set_style(null); // restore whatever the stylesheet had
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
     * Returns true only when at least one notification card or media player
     * is actually visible on the lockscreen. This correctly excludes sources
     * whose policy has showInLockScreen=false — those actors still exist in
     * the tree but have visible=false after _enforceCardLimit runs.
     */
    _hasVisibleNotifs() {
        const nb = this._notifBox;
        if (!nb) return false;

        // If the user has globally disabled lockscreen notifications, assume empty
        if (!this._notifSettings) {
            const Gio = imports.gi.Gio;
            this._notifSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        }
        if (!this._notifSettings.get_boolean('show-in-lock-screen')) {
            return false;
        }

        const hasVisibleCard = nb._notificationBox?.get_children().some(c => c.visible) ?? false;
        const hasVisiblePlayer = [...(nb._players?.values() ?? [])].some(m => m.visible);
        const nativelyHasNotifs = hasVisibleCard || hasVisiblePlayer;

        // If Always Show User Widget is enabled in Cupertino mode,
        // and we haven't toggled notifications on, pretend there are no notifications.
        if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser) {
            if (!this._cupertinoShowNotifsOverride) {
                return false;
            }
        }

        return nativelyHasNotifs;
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
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
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
                        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            this._enforceCardLimit(nb);
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    if (!this._cardVisSignalIds) this._cardVisSignalIds = new Map();
                    this._cardVisSignalIds.set(actor, visId);
                }
                this._enforceCardLimit(nb);
                this._updateCupertinoRestState();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Listen for notifications being removed
        this._actorRemovedId = nb._notificationBox.connect('child-removed', () => {
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._enforceCardLimit(nb);
                this._updateCupertinoRestState();
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
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorX = monitor.x / scaleFactor;
        const monitorY = monitor.y / scaleFactor;
        const monitorWidth = monitor.width / scaleFactor;
        const monitorHeight = monitor.height / scaleFactor;

        const [, natWidth] = this._overflowLabel.get_preferred_width(-1);
        const [, natHeight] = this._overflowLabel.get_preferred_height(-1);

        const notifBox = this._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitorY + Math.floor(monitorHeight * HINT_VERTICAL_FRACTION);
        const notifTop = monitorY + monitorHeight - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);
        const x = monitorX + Math.floor((monitorWidth - natWidth) / 2);

        this._overflowLabel.set_position(x, y);
    }

    /**
     * Reverts all notification-related changes when the extension is disabled.
     */
    _teardownNotifBlur() {
        const nb = this._notifBox;
        if (!nb) return;

        nb.opacity = 255;

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

        if (this._idleSources) {
            this._idleSources.forEach(id => GLib.source_remove(id));
            this._idleSources.clear();
        }

        this._notifBox = null;
    }

    /**
     * Triggered when the authentication prompt begins to show.
     * Eases background blur in — applies to both WACK and cupertino modes.
     */
    _onPromptShow() {
        this._promptActive = true;

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const isCupertino = this._lockscreenMode === 'cupertino';

        if (isCupertino) {
            this._promptActor?.remove_style_class_name('wack-cupertino-rest');
            this._promptActor?.add_style_class_name('wack-cupertino-prompt');
            this._cupertinoToPrompt = true;
            // Ensure native avatar remains hidden during prompt lifecycle
            this._setupCupertinoAvatarOverride();
        }

        const targetRadius = isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor;
        const targetBrightness = isCupertino ? 1.0 : PROMPT_BLUR_BRIGHTNESS;
        for (const widget of this._dialog._backgroundGroup) {
            const blurEffect = widget.get_effect('blur');
            if (!blurEffect) continue;

            widget.ease_property('@effects.blur.radius', targetRadius, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            widget.ease_property('@effects.blur.brightness', targetBrightness, {
                duration: PROMPT_BLUR_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Triggered when the clock view returns.
     * Eases background blur back out — applies to both WACK and cupertino modes.
     */
    _onPromptHide() {
        this._promptActive = false;
        if (this._notifBox)
            this._enforceCardLimit(this._notifBox);
        this._updateCupertinoRestState();
        if (this._lockscreenMode === 'cupertino') {
            // Snapshot: no notifs → icon should snap back (no cross-fade)
            const hasNotifs = this._hasVisibleNotifs();
            this._cupertinoIconSnap = !hasNotifs;
            this._cupertinoToPrompt = false;
        }

        for (const widget of this._dialog._backgroundGroup) {
            const blurEffect = widget.get_effect('blur');
            if (!blurEffect) continue;

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
     * Positions and scales the prompt actor based on the active lockscreen mode.
     * In Cupertino mode the prompt sits at the bottom third of the screen at a reduced scale.
     * In WACK mode the prompt is left to WackLayout to allocate.
     */
    _updateCupertinoRestState(animate = false) {
        if (this._lockscreenMode !== 'cupertino') return;

        const hasNotifs = this._hasVisibleNotifs();

        if (this._cupertinoRestPromptContainer) {
            const targetOpacity = hasNotifs ? 0 : 255;
            if (animate) {
                this._cupertinoRestPromptContainer.visible = true;
                this._cupertinoRestPromptContainer.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._cupertinoRestPromptContainer.visible = targetOpacity > 0 && !this._promptActive;
                    }
                });
            } else {
                this._cupertinoRestPromptContainer.remove_all_transitions();
                this._cupertinoRestPromptContainer.opacity = targetOpacity;
                this._cupertinoRestPromptContainer.visible = !this._promptActive && targetOpacity > 0;
            }
        }

        if (this._cupertinoAvatarContainer) {
            // Fades out ONLY if we are in rest mode AND notifications appear.
            // If we are in prompt mode (!this._promptActive == false), avatar stays solid.
            const targetOpacity = (!this._promptActive && hasNotifs) ? 0 : 255;
            if (animate) {
                this._cupertinoAvatarContainer.visible = true;
                this._cupertinoAvatarContainer.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._cupertinoAvatarContainer.visible = targetOpacity > 0;
                    }
                });
            } else {
                this._cupertinoAvatarContainer.remove_all_transitions();
                this._cupertinoAvatarContainer.opacity = targetOpacity;
                this._cupertinoAvatarContainer.visible = targetOpacity > 0;
            }
        }

        // Handle _notifBox visibility since GNOME Shell might want it visible
        // but our override tells us to hide it.
        if (this._notifBox) {
            // we only touch opacity here; _setTransitionProgress also touches it
            // but we are at rest if this is called natively during idle
            const targetOpacity = (!this._promptActive && hasNotifs) ? 255 : 0;
            const targetBlur = (!this._promptActive && hasNotifs) ? NOTIF_BLUR_RADIUS : 0;

            if (animate) {
                this._notifBox.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

                // Animate individual card blurs
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
                this._notifBox._notificationBox.get_children().forEach(easeBlur);
                this._notifBox._players.values().forEach(easeBlur);
            } else {
                this._notifBox.remove_all_transitions();
                this._notifBox.opacity = targetOpacity;

                // Instantly apply blur target
                const setBlur = (actor) => {
                    const effect = actor.get_effect(NOTIF_BLUR_NAME);
                    if (effect) {
                        actor.remove_transition(`@effects.${NOTIF_BLUR_NAME}.radius`);
                        effect.set({ radius: targetBlur });
                        effect.set_enabled(targetBlur > 0.5);
                    }
                };
                this._notifBox._notificationBox.get_children().forEach(setBlur);
                this._notifBox._players.values().forEach(setBlur);
            }
        }

        // Hint/Overflow container opacity
        if (this._hintContainer) {
            const targetHintOpacity = hasNotifs ? 255 : 0;
            if (animate) {
                this._hintContainer.ease({
                    opacity: targetHintOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._hintContainer.remove_all_transitions();
                this._hintContainer.opacity = targetHintOpacity;
            }
        }
    }

    /**
     * Called once per AuthPrompt lifetime (from _onPromptShow).
     * Ensures the native UserWidget avatar is suppressed so our floating
     * persistent avatar remains the only visible one.
     */
    _setupCupertinoAvatarOverride() {
        if (this._cupertinoAvatarSetup) return;
        const authPrompt = this._dialog?._promptBox?._authPrompt;
        if (!authPrompt) return;
        this._cupertinoAvatarSetup = true;

        // ── Suppress Native Avatar (Headless) ──────────────────────────────
        // AuthPrompt recreates the UserWidget via updateUser() multiple times
        // during the unlock lifecycle. We override the method to ensure every
        // new avatar is instantly hidden.
        if (!this._cupertinoOrigUpdateUser) {
            this._cupertinoOrigUpdateUser = authPrompt.updateUser.bind(authPrompt);
            authPrompt.updateUser = (user) => {
                this._cupertinoOrigUpdateUser(user);
                const uw = authPrompt._userWell?.get_child();
                if (uw && uw._avatar) uw._avatar.opacity = 0;
            };
            // Hide the currently existing one
            const promptUserWidget = authPrompt._userWell?.get_child();
            if (promptUserWidget?._avatar)
                promptUserWidget._avatar.opacity = 0;
        }

        authPrompt.connect('destroy', () => this._teardownCupertinoAvatarOverride());
    }

    _teardownCupertinoAvatarOverride() {
        const authPrompt = this._dialog?._promptBox?._authPrompt;

        if (authPrompt && this._cupertinoOrigUpdateUser) {
            authPrompt.updateUser = this._cupertinoOrigUpdateUser;
            this._cupertinoOrigUpdateUser = null;
        }
        
        // Restore native avatar
        const promptUserWidget = authPrompt?._userWell?.get_child();
        if (promptUserWidget?._avatar)
            promptUserWidget._avatar.opacity = 255;

        this._cupertinoAvatarSetup = false;
    }

    _applyPromptModeLayout() {
        if (!this._promptActor) return;
        const isCupertino = this._lockscreenMode === 'cupertino';

        if (isCupertino) {
            this._createCupertinoRestPrompt();
            this._promptActor.remove_style_class_name('wack-cupertino-rest');
            this._promptActor.add_style_class_name('wack-cupertino-prompt');
            if (this._origPromptActorYAlign === undefined)
                this._origPromptActorYAlign = this._promptActor.y_align;
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

    _createCupertinoRestPrompt() {
        if (this._cupertinoRestPromptContainer) return;

        this._cupertinoRestPromptContainer = new St.BoxLayout({
            style_class: 'wack-cupertino-rest',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
        });

        this._cupertinoRestPrompt = new WackCupertinoRestPrompt(this._dialog._user);
        this._cupertinoRestPromptContainer.add_child(this._cupertinoRestPrompt);

        this._dialog._stack.add_child(this._cupertinoRestPromptContainer);

        // Create the persistent, independent floating avatar
        this._cupertinoAvatarContainer = new St.Bin({
            style_class: 'wack-cupertino-persistent-avatar',
            x_expand: true,
            // y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._cupertinoAvatar = new UserWidget.Avatar(this._dialog._user);
        this._cupertinoAvatarContainer.set_child(this._cupertinoAvatar);
        this._dialog._stack.add_child(this._cupertinoAvatarContainer);

        // Sync hint text from seat touch-mode (same logic as the regular hint)
        if (!this._cupertinoSeat) {
            const backend = Clutter.get_default_backend();
            this._cupertinoSeat = backend.get_default_seat();
            this._seatTouchModeId = this._cupertinoSeat.connect(
                'notify::touch-mode', () => this._syncCupertinoHint());
        }
        this._syncCupertinoHint();
    }

    _syncCupertinoHint() {
        const touchMode = this._cupertinoSeat?.touch_mode ?? false;
        const text = touchMode
            ? shellGettext('Swipe up to unlock')
            : shellGettext('Click or press a key to unlock');
        this._cupertinoRestPrompt?.setHintText(text);
    }

    _destroyCupertinoRestPrompt() {
        if (this._seatTouchModeId && this._cupertinoSeat) {
            this._cupertinoSeat.disconnect(this._seatTouchModeId);
            this._seatTouchModeId = null;
            this._cupertinoSeat = null;
        }
        if (this._cupertinoAvatarContainer) {
            this._cupertinoAvatarContainer.destroy();
            this._cupertinoAvatarContainer = null;
            this._cupertinoAvatar = null;
        }
        if (this._cupertinoRestPromptContainer) {
            this._cupertinoRestPromptContainer.destroy();
            this._cupertinoRestPromptContainer = null;
            this._cupertinoRestPrompt = null;
        }
    }

    /**
     * Calculates and sets the position of the custom clock on the primary monitor.
     */


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

        const centerLabel = (label) => {
            const box = label.get_allocation_box();
            const width = box.get_width();
            if (width > 0)
                label.set_x(Math.floor((monitorWidth - width) / 2));
        };

        if (this._dateAllocId) { dateLabel.disconnect(this._dateAllocId); this._dateAllocId = null; }
        if (this._timeAllocId) { timeLabel.disconnect(this._timeAllocId); this._timeAllocId = null; }

        this._dateAllocId = dateLabel.connect('notify::allocation', () => centerLabel(dateLabel));
        this._timeAllocId = timeLabel.connect('notify::allocation', () => centerLabel(timeLabel));

        centerLabel(dateLabel);
        centerLabel(timeLabel);
    }

    /**
     * Positions the interaction hint relative to the notifications area.
     */
    _positionHint() {
        if (!this._hint) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorX = monitor.x / scaleFactor;
        const monitorY = monitor.y / scaleFactor;
        const monitorWidth = monitor.width / scaleFactor;
        const monitorHeight = monitor.height / scaleFactor;

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

    /**
     * Cleans up all modifications and returns the GNOME Shell lock screen to its original state.
     */
    disable() {
        // Guideline EGO-M-008: Documenting use of unlock-dialog
        // We modify the unlock dialog to replace the default clock with our custom WackClock
        // and to implement custom background blur transitions.
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

        this._teardownCupertinoAvatarOverride();
        this._destroyCupertinoRestPrompt();

        resetAnimationActors(this._clockWrapper, this._promptActor);
        const mainBox = this._dialog?._promptBox?._authPrompt?._mainBox;
        if (mainBox) mainBox.opacity = 255;

        if (this._settings && this._settingsSignals) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
        }
        this._settingsSignals = [];
        this._settings = null;

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
        if (this._keyPressId) {
            this._dialog?.disconnect(this._keyPressId);
            this._keyPressId = null;
        }

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        // Restore the standard interaction hint
        if (this._hint) {
            if (this._hintTextSyncId) {
                this._hint.disconnect(this._hintTextSyncId);
                if (this._hintOpacityGuardId) {
                    this._hint.disconnect(this._hintOpacityGuardId);
                    this._hintOpacityGuardId = null;
                }
                this._hintTextSyncId = null;
            }
            this._hint.visible = true;
            this._hint = null;
        }

        // Remove our custom overflow label
        if (this._overflowLabel) {
            this._overflowLabel = null;
        }

        // Clean up the hints container
        if (this._hintContainer) {
            lockDialogGroup?.remove_child(this._hintContainer);
            this._hintContainer.destroy();
            this._hintContainer = null;
        }

        // Remove decoupled date/time labels and their wrapper
        if (this._dateLabel) {
            if (this._dateAllocId) {
                this._dateLabel.disconnect(this._dateAllocId);
                this._dateAllocId = null;
            }
            this._dateLabel = null;
        }
        if (this._timeLabel) {
            if (this._timeAllocId) {
                this._timeLabel.disconnect(this._timeAllocId);
                this._timeAllocId = null;
            }
            if (this._timeTextId) {
                this._timeLabel.disconnect(this._timeTextId);
                this._timeTextId = null;
            }
            this._timeLabel = null;
        }
        if (this._clockWrapper) {
            lockDialogGroup?.remove_child(this._clockWrapper);
            this._clockWrapper.destroy();
            this._clockWrapper = null;
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
        this._dateLabel = null;
        this._timeLabel = null;
        this._clockWrapper = null;
        if (this._promptActor && this._origPromptActorYAlign !== undefined) {
            this._promptActor.y_align = this._origPromptActorYAlign;
            this._origPromptActorYAlign = undefined;
        }
        this._promptActor?.remove_style_class_name('wack-cupertino-prompt');
        this._promptActor = null;
        this._animationState = null;
    }
}
