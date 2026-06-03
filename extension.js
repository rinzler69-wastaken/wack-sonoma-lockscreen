import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

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
import { WackClock } from './wackClock.js';
import { WackCupertinoRestPrompt } from './cupertinoPrompt.js';
import { WackLayout } from './layoutManager.js';
import { NotificationManager } from './notificationManager.js';
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
    SETTINGS_SCHEMA,
    CUPERTINO_PROMPT_VERTICAL_FRACTION,
    MAX_VISIBLE_CARDS,
} from './constants.js';


export default class WackLockscreenClockExtension extends Extension {
    enable() {
        const dialog = Main.screenShield._dialog;
        if (!dialog) return;

        this._dialog = dialog;
        this._originalClock = dialog._clock;
        // InjectionManager is held for potential future method overrides by sub-features.
        // Currently no overrideMethod() calls are active — it is cleared in disable().
        this._injectionManager = new InjectionManager();
        this._idleSources = new Set();
        this._clockAnimation = DEFAULT_CLOCK_ANIMATION;
        this._promptAnimation = DEFAULT_PROMPT_ANIMATION;
        this._lockscreenMode = 'wack';
        this._cupertinoAlwaysShowUser = false;
        this._cupertinoShowNotifsOverride = false; // Toggled via Shift+N
        this._animationState = createAnimationState();
        // Instantiate NotificationManager before _loadSettings() so that
        // syncLockscreenMode() and other settings callbacks can safely access it.
        this._notifManager = new NotificationManager(this);
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

        dialog._notificationsBox.connectObject(
            'notify::height', () => {
                this._positionHint();
                this._notifManager.positionOverflow();
            },
            'notify::visible', () => {
                this._positionHint();
                this._notifManager.positionOverflow();
            }, this);

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
        timeLabel.connectObject(
            'notify::text', () => this._positionClock(),
            'notify::allocation', () => this._centerClockLabel(timeLabel),
            this);
        dateLabel.connectObject('notify::allocation', () => this._centerClockLabel(dateLabel), this);
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
        hint.connectObject(
            'notify::text', () => {
                if (!this._overflowActive)
                    this._hintText = hint.text;
            },
            'notify::opacity', () => {
                const hasNotifs = this._notifManager.hasVisibleNotifs();
                const suppressHint = this._promptActive ||
                    (this._lockscreenMode === 'cupertino' && !hasNotifs && !this._overflowActive);
                if (suppressHint && hint.opacity > 0) {
                    hint.remove_all_transitions();
                    hint.set_opacity(0);
                }
            }, this);
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

        // Configure individual background blurs for each notification card.
        this._lastPlayingPlayer = null;
        this._promptActive = false;
        this._notifManager.setupNotifBlur(dialog._notificationsBox);
        this._promptActor = dialog._promptBox ?? dialog._stack;
        this._promptActor?.set_pivot_point(0.5, 0.5);

        dialog.connectObject('key-press-event', (actor, event) => {
            if (this._lockscreenMode === 'cupertino' && this._cupertinoAlwaysShowUser && !this._promptActive) {
                const keysym = event.get_key_symbol();
                const state = event.get_state();
                const shiftPressed = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

                if (shiftPressed && (keysym === Clutter.KEY_N || keysym === Clutter.KEY_n)) {
                    // Only allow toggling to "show notifications" mode if there are actually notifications present.
                    // If it is already overridden (true), we always allow toggling it back to false.
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

        // Monitor changes
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
            this._notifManager.positionOverflow();
            this._applyPromptModeLayout();
        }, this);

        // Patch the transition logic to implement our custom clock scaling and prompt blur transition
        this._origSetTransitionProgress = dialog._setTransitionProgress.bind(dialog);
        dialog._setTransitionProgress = (progress) => {
            this._origSetTransitionProgress(progress);

            // Swipe gestures bypass _showPrompt/_showClock entirely, so derive
            // _promptActive from progress to keep the hint guard working correctly,
            // and manually fire _showPrompt/_showClock so other extensions hooking
            // those methods (e.g. LiveLockscreen) stay in sync on swipe gestures
            const wasActive = this._promptActive;
            // _promptActive is also set in _onPromptShow/_onPromptHide for keyboard-triggered
            // prompts. Here we derive it from progress to cover swipe gestures.
            this._promptActive = progress > 0;
            if (this._promptActive && !wasActive) {
                this._onPromptShow();
                // Fire _showPrompt with adjustment stubbed so LLS and other hooks
                // run without re-triggering the ease transition
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try {
                    dialog._showPrompt();
                } finally {
                    dialog._adjustment.ease = origEase;
                }
            } else if (!this._promptActive && wasActive) {
                this._onPromptHide();
                const origEase = dialog._adjustment.ease;
                dialog._adjustment.ease = () => { };
                try {
                    dialog._showClock();
                } finally {
                    dialog._adjustment.ease = origEase;
                }
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

            const hasNotifs = this._notifManager.hasVisibleNotifs();

            // Notification Cards: Blur OUT (Crossfade)
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

            // Hint/Overflow container opacity
            if (this._hintContainer) {
                this._hintContainer.opacity = isCupertino
                    ? notifOpacity
                    : (progress > 0 ? 0 : 255);
            }

            if (isCupertino) {
                // ── Cupertino mode ──────────────────────────────────────────
                const mainBox = this._dialog?._promptBox?._authPrompt?._mainBox;

                // The user-icon in the rest prompt stays at full opacity throughout
                // rest↔prompt transitions — it never fades. Only the hint and name
                // label fade out as the auth prompt fades in below the avatar.
                if (this._cupertinoRestPromptContainer) {
                    if (hasNotifs) {
                        // Notifications present: hide the whole rest widget so cards show
                        this._cupertinoRestPromptContainer.opacity = 0;
                        this._cupertinoRestPromptContainer.visible = false;
                    } else {
                        // No notifications: container always visible; fade only sub-content
                        this._cupertinoRestPromptContainer.opacity = 255;
                        this._cupertinoRestPromptContainer.visible = true;
                        const subOpacity = Math.round(255 * (1 - progress));
                        if (this._cupertinoRestPrompt?._hintBoxWrapper)
                            this._cupertinoRestPrompt._hintBoxWrapper.opacity = subOpacity;
                        const nameLabel = this._cupertinoRestPrompt?._userWell?.get_child()?._label;
                        if (nameLabel) nameLabel.opacity = subOpacity;
                    }
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

                if (this._notifManager._notifBox) {
                    this._notifManager._notifBox.opacity = notifOpacity;
                    // Fully remove from hit-testing when invisible — opacity:0 alone
                    // still leaves cards reactive, causing click-through bugs.
                    this._notifManager._notifBox.visible = notifOpacity > 0;
                }

                if (progress === 0) {
                    this._notifManager.enforceCardLimit(this._notifManager._notifBox);
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

                if (this._notifManager._notifBox)
                    this._notifManager._notifBox.opacity = 255;

                if (progress === 0)
                    this._notifManager.enforceCardLimit(this._notifManager._notifBox);
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
        // This desktop schema is independent from our extension schema; keep it
        // available even when a dev install is missing compiled extension schemas.
        this._notifShowInLockScreen = true;
        try {
            this._notifSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
            this._notifShowInLockScreen = this._notifSettings.get_boolean('show-in-lock-screen');
            this._notifSettings.connectObject('changed::show-in-lock-screen', () => {
                this._notifShowInLockScreen = this._notifSettings.get_boolean('show-in-lock-screen');
            }, this);
        } catch (e) {
            console.warn(`WACK lockscreen: notification settings unavailable, assuming lockscreen notifications are enabled: ${e.message}`);
            this._notifSettings = null;
        }

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

            if (this._notifManager._notifBox) {
                this._notifManager._notifBox.opacity = isCupertino ? Math.round(255 * (1 - progress)) : 255;
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

        this._settings.connectObject(
            'changed::clock-animation', syncClockAnimation,
            'changed::prompt-animation', syncPromptAnimation,
            'changed::lockscreen-mode', syncLockscreenMode,
            'changed::cupertino-always-show-user', syncCupertinoAlwaysShowUser,
            this);
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

    /**
     * Helper to track GLib.idle_add sources for cleanup.
     * 
     * @param {number} priority Priority level.
     * @param {Function} callback Callback function.
     * @returns {number} The source ID.
     */
    _idleAdd(priority, callback) {
        // NOTE: 'id' is captured by the closure below. GLib idle callbacks are never
        // fired synchronously, so 'id' is always assigned before the callback runs.
        let id = GLib.idle_add(priority, () => {
            let result;
            try {
                result = callback();
            } catch (e) {
                this._idleSources.delete(id);
                throw e;
            }
            if (result !== GLib.SOURCE_CONTINUE)
                this._idleSources.delete(id);
            return result;
        });
        this._idleSources.add(id);
        return id;
    }


    /**
     * Creates a new blur effect for notification cards.
     */


    /**
     * Attaches a blur effect to a notification actor if it doesn't already have one.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */

    /**
     * Removes the custom blur effect from a notification actor.
     * 
     * @param {Clutter.Actor} actor The notification card actor.
     */


    /**
     * Toggles the enabled state of blur effects across all current notifications.
     * 
     * @param {boolean} enabled Whether the blurs should be active.
     */


    /**
     * Checks if a given actor represents a media player card.
     * 
     * @param {object} nb The notifications box.
     * @param {Clutter.Actor} actor The actor to check.
     * @returns {boolean} True if it's a media card.
     */


    /**
     * Retrieves the media player associated with a specific UI actor.
     * 
     * @param {object} nb The notifications box.
     * @param {Clutter.Actor} actor The UI actor.
     * @returns {object|null} The media player object, or null if not found.
     */


    /**
     * Returns true only when at least one notification card or media player
     * is actually visible on the lockscreen. This correctly excludes sources
     * whose policy has showInLockScreen=false — those actors still exist in
     * the tree but have visible=false after _enforceCardLimit runs.
     */


    /**
     * Returns the exact number of notifications natively present, used for
     * the inline user widget counter when notifications are visually suppressed.
     */


    /**
     * Ensures only one media player is visible at a time, prioritizing active sessions.
     * 
     * @param {object} nb The notifications box.
     */


    /**
     * Sets up signal handlers to manage blurs and visibility for the notification container.
     * 
     * @param {object} nb The notifications box.
     */


    /**
     * Manages the visibility of notification cards to respect the defined limits.
     * 
     * @param {object} nb The notifications box.
     */


    /**
     * Updates the text and visibility of the notification overflow label.
     * 
     * @param {number} hiddenCount The number of hidden notifications.
     */


    /**
     * Positions the overflow label relative to the screen and notifications.
     */


    /**
     * Reverts all notification-related changes when the extension is disabled.
     */


    /**
     * Triggered when the authentication prompt begins to show.
     * Eases background blur in — applies to both WACK and cupertino modes.
     */
    _onPromptShow() {
        this._promptActive = true;

        const isCupertino = this._lockscreenMode === 'cupertino';

        if (isCupertino) {
            this._promptActor?.remove_style_class_name('wack-cupertino-rest');
            this._promptActor?.add_style_class_name('wack-cupertino-prompt');
            this._cupertinoToPrompt = true;
            // Ensure native avatar remains hidden during prompt lifecycle
            this._setupCupertinoAvatarOverride();
        }
    }

    /**
     * Triggered when the clock view returns.
     * Eases background blur back out — applies to both WACK and cupertino modes.
     */
    _onPromptHide() {
        this._promptActive = false;
        if (this._notifManager._notifBox)
            this._notifManager.enforceCardLimit(this._notifManager._notifBox);
        this._updateCupertinoRestState();
        if (this._lockscreenMode === 'cupertino') {
            // Snapshot: no notifs → icon should snap back (no cross-fade)
            const hasNotifs = this._notifManager.hasVisibleNotifs();
            this._cupertinoIconSnap = !hasNotifs;
            this._cupertinoToPrompt = false;
        }
    }

    /**
     * Positions and scales the prompt actor based on the active lockscreen mode.
     * In Cupertino mode the prompt sits at the bottom third of the screen at a reduced scale.
     * In WACK mode the prompt is left to WackLayout to allocate.
     */
    _updateCupertinoRestState(animate = false) {
        if (this._lockscreenMode !== 'cupertino') return;

        const hasNotifs = this._notifManager.hasVisibleNotifs();

        if (this._cupertinoRestPromptContainer) {
            // Inline notification count updates
            const count = this._notifManager.getNativeNotifCount();
            let nextCount = 0;
            if (this._cupertinoAlwaysShowUser && count > 0 && !this._cupertinoShowNotifsOverride) {
                if (!this._cupertinoHintIsToggle)
                    nextCount = count;
            }

            if (hasNotifs) {
                // Notifications: fade/hide the whole rest widget so cards can show
                const targetOpacity = 0;
                if (animate) {
                    const restPromptContainer = this._cupertinoRestPromptContainer;
                    restPromptContainer.visible = true;
                    restPromptContainer.ease({
                        opacity: targetOpacity,
                        duration: CROSSFADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            if (this._cupertinoRestPromptContainer === restPromptContainer)
                                restPromptContainer.visible = false;
                        },
                    });
                } else {
                    this._cupertinoRestPromptContainer.remove_all_transitions();
                    this._cupertinoRestPromptContainer.opacity = 0;
                    this._cupertinoRestPromptContainer.visible = false;
                }
            } else {
                // No notifications: rest container should be visible.
                // When called with animate=true (e.g. notifications just cleared),
                // crossfade the container in so it doesn't pop abruptly over the cards.
                this._cupertinoRestPrompt?.setNotifCount(nextCount);

                const hintBoxWrapper = this._cupertinoRestPrompt?._hintBoxWrapper;
                const nameLabel = this._cupertinoRestPrompt?._userWell?.get_child()?._label;

                if (animate && !this._promptActive) {
                    // Fade the container in from transparent
                    this._cupertinoRestPromptContainer.remove_all_transitions();
                    this._cupertinoRestPromptContainer.opacity = 0;
                    this._cupertinoRestPromptContainer.visible = true;
                    // Ensure sub-content is at full opacity before the fade starts
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
                        // Returning to rest: restore hint and label immediately
                        if (hintBoxWrapper) { hintBoxWrapper.remove_all_transitions(); hintBoxWrapper.opacity = 255; }
                        if (nameLabel) { nameLabel.remove_all_transitions(); nameLabel.opacity = 255; }
                    }
                }
            }
        }

        // Handle _notifBox visibility since GNOME Shell might want it visible
        // but our override tells us to hide it.
        if (this._notifManager._notifBox) {
            // we only touch opacity here; _setTransitionProgress also touches it
            // but we are at rest if this is called natively during idle
            const targetOpacity = (!this._promptActive && hasNotifs) ? 255 : 0;
            const targetBlur = (!this._promptActive && hasNotifs) ? NOTIF_BLUR_RADIUS : 0;

            if (animate) {
                const notifBox = this._notifManager._notifBox;
                // Must be visible before ease starts so the fade-in is rendered
                if (targetOpacity > 0)
                    notifBox.visible = true;
                notifBox.ease({
                    opacity: targetOpacity,
                    duration: CROSSFADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this._notifManager._notifBox === notifBox)
                            notifBox.visible = targetOpacity > 0;
                    },
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
                notifBox._notificationBox.get_children().forEach(easeBlur);
                for (const actor of notifBox._players.values()) easeBlur(actor);
            } else {
                this._notifManager._notifBox.remove_all_transitions();
                this._notifManager._notifBox.opacity = targetOpacity;
                this._notifManager._notifBox.visible = targetOpacity > 0;

                // Instantly apply blur target
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

        // Hint/Overflow container opacity
        if (this._hintContainer) {
            const targetHintOpacity = (!this._promptActive && hasNotifs) ? 255 : 0;
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

        // Update the Cupertino hint cycle based on the new state
        this._updateCupertinoHintCycle();
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

        authPrompt.connectObject('destroy', () => this._teardownCupertinoAvatarOverride(), this);
    }

    _teardownCupertinoAvatarOverride() {
        const authPrompt = this._dialog?._promptBox?._authPrompt;

        if (authPrompt)
            authPrompt.disconnectObject(this);

        if (authPrompt && this._cupertinoOrigUpdateUser) {
            authPrompt.updateUser = this._cupertinoOrigUpdateUser;
        }
        this._cupertinoOrigUpdateUser = null;

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
            vertical: true,
            reactive: false,
        });

        this._cupertinoRestPrompt = new WackCupertinoRestPrompt(this._dialog._user);
        this._cupertinoRestPromptContainer.add_child(this._cupertinoRestPrompt);

        this._dialog._stack.add_child(this._cupertinoRestPromptContainer);

        // Sync hint text from seat touch-mode (same logic as the regular hint)
        if (!this._cupertinoSeat) {
            const backend = Clutter.get_default_backend();
            this._cupertinoSeat = backend.get_default_seat();
            this._cupertinoSeat.connectObject(
                'notify::touch-mode', () => this._syncCupertinoHint(), this);
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

    _updateCupertinoHintCycle() {
        if (!this._cupertinoRestPrompt) return;

        const nativeCount = this._notifManager.getNativeNotifCount();

        // Cycle only if:
        // - We are in Cupertino mode
        // - Always show user widget is ON
        // - Notifications are currently HIDDEN (override is false)
        // - There are actual unread notifications (count > 0)
        // - The prompt is not active (we are at rest)
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

                    const nextText = this._cupertinoHintIsToggle
                        ? this._cupertinoToggleHintText
                        : this._cupertinoBaseHintText;

                    if (this._cupertinoRestPrompt && this._cupertinoRestPrompt._hintBox) {
                        const hintBox = this._cupertinoRestPrompt._hintBox;
                        hintBox.ease({
                            opacity: 0,
                            duration: CROSSFADE_TIME / 2,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onComplete: () => {
                                if (!this._cupertinoRestPrompt) return; // Might have been destroyed

                                this._cupertinoRestPrompt.setHintText(nextText);

                                if (this._cupertinoHintIsToggle) {
                                    this._cupertinoRestPrompt.setNotifCount(0);
                                } else {
                                    this._cupertinoRestPrompt.setNotifCount(this._notifManager.getNativeNotifCount());
                                }

                                hintBox.ease({
                                    opacity: 255,
                                    duration: CROSSFADE_TIME / 2,
                                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                                });
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
            // Ensure we reset to base text immediately and restore opacity
            if (this._cupertinoRestPrompt && this._cupertinoRestPrompt._hintBox) {
                this._cupertinoRestPrompt._hintBox.remove_all_transitions();
                this._cupertinoRestPrompt._hintBox.opacity = 255;

                // Only reset the text instantly if the container is staying visible.
                // If it's fading out (hasNotifs is true or prompt is active), leave the text as-is to fade out smoothly.
                if (!this._notifManager.hasVisibleNotifs() && !this._promptActive) {
                    this._cupertinoRestPrompt.setHintText(this._cupertinoBaseHintText || '');
                }
                // Note: The rest state logic handles setting the notification count visibility
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

        this._centerClockLabel(dateLabel);
        this._centerClockLabel(timeLabel);
    }

    /**
     * Centers a clock label horizontally on the primary monitor.
     * Called both directly and from notify::allocation handlers.
     */
    _centerClockLabel(label) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorWidth = monitor.width / scaleFactor;
        const box = label.get_allocation_box();
        const width = box.get_width();
        if (width > 0)
            label.set_x(Math.floor((monitorWidth - width) / 2));
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

        this._notifManager.teardownNotifBlur();
        this._notifManager = null;

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

        if (this._settings)
            this._settings.disconnectObject(this);
        this._settings = null;

        // Tear down the notification show-in-lock-screen cache
        if (this._notifSettings)
            this._notifSettings.disconnectObject(this);
        this._notifSettings = null;
        this._notifShowInLockScreen = false;

        // Remove all method injections
        this._injectionManager?.clear();
        this._injectionManager = null;

        // Disconnect from UI signals
        this._dialog._notificationsBox?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._dialog.disconnectObject(this);

        const lockDialogGroup = Main.screenShield?._lockDialogGroup;

        // Restore the standard interaction hint
        if (this._hint) {
            this._hint.disconnectObject(this);
            this._hint.visible = true;
            this._hint = null;
        }

        // Remove our custom overflow label
        if (this._overflowLabel) {
            this._overflowLabel.destroy();
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
        this._overflowActive = false;
        this._hintText = null;
        this._lastPlayingPlayer = null;
        if (this._promptActor && this._origPromptActorYAlign !== undefined) {
            this._promptActor.y_align = this._origPromptActorYAlign;
            this._origPromptActorYAlign = undefined;
        }
        this._promptActor?.remove_style_class_name('wack-cupertino-prompt');
        this._promptActor = null;
        this._animationState = null;
    }
}
