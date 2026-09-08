export function _log(msg) {
    console.debug(msg);
}

export function _logError(msg) {
    console.error(msg);
}

export function _setActorVisible(actor, visible, opacity) {
    if (!actor)
        return;

    actor.remove_all_transitions();
    actor.visible = visible;
    actor.opacity = opacity;
}

// GDM mode positioning and transitions
export const GDM_USER_STACK_VERTICAL_FRACTION = 0.815; // User selection list center Y in GDM mode
export const GDM_DATETIME_TOP_FRACTION = 0.09; // Date/Time offset from the top (percentage of screen height)
export const GDM_CROSSFADE_DURATION = 300; // Transition duration for selection changes in ms
export const GDM_REST_PROMPT_VERTICAL_FRACTION = 0.66; // Prompt center Y when returning to lock screen from GDM
