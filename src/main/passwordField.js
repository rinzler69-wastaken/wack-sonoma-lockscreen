import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gettext from 'gettext';
import { getInputSourceManager } from 'resource:///org/gnome/shell/ui/status/keyboard.js';

// Indicator slot grows/shrinks so the placeholder slides instead of jumping.
const INDICATOR_SLIDE_MS = 180;
// StEntry always puts this fixed gap between a primary icon and the text,
// even when the icon is hidden or zero-width (measured on GNOME 50).
const ENTRY_ICON_GAP = 6;

// Damped macOS-style shake, in px. Each step is one ease of SHAKE_STEP_MS.
const SHAKE_OFFSETS = [-12, 10, -7, 4, -2, 0];
const SHAKE_STEP_MS = 55;

/**
 * Eases an actor's width from an explicit start value. actor.ease() takes its
 * start from the current allocation, which a freshly slotted actor lacks.
 * Honours "Reduce Animation" and the shell slow-down factor like ease().
 */
function easeWidth(actor, from, to, duration, onComplete) {
    actor.remove_transition('width');
    const settings = St.Settings.get();
    duration = settings.enable_animations ? duration * settings.slow_down_factor : 0;
    if (duration === 0) {
        actor.width = to;
        onComplete();
        return;
    }
    const transition = new Clutter.PropertyTransition({
        property_name: 'width',
        interval: new Clutter.Interval({ value_type: actor.find_property('width').value_type }),
        duration,
        progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        remove_on_complete: true,
    });
    transition.set_from(from);
    transition.set_to(to);
    transition.connect('stopped', (_t, finished) => {
        if (finished)
            onComplete();
    });
    actor.add_transition('width', transition);
}

/**
 * Replaces GNOME's wrong-password wiggle with a damped macOS-style shake.
 * Only runs if GNOME already started its own wiggle on the actor, so it follows
 * GNOME's decision (password failure, animations enabled).
 * @param {Clutter.Actor} actor
 */
export function replaceWiggleWithShake(actor) {
    if (!actor?.get_transition('translation-x'))
        return;

    // Cancels GNOME's wiggle; its awaited ease rejects as cancelled and stops.
    actor.remove_transition('translation-x');
    actor.translation_x = 0;

    const step = i => {
        if (i >= SHAKE_OFFSETS.length)
            return;
        actor.ease({
            translation_x: SHAKE_OFFSETS[i],
            duration: SHAKE_STEP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => step(i + 1),
        });
    };
    step(0);
}

/**
 * Hooks an AuthPrompt so a failed password plays the macOS shake.
 * The handler is tied to `owner`; disconnect with authPrompt._userVerifier.disconnectObject(owner).
 */
export function connectFailureShake(authPrompt, owner, shouldShake = () => true) {
    // Connected after GNOME's own handler, so its wiggle is already running.
    authPrompt._userVerifier?.connectObject('verification-failed', () => {
        if (shouldShake())
            replaceWiggleWithShake(authPrompt._entry);
    }, owner);
}

/**
 * Caps Lock icon and keyboard-layout badge inside the password entry
 * (primary icon slot; the secondary slot holds GNOME's peek-password icon).
 * Hides GNOME's "Caps lock is on" text label while active.
 */
