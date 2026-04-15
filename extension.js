import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import Gettext from 'gettext';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HINT_TIMEOUT = 4;
const CROSSFADE_TIME = 300;

// Fractional distance from top of screen for clock. default is 0.12
const CLOCK_TOP_FRACTION = 0.12;

// Fractional distance from top of screen for hint (if no notifications). default is 0.85
const HINT_VERTICAL_FRACTION = 0.85;

// Margin between hint and notifications when notifications are present. default is 16
const HINT_NOTIF_MARGIN = 16;
const FADE_OUT_SCALE = 0.3;

// Blur params
const PROMPT_BLUR_RADIUS = 50;
const PROMPT_BLUR_BRIGHTNESS = 0.85;
const PROMPT_BLUR_DURATION = 300;

// Notif blur params
const NOTIF_BLUR_RADIUS = 30;
const NOTIF_BLUR_BRIGHTNESS = 1.0;
const NOTIF_BLUR_NAME = 'wack-notif-blur';

// Max visible notif cards before overflow text appears
const MAX_VISIBLE_CARDS = 3;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

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
        const now = new Date();
        return now.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});
    }
}

const WackClock = GObject.registerClass(
class WackClock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'unlock-dialog-clock',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

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

        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connect('notify::clock', this._updateTime.bind(this));

        const backend = this.get_context().get_backend();
        this._seat = backend.get_default_seat();
        this._seat.connectObject('notify::touch-mode',
            this._updateHint.bind(this), this);

        this._monitorManager = global.backend.get_monitor_manager();
        this._monitorManager.connectObject('power-save-mode-changed',
            () => (this._hint.opacity = 0), this);

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(HINT_TIMEOUT * 1000, () => {
            this._hint.ease({opacity: 255, duration: CROSSFADE_TIME});
        });

        this._dateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60,
            () => { this._updateDate(); return GLib.SOURCE_CONTINUE; });

        this._updateTime();
        this._updateDate();
        this._updateHint();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _updateTime() {
        this._time.text = this._wallClock.clock.trim().replace(/\s*(AM|PM)\s*/i, '');
    }

    async _updateDate() {
        this._dateOutput.text = await getPrettyDate();
    }

    _updateHint() {
        this._hint.text = this._seat.touch_mode
            ? shellGettext('Swipe up to unlock')
            : shellGettext('Click or press a key to unlock');
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        this._idleMonitor.remove_watch(this._idleWatchId);
        if (this._dateTimeoutId)
            GLib.source_remove(this._dateTimeoutId);
    }
});

