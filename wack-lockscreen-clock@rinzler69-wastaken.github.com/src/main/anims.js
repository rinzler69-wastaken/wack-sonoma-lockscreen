export const DEFAULT_CLOCK_ANIMATION = 'scale-down';
export const DEFAULT_PROMPT_ANIMATION = 'shell';

export const CLOCK_ANIMATION_OPTIONS = [
    ['scale-down', 'Scale Down'],
    ['zoom-up', 'Zoom Up'],
    ['slide-up', 'Slide Up'],
    ['fade', 'Fade'],
];

export const PROMPT_ANIMATION_OPTIONS = [
    ['shell', 'GNOME Default'],
    ['rise', 'Rise'],
    ['zoom', 'Zoom'],
    ['fade', 'Fade'],
];

export const CLOCK_ANIMATIONS = new Set(CLOCK_ANIMATION_OPTIONS.map(([value]) => value));
export const PROMPT_ANIMATIONS = new Set(PROMPT_ANIMATION_OPTIONS.map(([value]) => value));

function easeOutCubic(value) {
    const clamped = Math.min(Math.max(value, 0), 1);
    return 1 - Math.pow(1 - clamped, 3);
}

function easeInCubic(value) {
    const clamped = Math.min(Math.max(value, 0), 1);
    return clamped * clamped * clamped;
}

export function getAnimationSetting(settings, key, fallback, allowedValues) {
    if (!settings)
        return fallback;

    const value = settings.get_string(key);
    return allowedValues.has(value) ? value : fallback;
}

export function createAnimationState() {
    return {
        lastProgress: 0,
    };
}

export function applyClockAnimation(animation, actor, clockActor, progress, params, state) {
    if (!actor)
        return;

    const fadeOutScale = params?.fadeOutScale ?? 0.3;
    const slideUpDistance = params?.slideUpDistance ?? 720;
    const eased = easeOutCubic(progress);
    const easedIn = easeInCubic(progress);
    const direction = progress < (state?.lastProgress ?? progress) ? 'in' : 'out';

    let opacity = Math.round(255 * (1 - progress));
    let scale = 1;
    let translationY = 0;

    switch (animation) {
    case 'scale-down':
        scale = 0.7 + 0.3 * (1 - progress);
        break;
    case 'zoom-up':
        scale = 1 + 0.18 * progress;
        break;
    case 'slide-up': {
        if (direction === 'in') {
            opacity = Math.round(255 * (1 - easedIn));
            translationY = 96 * easedIn;
        } else {
            opacity = Math.round(255 * (1 - easedIn));
            translationY = -slideUpDistance * easedIn;
        }
        break;
    }
    case 'fade':
    default:
        break;
    }

    clockActor?.set({ opacity });
    actor.set({
        opacity,
        scale_x: scale,
        scale_y: scale,
        translation_y: translationY,
    });

    if (state)
        state.lastProgress = progress;
}

export function applyPromptAnimation(animation, actor, progress) {
    if (!actor)
        return;

    if (animation === 'shell') {
        const scale = 0.5 + 0.5 * progress;
        actor.set({
            opacity: Math.round(255 * progress),
            scale_x: scale,
            scale_y: scale,
            translation_y: 200 * (1 - progress),
        });
        return;
    }

    const eased = easeOutCubic(progress);
    const easedIn = easeInCubic(progress);
    let scale = 1;
    let translationY = 0;

    switch (animation) {
    case 'rise':
        translationY = 200 * (1 - progress);
        break;
    case 'zoom':
        scale = 0.8 + 0.2 * progress;
        break;
    case 'fade':
    default:
        break;
    }

    actor.set({
        opacity: Math.round(255 * progress),
        scale_x: scale,
        scale_y: scale,
        translation_y: translationY,
    });
}

export function resetAnimationActors(clockActor, promptActor) {
    clockActor?.set({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        translation_y: 0,
    });
    promptActor?.set({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        translation_y: 0,
    });
}