export class PasswordIndicators {
    constructor(authPrompt) {
        this._authPrompt = authPrompt;
        this._entry = authPrompt._passwordEntry;
        if (!this._entry)
            return;

        // Only placed in the entry's primary-icon slot while an indicator is
        // shown, so the text and placeholder sit flush left otherwise. Clipped
        // so its width can ease from 0 and the text slides instead of jumping.
        this._box = new St.BoxLayout({
            style_class: 'wack-password-indicators',
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._capsIcon = new St.Icon({
            style_class: 'wack-caps-lock-icon',
            icon_name: 'osk-caps-lock-symbolic',
            accessible_name: _gs('Caps lock is on'),
        });
        this._layoutLabel = new St.Label({
            style_class: 'wack-input-source-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._capsIcon);
        this._box.add_child(this._layoutLabel);

        const backend = this._entry.get_context?.()?.get_backend() ?? Clutter.get_default_backend();
        this._keymap = backend.get_default_seat().get_keymap();
        this._inputSources = getInputSourceManager();

        // GNOME's warning label re-syncs itself through this._sync on map and
        // keymap changes; shadow it so the label stays collapsed.
        const warning = authPrompt._capsLockWarningLabel;
        if (warning?._sync) {
            this._warning = warning;
            warning._sync = () => {
                warning.remove_all_transitions();
                warning.set({ height: 0, opacity: 0 });
            };
            warning._sync();
        }

        this._entry.connectObject('notify::mapped', () => {
            if (this._entry.is_mapped()) {
                this._keymap.connectObject('state-changed', () => this._syncCaps(true), this);
                this._inputSources.connectObject(
                    'current-source-changed', () => this._syncLayout(true),
                    'sources-changed', () => this._syncLayout(true),
                    this);
            } else {
                this._keymap.disconnectObject(this);
                this._inputSources.disconnectObject(this);
            }

            this._sync(false, true);
        }, this);

        // The entry (and our box inside it) dies with the prompt; only drop signals.
        authPrompt.connectObject('destroy', () => this.destroy(false), this);

        if (this._entry.is_mapped()) {
            this._keymap.connectObject('state-changed', () => this._syncCaps(true), this);
            this._inputSources.connectObject(
                'current-source-changed', () => this._syncLayout(true),
                'sources-changed', () => this._syncLayout(true),
                this);
        }

        this._sync(false, true);
    }

    _sync(animate = true, force = false) {
        this._syncCaps(animate, force);
        this._syncLayout(animate, force);
    }

    _syncCaps(animate = true, force = false) {
        if (!this._keymap || !this._capsIcon)
            return;
        this._setShown(this._capsIcon, this._keymap.get_caps_lock_state(), animate, force);
    }

    _syncLayout(animate = true, force = false) {
        if (!this._inputSources || !this._layoutLabel)
            return;
        const count = Object.keys(this._inputSources.inputSources ?? {}).length;
        const shortName = this._inputSources.currentSource?.shortName ?? '';
        this._layoutLabel.text = shortName.toUpperCase();
        this._setShown(this._layoutLabel, count > 1 && shortName !== '', animate, force);
    }

    // `_wackShown` is the wanted state of each indicator.
    _setShown(indicator, shown, animate, force = false) {
        // Keymap state-changed also fires on unrelated modifier changes.
        if (!force && indicator._wackShown === shown)
            return;
        indicator._wackShown = shown;
        const indicators = [this._capsIcon, this._layoutLabel];
        const anyShown = indicators.some(i => i._wackShown);
        const slotted = this._entry?.get_primary_icon?.() === this._box;
        if (!anyShown && !slotted)
            return;

        // Last laid-out width, so an interrupted slide continues from where it is.
        const fromWidth = slotted ? Math.max(0, this._box.get_allocation_box().get_width()) : 0;
        if (!slotted && anyShown) {
            // Opening adds StEntry's fixed gap at once; start the text shifted
            // back by it so the slide begins exactly where the text was.
            this._entry.set_primary_icon(this._box);
            if (animate)
                this._textActors().forEach(a => (a.translation_x = -ENTRY_ICON_GAP));
        }

        indicators.forEach(i => (i.visible = !!i._wackShown));

        let targetWidth = 0;
        if (anyShown) {
            // Measured once in the stage, so the stylesheet applies.
            this._box.natural_width_set = false;
            targetWidth = this._box.get_preferred_width(-1)[1];
        }

        const duration = animate ? INDICATOR_SLIDE_MS : 0;
        const textShift = anyShown ? 0 : -ENTRY_ICON_GAP;

        if (duration > 0) {
            this._textActors().forEach(a => a.ease({
                translation_x: textShift,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
            easeWidth(this._box, fromWidth, targetWidth, duration, () => {
                if (anyShown) {
                    this._box.width = -1;
                    return;
                }
                this._entry.set_primary_icon(null);
                this._resetText();
                indicators.forEach(i => (i.visible = false));
            });
        } else {
            this._box.remove_transition('width');
            this._resetText();
            if (anyShown) {
                this._box.width = targetWidth > 0 ? -1 : 0;
            } else {
                this._box.width = 0;
                this._entry.set_primary_icon(null);
                indicators.forEach(i => (i.visible = false));
            }
        }
    }

    // The typed text and the placeholder (hint) are separate actors.
    _textActors() {
        if (!this._entry)
            return [];
        return [this._entry.clutter_text, this._entry.get_hint_actor()].filter(Boolean);
    }

    _resetText() {
        this._textActors().forEach(a => {
            a.remove_transition('translation-x');
            a.translation_x = 0;
        });
    }

    destroy(restoreEntry = true) {
        if (!this._box)
            return;

        this._entry?.disconnectObject(this);
        this._keymap?.disconnectObject(this);
        this._inputSources?.disconnectObject(this);
        this._authPrompt?.disconnectObject(this);

        if (restoreEntry) {
            if (this._warning) {
                delete this._warning._sync;
                this._warning._sync(false);
            }
            if (this._entry && this._entry.get_primary_icon() === this._box)
                this._entry.set_primary_icon(null);
            this._resetText();
            this._box.destroy();
        }
        this._warning = null;
        this._box = null;
        this._entry = null;
        this._authPrompt = null;
        this._keymap = null;
        this._inputSources = null;
    }
}

// Reuse gnome-shell's existing translation of the label we replace.
function _gs(msg) {
    return Gettext.domain('gnome-shell').gettext(msg);
}
