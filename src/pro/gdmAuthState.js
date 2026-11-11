import { _log } from './gdmUtils.js';

export const GdmAuthState = Object.freeze({
    IDLE: 'idle',                     // User selection list / at rest
    SELECTION: 'selection',           // User selected, entry transition in progress
    AUTHENTICATING: 'authenticating', // Auth prompt active, waiting for credentials
    RESETTING: 'resetting',           // Cancelling / animating prompt out
    SUCCESS: 'success',               // Verification succeeded, fading out
});

export const AvatarType = Object.freeze({
    IMAGE: 'IMAGE',
    SYMBOLIC: 'SYMBOLIC',
    PENDING: 'PENDING',
});

const VALID_TRANSITIONS = {
    [GdmAuthState.IDLE]: [GdmAuthState.SELECTION, GdmAuthState.SUCCESS],
    [GdmAuthState.SELECTION]: [GdmAuthState.AUTHENTICATING, GdmAuthState.RESETTING, GdmAuthState.SUCCESS, GdmAuthState.IDLE],
    [GdmAuthState.AUTHENTICATING]: [GdmAuthState.AUTHENTICATING, GdmAuthState.RESETTING, GdmAuthState.SUCCESS, GdmAuthState.IDLE],
    [GdmAuthState.RESETTING]: [GdmAuthState.IDLE, GdmAuthState.SELECTION, GdmAuthState.SUCCESS],
    [GdmAuthState.SUCCESS]: [GdmAuthState.IDLE], // Only reset() or teardown can leave SUCCESS
};

export class GdmAuthStateController {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this._state = GdmAuthState.IDLE;
        this._isNotListed = false;
        this._skipLegacyEntry = false;
    }

    get state() {
        return this._state;
    }

    get isIdle() {
        return this._state === GdmAuthState.IDLE;
    }

    get isSelection() {
        return this._state === GdmAuthState.SELECTION;
    }

    get isAuthenticating() {
        return this._state === GdmAuthState.AUTHENTICATING;
    }

    get isResetting() {
        return this._state === GdmAuthState.RESETTING;
    }

    get isSuccess() {
        return this._state === GdmAuthState.SUCCESS;
    }

    get isNotListed() {
        return this._isNotListed;
    }

    set isNotListed(value) {
        this._isNotListed = Boolean(value);
    }

    get skipLegacyEntry() {
        return this._skipLegacyEntry;
    }

    set skipLegacyEntry(value) {
        this._skipLegacyEntry = Boolean(value);
    }

    /**
     * Backwards-compatibility getter for legacy animation state checks.
     * Maps the explicit states into the three legacy string states.
     */
    get legacyAnimationState() {
        if (this.isSelection)
            return 'selection';
        if (this.isSuccess)
            return 'success';
        return 'idle';
    }

    canTransitionTo(targetState) {
        const allowed = VALID_TRANSITIONS[this._state];
        return allowed ? allowed.includes(targetState) : false;
    }

    transitionTo(targetState, reason = '') {
        if (this._state === targetState)
            return true;

        if (!this.canTransitionTo(targetState)) {
            _log(`[WACK/GdmAuth] Invalid transition rejected: ${this._state} -> ${targetState} (reason: ${reason})`);
            return false;
        }

        const prevState = this._state;
        this._state = targetState;
        _log(`[WACK/GdmAuth] State change: ${prevState} -> ${targetState} (reason: ${reason}, notListed: ${this._isNotListed})`);
        return true;
    }

    reset(reason = 'reset') {
        const prevState = this._state;
        this._state = GdmAuthState.IDLE;
        this._isNotListed = false;
        this._skipLegacyEntry = false;
        _log(`[WACK/GdmAuth] Reset to IDLE from ${prevState} (reason: ${reason})`);
    }

    selectUser(isNotListed = false) {
        this._isNotListed = Boolean(isNotListed);
        this._skipLegacyEntry = false;
        return this.transitionTo(GdmAuthState.SELECTION, 'user_selected');
    }

    beginAuthentication() {
        return this.transitionTo(GdmAuthState.AUTHENTICATING, 'auth_prompt_ready');
    }

    beginReset() {
        return this.transitionTo(GdmAuthState.RESETTING, 'reset_started');
    }

    finishReset() {
        this._isNotListed = false;
        return this.transitionTo(GdmAuthState.IDLE, 'reset_finished');
    }

    markSuccess() {
        this._skipLegacyEntry = true;
        return this.transitionTo(GdmAuthState.SUCCESS, 'verification_succeeded');
    }
}

