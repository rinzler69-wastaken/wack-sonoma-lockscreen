import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

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
export const NOTIF_BLUR_RADIUS = 75;
export const NOTIF_BLUR_BRIGHTNESS = 1.0;
export const NOTIF_BLUR_NAME = 'wack-notif-blur';
export const NOTIF_CARD_RADIUS = 12;

// Cupertino mode prompt positioning
export const CUPERTINO_PROMPT_VERTICAL_FRACTION = 0.9575; // Prompt center Y as fraction of screen height
export const CUPERTINO_PROMPT_WHITE_BLEND_ALPHA = 0.08;

// GDM mode positioning and transitions
export const GDM_USER_STACK_VERTICAL_FRACTION = 0.815; // User selection list center Y in GDM mode
export const GDM_DATETIME_TOP_FRACTION = 0.09; // Date/Time offset from the top (percentage of screen height)
export const GDM_CROSSFADE_DURATION = 300; // Transition duration for selection changes in ms
export const GDM_REST_PROMPT_VERTICAL_FRACTION = 0.66; // Prompt center Y when returning to lock screen from GDM

// UI limits
export const MAX_VISIBLE_CARDS = 3; // Maximum number of notification cards to show simultaneously

// Cupertino unlock transition timings
export const CUPERTINO_UNLOCK_PANEL_FADE = 0;  // ms — panel fades out before the override fires
export const CUPERTINO_UNLOCK_TSO_DELAY = 0;   // ms — wait after panel fade before session mode override + slide-in
export const CUPERTINO_UNLOCK_FADE_DURATION = 400; // ms — duration of the actors fade-out + panel slide-in

// Crossfade speed presets (ms) for the unlock transition
export const CROSSFADE_SPEED_SLOW = 400;
export const CROSSFADE_SPEED_FAST = 300;

export function getPrettyDate() {
    // Respect LC_TIME (date/time formatting) over LANG (UI language) — toLocaleDateString(undefined) only reads LANG.
    let locale = (GLib.getenv('LC_TIME') || GLib.getenv('LANG') || '').split('.')[0].replace('_', '-');
    if (!locale || locale === 'C' || locale === 'POSIX')
        locale = 'en-US';
    try {
        return new Date().toLocaleDateString(locale, {weekday: 'long', month: 'long', day: 'numeric'});
    } catch (e) {
        // Bad locale string — let the engine pick.
        return new Date().toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'});
    }
}

/**
 * Parses a GNOME background XML slideshow and returns the active slide file path for the current time.
 * @param {string} xmlText The raw XML content of the slideshow
 * @param {number} [colorScheme] Optional color scheme enum (1=dark) for fallback
 * @returns {string|null} The resolved wallpaper file path or null
 */
export function resolveSlideshowXmlContent(xmlText, colorScheme = 0) {
    if (!xmlText)
        return null;

    // Parse starttime
    const yearMatch = xmlText.match(/<year>\s*(\d+)\s*<\/year>/);
    const monthMatch = xmlText.match(/<month>\s*(\d+)\s*<\/month>/);
    const dayMatch = xmlText.match(/<day>\s*(\d+)\s*<\/day>/);
    const hourMatch = xmlText.match(/<hour>\s*(\d+)\s*<\/hour>/);
    const minuteMatch = xmlText.match(/<minute>\s*(\d+)\s*<\/minute>/);
    const secondMatch = xmlText.match(/<second>\s*(\d+)\s*<\/second>/);

    const hasStartTime = yearMatch && monthMatch && dayMatch;
    if (!hasStartTime)
        return null;

    const year = parseInt(yearMatch[1], 10);
    const month = parseInt(monthMatch[1], 10) - 1;
    const day = parseInt(dayMatch[1], 10);
    const hour = hourMatch ? parseInt(hourMatch[1], 10) : 0;
    const minute = minuteMatch ? parseInt(minuteMatch[1], 10) : 0;
    const second = secondMatch ? parseInt(secondMatch[1], 10) : 0;

    const startDate = new Date(year, month, day, hour, minute, second);
    const startMs = startDate.getTime();
    const nowMs = Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));

    // Parse elements
    const items = [];
    const blockRegex = /<(static|transition)[^>]*>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = blockRegex.exec(xmlText)) !== null) {
        const type = match[1];
        const inner = match[2];
        const durationMatch = inner.match(/<duration>\s*([\d.]+)\s*<\/duration>/);
        const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;

        if (type === 'static') {
            const fileMatch = inner.match(/<file>\s*([^<]+)\s*<\/file>/);
            if (fileMatch) {
                items.push({
                    type: 'static',
                    duration: duration,
                    file: fileMatch[1].trim()
                });
            }
        } else if (type === 'transition') {
            const fromMatch = inner.match(/<from>\s*([^<]+)\s*<\/from>/);
            const toMatch = inner.match(/<to>\s*([^<]+)\s*<\/to>/);
            if (fromMatch && toMatch) {
                items.push({
                    type: 'transition',
                    duration: duration,
                    from: fromMatch[1].trim(),
                    to: toMatch[1].trim()
                });
            }
        }
    }

    if (items.length === 0)
        return null;

    let totalCycleDuration = 0;
    for (const item of items)
        totalCycleDuration += item.duration;

    if (totalCycleDuration > 0) {
        const position = elapsedSeconds % totalCycleDuration;
        let accumulated = 0;
        for (const item of items) {
            if (position >= accumulated && position < accumulated + item.duration) {
                if (item.type === 'static') {
                    return item.file;
                } else {
                    const progress = (position - accumulated) / item.duration;
                    return progress < 0.5 ? item.from : item.to;
                }
            }
            accumulated += item.duration;
        }
    }

    // Fallback if parsing or math fails: pick based on color scheme
    const files = [];
    for (const item of items) {
        if (item.file) files.push(item.file);
        else if (item.from) files.push(item.from);
    }
    if (files.length > 0) {
        const isDark = (colorScheme === 1);
        return isDark ? files[files.length - 1] : files[0];
    }

    return null;
}

/**
 * Centrally manages the horizontal centering constraint for clock labels.
 * @param {Clutter.Actor} label Clock label actor
 * @param {Clutter.Actor} wrapper Parent/source wrapper actor
 */
export function centerClockLabel(label, wrapper) {
    if (!label || !wrapper) return;
    const constraintName = 'wack-clock-center-x';
    const oldConstraint = label.get_constraint(constraintName);
    if (oldConstraint) {
        label.remove_constraint(constraintName);
    }
    label.add_constraint(new Clutter.AlignConstraint({
        name: constraintName,
        source: wrapper,
        align_axis: Clutter.AlignAxis.X_AXIS,
        factor: 0.5,
    }));
}
