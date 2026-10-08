import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gettext from 'gettext';
import { getInputSourceManager } from 'resource:///org/gnome/shell/ui/status/keyboard.js';

// Damped macOS-style shake, in px. Each step is one ease of SHAKE_STEP_MS.
const SHAKE_OFFSETS = [-12, 10, -7, 4, -2, 0];
const SHAKE_STEP_MS = 55;

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

        this._box = new St.BoxLayout({
            style_class: 'wack-password-indicators',
            y_align: Clutter.ActorAlign.CENTER,
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
        this._entry.set_primary_icon(this._box);

        const backend = this._entry.get_context?.()?.get_backend() ?? Clutter.get_default_backend();
        this._keymap = backend.get_default_seat().get_keymap();
        this._keymap.connectObject('state-changed', () => this._syncCaps(), this);

        this._inputSources = getInputSourceManager();
        this._inputSources.connectObject(
            'current-source-changed', () => this._syncLayout(),
            'sources-changed', () => this._syncLayout(),
            this);

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

        // The entry (and our box inside it) dies with the prompt; only drop signals.
        authPrompt.connectObject('destroy', () => this.destroy(false), this);

        this._syncCaps();
        this._syncLayout();
    }

    _syncCaps() {
        this._capsIcon.visible = this._keymap.get_caps_lock_state();
    }

    _syncLayout() {
        const count = Object.keys(this._inputSources.inputSources ?? {}).length;
        const shortName = this._inputSources.currentSource?.shortName ?? '';
        this._layoutLabel.text = shortName.toUpperCase();
        this._layoutLabel.visible = count > 1 && shortName !== '';
    }

    destroy(restoreEntry = true) {
        if (!this._box)
            return;

        this._keymap?.disconnectObject(this);
        this._inputSources?.disconnectObject(this);
        this._authPrompt.disconnectObject(this);

        if (restoreEntry) {
            if (this._warning) {
                delete this._warning._sync;
                this._warning._sync(false);
            }
            if (this._entry.get_primary_icon() === this._box)
                this._entry.set_primary_icon(null);
            this._box.destroy();
        }
        this._warning = null;
        this._box = null;
    }
}

// Reuse gnome-shell's existing translation of the label we replace.
function _gs(msg) {
    return Gettext.domain('gnome-shell').gettext(msg);
}
