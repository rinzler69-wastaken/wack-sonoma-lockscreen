import GLib from 'gi://GLib';

export const HINT_TIMEOUT = 4; // Seconds before the "swipe to unlock" hint appears
export const CROSSFADE_TIME = 500; // Animation duration for transitions

// Visual positioning constants
export const DATETIME_TOP_FRACTION = 0.09; // Date/Time offset from the top (percentage of screen height)
export const HINT_VERTICAL_FRACTION = 0.875; // Hint offset from the top
export const HINT_NOTIF_MARGIN = 16; // Minimum vertical gap between hint and notifications
export const FADE_OUT_SCALE = 0.3; // Scale factor when the clock shrinks during unlock transition

// Date label height/gap from the clock
export const DATE_LABEL_HEIGHT = 25;
export const TIME_LABEL_HEIGHT_FALLBACK = 128; // Fallback natural height for the time label in logical px

// Background blur settings when entering the password prompt
export const PROMPT_BLUR_RADIUS = 50;
export const PROMPT_BLUR_BRIGHTNESS = 0.85;
export const PROMPT_BLUR_DURATION = 300;

export const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.wack-lockscreen-clock';

// Individual notification card blur settings
export const NOTIF_BLUR_RADIUS = 30;
export const NOTIF_BLUR_BRIGHTNESS = 1.0;
export const NOTIF_BLUR_NAME = 'wack-notif-blur';
export const NOTIF_CARD_RADIUS = 12;

// Cupertino mode prompt positioning
export const CUPERTINO_PROMPT_VERTICAL_FRACTION = 0.9475; // Prompt center Y as fraction of screen height
// UI limits
export const MAX_VISIBLE_CARDS = 3; // Maximum number of notification cards to show simultaneously

export function getPrettyDate() {
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
