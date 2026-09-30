import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Clutter from 'gi://Clutter';

let _cachedWallClock = null;

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
export const PROMPT_BLUR_BRIGHTNESS = 1.0;

// Cancel button sampling constants (for lockscreen)
export const CANCEL_BUTTON_HOVER_OVERLAY_ALPHA = 0.12;
export const CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA = 0.24;
export const CANCEL_BUTTON_WIDTH = 34; // px
export const CANCEL_BUTTON_HEIGHT = 34; // px
export const CANCEL_BUTTON_X_OFFSET = 0; // px
export const CANCEL_BUTTON_Y_OFFSET = 0; // px

// Avatar button sampling constants (for lockscreen)
export const AVATAR_BUTTON_WIDTH = 56; // px
export const AVATAR_BUTTON_HEIGHT = 56; // px
export const AVATAR_BUTTON_X_OFFSET = 0; // px
export const AVATAR_BUTTON_Y_OFFSET = 0; // px

// Accessibility button sampling constants (for lockscreen)
export const A11Y_BUTTON_WIDTH = 34; // px
export const A11Y_BUTTON_HEIGHT = 34; // px
export const A11Y_BUTTON_X_OFFSET = 0; // px
export const A11Y_BUTTON_Y_OFFSET = 0; // px

// Desktop Environment / Session select button sampling constants (for lockscreen)
export const SESSION_BUTTON_WIDTH = 34; // px
export const SESSION_BUTTON_HEIGHT = 34; // px
export const SESSION_BUTTON_X_OFFSET = 0; // px
export const SESSION_BUTTON_Y_OFFSET = 0; // px


// Individual notification card blur settings
export const NOTIF_BLUR_RADIUS = 50;
export const NOTIF_BLUR_BRIGHTNESS = 1.0;
export const NOTIF_BLUR_NAME = 'wack-notif-blur';
export const NOTIF_CARD_RADIUS = 12;

// Cupertino mode prompt positioning
export const CUPERTINO_PROMPT_VERTICAL_FRACTION = 0.9575; // Prompt center Y as fraction of screen height
export const CUPERTINO_CHIP_VERTICAL_FRACTION = 0.9025; // Prompt chip actual center Y as fraction of screen height (offset lower than stack)
export { CUPERTINO_PROMPT_WHITE_BLEND_ALPHA } from './colorUtils.js';

// UI limits
export const MAX_VISIBLE_CARDS = 3; // Maximum number of notification cards to show simultaneously

// Cupertino unlock transition timings
export const CUPERTINO_UNLOCK_PANEL_FADE = 150;  // ms — panel slides out before the override fires (0 blanks it in one frame)
export const CUPERTINO_UNLOCK_TSO_DELAY = 150;   // ms — wait after the panel leaves before session mode override + slide-in
export const CUPERTINO_UNLOCK_FADE_DURATION = 400; // ms — duration of the actors fade-out + panel slide-in

// Crossfade speed presets (ms) for the unlock transition
export const CROSSFADE_SPEED_SLOW = 400;
export const CROSSFADE_SPEED_FAST = 300;

export function normalizeLocaleTag(rawLocale) {
    if (!rawLocale || typeof rawLocale !== 'string')
        return undefined;

    const trimmed = rawLocale.trim();
    if (!trimmed || trimmed === 'C' || trimmed === 'POSIX')
        return undefined;

    const tag = trimmed.split('.')[0].replace('_', '-');
    try {
        const supported = Intl.DateTimeFormat.supportedLocalesOf([tag]);
        return supported.length > 0 ? supported[0] : undefined;
    } catch {
        return undefined;
    }
}

export function getPrettyDate(style = 'full', wallClock = null, explicitLocale = null) {
    const targetLocale = normalizeLocaleTag(explicitLocale) ??
        normalizeLocaleTag(GLib.getenv('LC_TIME')) ??
        normalizeLocaleTag(GLib.getenv('LANG')) ??
        undefined;

    if (style === 'short') {
        const clock = wallClock ?? (_cachedWallClock ??= new GnomeDesktop.WallClock({ time_only: false }));
        if (clock) {
            try {
                const now = GLib.DateTime.new_now_local();
                const full = clock.string_for_datetime(now, 0, true, true, false);
                // In GnomeDesktop.WallClock, the date part is separated from time by an en-space (\u2002)
                const datePart = full ? full.split('\u2002')[0].trim() : '';
                if (datePart)
                    return datePart;
            } catch {
            }
        }

        try {
            const now = GLib.DateTime.new_now_local();
            const formatted = now.format('%a %e %b');
            const trimmed = formatted ? formatted.trim() : '';
            if (trimmed)
                return trimmed;
        } catch {
        }

        try {
            const dtf = new Intl.DateTimeFormat(targetLocale, { weekday: 'short', month: 'short', day: 'numeric' });
            return dtf.format(new Date());
        } catch {
            return new Date().toLocaleDateString(targetLocale, { weekday: 'short', month: 'short', day: 'numeric' });
        }
    }

    // Full style: verbose date presentation (e.g. "Wednesday, September 16" / "Mittwoch, 16. September")
    try {
        const dtf = new Intl.DateTimeFormat(targetLocale, { weekday: 'long', month: 'long', day: 'numeric' });
        const parts = dtf.formatToParts(new Date());
        let result = '';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            result += part.value;
            if (part.type === 'weekday') {
                const next = parts[i + 1];
                if (next && next.type === 'literal' && !next.value.includes(',') && !next.value.includes('،') && !next.value.includes('、')) {
                    result += ',';
                }
            }
        }
        return result;
    } catch {
        try {
            return new Date().toLocaleDateString(targetLocale, { weekday: 'long', month: 'long', day: 'numeric' });
        } catch {
            return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        }
    }
}

/**
 * Parses a GNOME background XML slideshow and returns the active slide file path and transition metadata for the current time.
 * @param {string} xmlText The raw XML content of the slideshow
 * @param {number} [colorScheme] Optional color scheme enum (1=dark) for fallback
 * @returns {{filePath: string, isTransition: boolean, from: string, to: string, progress: number}|null} The resolved wallpaper details or null
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
                const elapsedInItem = position - accumulated;
                const remainingDuration = Math.max(0, item.duration - elapsedInItem);
                if (item.type === 'static') {
                    return {
                        filePath: item.file,
                        isTransition: false,
                        from: item.file,
                        to: item.file,
                        progress: 0.0,
                        duration: item.duration,
                        remainingDuration: remainingDuration,
                        totalCycleDuration: totalCycleDuration,
                    };
                } else {
                    const rawProgress = item.duration > 0 ? elapsedInItem / item.duration : 0;
                    const progress = Math.max(0.0, Math.min(1.0, rawProgress));
                    return {
                        filePath: progress < 0.5 ? item.from : item.to,
                        isTransition: true,
                        from: item.from,
                        to: item.to,
                        progress: progress,
                        duration: item.duration,
                        remainingDuration: remainingDuration,
                        totalCycleDuration: totalCycleDuration,
                    };
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
        const fallbackPath = isDark ? files[files.length - 1] : files[0];
        return {
            filePath: fallbackPath,
            isTransition: false,
            from: fallbackPath,
            to: fallbackPath,
            progress: 0.0,
            duration: 0,
            remainingDuration: 0,
            totalCycleDuration: 0,
        };
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