const WackLayout = GObject.registerClass(
class WackLayout extends Clutter.LayoutManager {
    _init(stack, notifications, switchUserButton) {
        super._init();
        this._stack = stack;
        this._notifications = notifications;
        this._switchUserButton = switchUserButton;
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        const [width, height] = box.get_size();
        const tenthOfHeight = height / 10.0;

        const [,, stackWidth, stackHeight] = this._stack.get_preferred_size();
        const [,, notificationsWidth, notificationsHeight] = this._notifications.get_preferred_size();

        const columnWidth = Math.max(stackWidth, notificationsWidth);
        const columnX1 = Math.floor((width - columnWidth) / 2.0);
        const actorBox = new Clutter.ActorBox();

        const maxNotificationsHeight = Math.min(
            notificationsHeight,
            height - tenthOfHeight - stackHeight);
        actorBox.x1 = columnX1;
        actorBox.y1 = height - maxNotificationsHeight;
        actorBox.x2 = columnX1 + columnWidth;
        actorBox.y2 = actorBox.y1 + maxNotificationsHeight;
        this._notifications.allocate(actorBox);

        const stackY = Math.min(
            Math.floor(height / 3.0),
            height - stackHeight - maxNotificationsHeight);
        actorBox.x1 = columnX1;
        actorBox.y1 = stackY;
        actorBox.x2 = columnX1 + columnWidth;
        actorBox.y2 = stackY + stackHeight;
        this._stack.allocate(actorBox);

        if (this._switchUserButton.visible) {
            const [,, natWidth, natHeight] = this._switchUserButton.get_preferred_size();
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

        // --- 1. Zero global blur ---
        this._origUpdateBgEffects = dialog._updateBackgroundEffects.bind(dialog);
        dialog._updateBackgroundEffects = () => {
            for (const widget of dialog._backgroundGroup) {
                const effect = widget.get_effect('blur');
                if (effect)
                    effect.set({brightness: 1.0, radius: 0});
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

        // --- 2. Prompt blur — animate radius on background widgets via _showPrompt/_showClock ---
        this._injectionManager.overrideMethod(
            dialog, '_showPrompt',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptShow();
                };
            }
        );

        this._injectionManager.overrideMethod(
            dialog, '_showClock',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptHide();
                };
            }
        );

        // --- 3. Replace clock, decouple from stack ---
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

        // --- overflow label — spiritual successor to hint when active ---
        this._overflowLabel = new St.Label({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 255,
            visible: false,
        });
        this._overflowActive = false;
        lockDialogGroup.add_child(this._overflowLabel);
        this._positionOverflow();



        // --- per-card notif blur ---
        this._lastPlayingPlayer = null;
        this._promptActive = false;
        this._setupNotifBlur(dialog._notificationsBox);

        // Monitor changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._positionClock();
            this._positionHint();
            this._positionOverflow();
        });

        // --- 4. Patch _setTransitionProgress for clock-only animation ---
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
            effect.set({radius: globalBlur, brightness: globalBrightness});
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

        // --- 5. Prompt-only layout ---
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

    _makeCardBlur() {
        return new Shell.BlurEffect({
            name: NOTIF_BLUR_NAME,
            mode: Shell.BlurMode.BACKGROUND,
            radius: NOTIF_BLUR_RADIUS,
            brightness: NOTIF_BLUR_BRIGHTNESS,
        });
    }

    _addCardBlur(actor) {
        if (!actor.get_effect(NOTIF_BLUR_NAME))
            actor.add_effect(this._makeCardBlur());
    }

    _removeCardBlur(actor) {
        const effect = actor.get_effect(NOTIF_BLUR_NAME);
        if (effect) actor.remove_effect(effect);
    }

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

    _isMediaCard(nb, actor) {
        for (const msg of nb._players.values()) {
            if (msg === actor) return true;
        }
        return false;
    }

    _getMediaPlayer(nb, actor) {
        for (const [player, msg] of nb._players.entries()) {
            if (msg === actor) return player;
        }
        return null;
    }

    _enforceMediaLimit(nb) {
        // priority: last-to-go-Playing > any Playing > last Playing (now paused) > first
        const players = [...nb._players.entries()];

        // hide all first
        for (const [, msg] of players) msg.visible = false;

        // last player to go Playing wins if still Playing
        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg && this._lastPlayingPlayer.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        // fallback: any Playing in insertion order
        for (const [player, msg] of players) {
            if (player.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        // nothing playing — show last playing player (now paused) if we have one
        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg) { msg.visible = true; return; }
        }

        // cold start — show first
        const firstMsg = nb._players.values().next().value;
        if (firstMsg) firstMsg.visible = true;
    }

    _setupNotifBlur(nb) {
        // seed _lastPlayingPlayer from already-playing players
        // last one in insertion order that's Playing wins as initial priority
        for (const [player] of nb._players.entries()) {
            if (player.status === 'Playing')
                this._lastPlayingPlayer = player;
        }

        // blur + enforce limit on existing cards
        for (const child of nb._notificationBox.get_children())
            this._addCardBlur(child);
        this._enforceCardLimit(nb);

        this._actorAddedId = nb._notificationBox.connect('child-added', (container, actor) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._addCardBlur(actor);
                // track playback status transitions via player's changed signal
                const player = this._getMediaPlayer(nb, actor);
                if (player) {
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
                    // notif card — re-enforce when shell changes its visibility
                    // (e.g. user views notifs in-session, shell sets visible=false)
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

        this._actorRemovedId = nb._notificationBox.connect('child-removed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._enforceCardLimit(nb);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._notifBox = nb;
    }

_enforceCardLimit(nb) {
    this._enforceMediaLimit(nb);

    const children = nb._notificationBox.get_children();
    let notifCount = 0;
    let hiddenCount = 0;

    const shellVisible = new Set();
    // Use the entries to get both the source state and the UI object
    for (const [source, obj] of nb._sources.entries()) {
        // NATIVE RULE: Only show if unseenCount > 0 AND policy allows it
        // If you glanced at it in-session, unseenCount usually hits 0
        if (obj.sourceBox && source.unseenCount > 0 && obj.visible) {
            shellVisible.add(obj.sourceBox);
        }
    }

    children.forEach(child => {
        if (!child || this._isMediaCard(nb, child)) return;

        // If it's not in our 'Strictly Unseen' set, kill it
        if (!shellVisible.has(child)) {
            child.visible = false;
            return;
        }

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

_updateOverflow(hiddenCount) {
    if (!this._overflowLabel) return;

    // Use the actual adjustment value to detect transition
    // progress > 0 means the prompt is sliding in or visible
    const progress = this._dialog._adjustment.value;
    
    if (progress > 0 || this._promptActive) {
        this._overflowLabel.visible = false;
        this._overflowLabel.opacity = 0;
        return;
    }

    if (hiddenCount <= 0) {
        this._overflowActive = false;
        this._overflowLabel.visible = false;
        this._hint.visible = true; // Give control back to the original hint
        return;
    }

    this._overflowActive = true;
    this._hint.visible = false;
    this._hint.set_opacity(0);

let moreText = Gettext.pgettext('calendar', 'More').toLowerCase();
    
    // If Italian/Indonesian fails, fall back to a safe Shell generic
    if (moreText === 'more') {
        moreText = shellGettext('More').toLowerCase();
    }

    const overflowText = `${hiddenCount}+ ${moreText}`;
    this._overflowLabel.text = `${overflowText}  ·  ${this._hintText}`;
    this._overflowLabel.visible = true;
    this._overflowLabel.set_opacity(255);
    this._positionOverflow();
}

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

        // disconnect player changed signals
        if (this._playerSignalIds) {
            for (const [player, id] of this._playerSignalIds.entries()) {
                try { player.disconnect(id); } catch (_) {}
            }
            this._playerSignalIds = null;
        }

        // disconnect per-card visibility signals
        if (this._cardVisSignalIds) {
            for (const [actor, id] of this._cardVisSignalIds.entries()) {
                try { actor.disconnect(id); } catch (_) {}
            }
            this._cardVisSignalIds = null;
        }

        // restore all cards to visible
        for (const child of nb._notificationBox.get_children()) {
            child.visible = true;
            this._removeCardBlur(child);
        }
        for (const msg of nb._players.values())
            msg.visible = true;

        this._notifBox = null;
    }

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

    _onPromptHide() {
        this._promptActive = false;
        // re-enforce now that the wall is down
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

    _positionClock() {
        const clock = this._dialog?._clock;
        if (!clock) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        clock.set_position(monitor.x, monitor.y + Math.floor(monitor.height * CLOCK_TOP_FRACTION));
        clock.set_width(monitor.width);
    }

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
        this._hint.set_position(x, y);
        this._hint.set_width(natWidth);
    }

    disable() {
        if (!this._dialog) return;

        // Restore blur
        if (this._origUpdateBgEffects) {
            this._dialog._updateBackgroundEffects = this._origUpdateBgEffects;
            this._origUpdateBgEffects = null;
            this._dialog._updateBackgroundEffects();
        }

        // Remove per-card notif blurs and restore patched methods
        this._teardownNotifBlur();





        // Restore transition progress
        if (this._origSetTransitionProgress) {
            this._dialog._setTransitionProgress = this._origSetTransitionProgress;
            this._origSetTransitionProgress = null;
        }

        // Clear injections (_showPrompt, _showClock)
        this._injectionManager?.clear();
        this._injectionManager = null;

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

        if (this._hint) {
            if (this._hintTextSyncId) {
                this._hint.disconnect(this._hintTextSyncId);
                this._hintTextSyncId = null;
            }
            if (this._hintOpacityGuardId) {
                this._hint.disconnect(this._hintOpacityGuardId);
                this._hintOpacityGuardId = null;
            }
            // restore hint to visible in case overflow had it inert
            this._hint.visible = true;
            lockDialogGroup?.remove_child(this._hint);
            this._hint = null;
        }

        if (this._overflowLabel) {
            lockDialogGroup?.remove_child(this._overflowLabel);
            this._overflowLabel.destroy();
            this._overflowLabel = null;
        }

        if (this._dialog._clock) {
            lockDialogGroup?.remove_child(this._dialog._clock);
            this._dialog._clock.destroy();
            this._dialog._clock = null;
        }

        this._dialog._clock = this._originalClock;
        this._dialog._stack.add_child(this._originalClock);

        if (this._mainBox && this._origLayout) {
            this._mainBox.layout_manager = this._origLayout;
            this._mainBox.queue_relayout();
        }

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