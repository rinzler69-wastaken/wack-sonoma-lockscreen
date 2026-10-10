import Gio from 'gi://Gio';

export function _log(msg) {
    console.debug(msg);
}

export function _logError(msg) {
    console.error(msg);
}

export function _setActorVisible(actor, visible, opacity) {
    if (!actor || actor._isDestroyed)
        return;

    actor.remove_all_transitions();
    actor.visible = visible;
    actor.opacity = opacity;
}

/**
 * Resolves a wallpaper URI accessible by the GDM greeter (running as user 'gdm').
 * In GDM, user home directories may be mode 0700, making source_uri unreadable.
 * meta.uri points to the shared world-readable copy in /var/tmp created by
 * crossSessionManager, so prefer it whenever it exists on disk.
 *
 * @param {object} meta
 * @returns {string|null}
 */
// The login dialog's UserList keeps `_items` as an object keyed by user name
// on GNOME 46 and as a Map on later versions.
export function userListItems(userList) {
    const items = userList?._items;
    if (!items)
        return [];
    return items instanceof Map ? [...items.values()] : Object.values(items);
}

export function resolveGdmAccessibleUri(meta) {
    if (!meta)
        return null;
    if (meta.uri) {
        const uriPath = meta.uri.startsWith('file://') ? meta.uri.substring(7) : meta.uri;
        if (Gio.File.new_for_path(uriPath).query_exists(null))
            return meta.uri.startsWith('file://') ? meta.uri : `file://${meta.uri}`;
    }
    if (meta.resolved_slide_path)
        return meta.resolved_slide_path.startsWith('file://') ? meta.resolved_slide_path : `file://${meta.resolved_slide_path}`;
    const fallback = meta.source_uri ?? meta.uri;
    if (fallback)
        return fallback.startsWith('file://') ? fallback : `file://${fallback}`;
    return null;
}

// GDM mode positioning and transitions
export const GDM_USER_STACK_VERTICAL_FRACTION_WITH_CSA = 1.08; // User selection list bottom anchor Y with CSA
export const GDM_USER_STACK_VERTICAL_FRACTION_NO_CSA = 1.04;   // User selection list bottom anchor Y without CSA
export const GDM_USER_LIST_CAP_WITH_CSA = 3;                   // Max visible accounts before scrolling with CSA
export const GDM_USER_LIST_CAP_NO_CSA = 4;                     // Max visible accounts before scrolling without CSA
export const GDM_DATETIME_TOP_FRACTION = 0.09; // Date/Time offset from the top (percentage of screen height)
export const GDM_CROSSFADE_DURATION = 300; // Transition duration for selection changes in ms
export const GDM_REST_PROMPT_VERTICAL_FRACTION = 0.66; // Prompt center Y when returning to lock screen from GDM
