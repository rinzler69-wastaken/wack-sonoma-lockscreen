import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperPromptColor } from '../main/alphaManager.js';
import { getPromptBlendOverlay } from '../main/colorUtils.js';
import {
    A11Y_BUTTON_WIDTH,
    A11Y_BUTTON_HEIGHT,
    A11Y_BUTTON_X_OFFSET,
    A11Y_BUTTON_Y_OFFSET,
    SESSION_BUTTON_WIDTH,
    SESSION_BUTTON_HEIGHT,
    SESSION_BUTTON_X_OFFSET,
    SESSION_BUTTON_Y_OFFSET,
} from '../main/constants.js';
import { _logError } from './gdmUtils.js';

export class GdmPromptStyling {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.cursorBlinkTimeoutId = 0;
        this.promptColorRequestId = 0;
    }

    teardown() {
        this.stopCursorBlink();
        this.clearCupertinoPromptBackground();
    }

    startCursorBlink() {
        this.stopCursorBlink();

        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;

        const entry = this.findPromptEntry(authPrompt);
        let cursorBlink = true;
        const currentMetadata = this._gdm._currentWallpaperMetadata;
        if (currentMetadata && currentMetadata.cursorBlink != null) {
            cursorBlink = currentMetadata.cursorBlink;
        } else if (this._gdm._extension) {
            cursorBlink = this._gdm._extension.getSettings().get_boolean('cursor-blink');
        }

        if (entry && entry.clutter_text) {
            entry.clutter_text.cursor_blink = cursorBlink;
            entry.clutter_text.cursor_visible = true;
        }

        if (cursorBlink === false)
            return;

        let visible = true;
        this.cursorBlinkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const currentAuthPrompt = this._gdm._dialog?._authPrompt;
            if (!this._gdm._dialog || !currentAuthPrompt || !currentAuthPrompt.visible) {
                this.cursorBlinkTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const currentEntry = this.findPromptEntry(currentAuthPrompt);
            if (!currentEntry || !currentEntry.clutter_text) {
                return GLib.SOURCE_CONTINUE;
            }

            if (!currentEntry.clutter_text.has_key_focus()) {
                currentEntry.clutter_text.cursor_visible = false;
                return GLib.SOURCE_CONTINUE;
            }

            visible = !visible;
            currentEntry.clutter_text.cursor_visible = visible;
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopCursorBlink() {
        if (this.cursorBlinkTimeoutId) {
            GLib.source_remove(this.cursorBlinkTimeoutId);
            this.cursorBlinkTimeoutId = 0;
        }
    }

    findPromptEntry(actor) {
        if (!actor)
            return null;

        if (actor.has_style_class_name?.('login-dialog-prompt-entry')) {
            return actor;
        }

        if (!actor.get_children)
            return null;

        for (const child of actor.get_children()) {
            const match = this.findPromptEntry(child);
            if (match)
                return match;
        }

        return null;
    }

    applyPromptEntryBackground(entry, color) {
        if (!color) {
            if (entry._wackOriginalStyle !== undefined) {
                entry.set_style(entry._wackOriginalStyle);
                delete entry._wackOriginalStyle;
            } else {
                entry.set_style(null);
            }
            delete entry._wackColor;
            return;
        }

        entry._wackColor = color;

        if (entry._wackOriginalStyle === undefined)
            entry._wackOriginalStyle = entry.get_style() ?? '';

        let shadowStyle = '';
        if (color.shadowAlpha !== undefined) {
            shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
        }

        let bgStyle;
        if (color.imagePath) {
            const imageUri = color.imagePath.startsWith('file://') ? color.imagePath : `file://${color.imagePath}`;
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;`;
        } else if (color.start && color.end && color.direction) {
            const startStr = `rgb(${color.start.r}, ${color.start.g}, ${color.start.b})`;
            const endStr = `rgb(${color.end.r}, ${color.end.g}, ${color.end.b})`;
            bgStyle = ` background-color: transparent !important; background-gradient-direction: ${color.direction} !important; background-gradient-start: ${startStr} !important; background-gradient-end: ${endStr} !important; background-image: none !important;`;
        } else {
            bgStyle = ` background-gradient-direction: none !important; background-image: none !important; background-color: rgb(${color.r}, ${color.g}, ${color.b}) !important;`;
        }

        entry.set_style(`${entry._wackOriginalStyle}${bgStyle}${shadowStyle}`);
    }

    applyCancelButtonBackground(button, color) {
        if (!button)
            return;

        if (!color) {
            button.disconnectObject(this);
            if (button._wackOriginalStyle !== undefined) {
                button.set_style(button._wackOriginalStyle);
                delete button._wackOriginalStyle;
            } else {
                button.set_style(null);
            }
            delete button._wackColor;
            delete button._wackPressed;
            return;
        }

        button._wackColor = color;

        if (button._wackOriginalStyle === undefined) {
            button._wackOriginalStyle = button.get_style() ?? '';

            button.connectObject(
                'notify::hover', () => this.updateCancelButtonStyle(button),
                'button-press-event', () => {
                    button._wackPressed = true;
                    this.updateCancelButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackPressed = false;
                    this.updateCancelButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                this
            );
        }

        this.updateCancelButtonStyle(button);
    }

    updateCancelButtonStyle(button) {
        const color = button._wackColor;
        if (!color)
            return;

        if (!button.hover)
            button._wackPressed = false;

        const isHovered = button.hover && !button._wackPressed;
        const isPressed = button._wackPressed;

        let bgStyle;
        let imgPath = color.cancelImagePath;

        if (isPressed && color.cancelActiveImagePath) {
            imgPath = color.cancelActiveImagePath;
        } else if (isHovered && color.cancelHoverImagePath) {
            imgPath = color.cancelHoverImagePath;
        }
        if (!imgPath && color.imagePath) {
            imgPath = color.imagePath;
        }

        if (imgPath) {
            const imageUri = imgPath.startsWith('file://') ? imgPath : `file://${imgPath}`;
            let overlayStyle = '';
            if (isPressed && !color.cancelActiveImagePath) {
                overlayStyle = ' filter: brightness(1.25);';
            } else if (isHovered && !color.cancelHoverImagePath) {
                overlayStyle = ' filter: brightness(1.12);';
            }
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;${overlayStyle}`;
        } else {
            // Flat sampled color only — CSS :hover/:active own the overlay.
            bgStyle = ` background-color: rgb(${color.r}, ${color.g}, ${color.b}) !important;`;
        }

        button.set_style(`${button._wackOriginalStyle}${bgStyle}`);
    }

    applyA11yButtonBackground(button, color) {
        if (!button)
            return;

        if (!color) {
            if (button._wackOriginalStyle !== undefined) {
                button.set_style(button._wackOriginalStyle);
                delete button._wackOriginalStyle;
            } else {
                button.set_style(null);
            }
            delete button._wackColor;
            return;
        }

        button._wackColor = color;

        if (button._wackOriginalStyle === undefined)
            button._wackOriginalStyle = button.get_style() ?? '';

        this.updateA11yButtonStyle(button);
    }

    updateA11yButtonStyle(button) {
        const color = button._wackColor;
        if (!color)
            return;

        const colorObj = color.a11yColor ?? color;
        const { r, g, b } = colorObj;

        // Flat sampled color only — hover/focus/active are owned entirely by
        // the existing stylesheet :hover/:focus/:active rules, same "sampled
        // circle + CSS overlay" model as the vibrancy avatar.
        const bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${r}, ${g}, ${b}) !important;`;
        button.set_style(`${button._wackOriginalStyle}${bgStyle}`);
    }

    applySessionButtonBackground(button, color) {
        if (!button)
            return;

        if (!color) {
            if (button._wackOriginalStyle !== undefined) {
                button.set_style(button._wackOriginalStyle);
                delete button._wackOriginalStyle;
            } else {
                button.set_style(null);
            }
            delete button._wackColor;
            return;
        }

        button._wackColor = color;

        if (button._wackOriginalStyle === undefined)
            button._wackOriginalStyle = button.get_style() ?? '';

        this.updateSessionButtonStyle(button);
    }

    updateSessionButtonStyle(button) {
        const color = button._wackColor;
        if (!color)
            return;

        const colorObj = color.sessionColor ?? color;
        const { r, g, b } = colorObj;

        // Flat sampled color only — hover/focus/active are owned entirely by
        // the existing stylesheet :hover/:focus/:active rules, same "sampled
        // circle + CSS overlay" model as the vibrancy avatar.
        const bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${r}, ${g}, ${b}) !important;`;
        button.set_style(`${button._wackOriginalStyle}${bgStyle}`);
    }

    clearCupertinoPromptBackground() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        const entry = this.findPromptEntry(authPrompt);
        if (entry) {
            if (entry._wackOriginalStyle !== undefined) {
                entry.set_style(entry._wackOriginalStyle);
                delete entry._wackOriginalStyle;
            } else {
                entry.set_style(null);
            }
            delete entry._wackColor;
        }

        const cancelButton = authPrompt?.cancelButton;
        if (cancelButton) {
            cancelButton.disconnectObject(this);
            if (cancelButton._wackOriginalStyle !== undefined) {
                cancelButton.set_style(cancelButton._wackOriginalStyle);
                delete cancelButton._wackOriginalStyle;
            } else {
                cancelButton.set_style(null);
            }
            delete cancelButton._wackColor;
            delete cancelButton._wackPressed;
        }

        const a11yButton = this._gdm._dialog?._a11yMenuButton
            ?? this._gdm._dialog?._bottomButtonGroup?._a11yMenuButton
            ?? this._gdm._dialog?._bottomButtonGroup?.get_children?.().find?.(c => c.has_style_class_name?.('a11y-button'));
        if (a11yButton) {
            a11yButton.disconnectObject(this);
            const menu = a11yButton._menu ?? a11yButton.menu;
            if (menu)
                menu.disconnectObject(this);
            if (a11yButton._wackOriginalStyle !== undefined) {
                a11yButton.set_style(a11yButton._wackOriginalStyle);
                delete a11yButton._wackOriginalStyle;
            } else {
                a11yButton.set_style(null);
            }
            delete a11yButton._wackColor;
            delete a11yButton._wackPressed;
        }

        const sessionButton = this._gdm._dialog?._authMenuButton
            ?? this._gdm._dialog?._sessionMenuButton?._button
            ?? this._gdm._dialog?._sessionMenuButton?.get_child?.()
            ?? this._gdm._dialog?._sessionMenuButton
            ?? this._gdm._dialog?._bottomButtonGroup?._authMenuButton
            ?? this._gdm._dialog?._bottomButtonGroup?._sessionMenuButton?._button
            ?? this._gdm._dialog?._bottomButtonGroup?._sessionMenuButton
            ?? this._gdm._dialog?._bottomButtonGroup?.get_children?.().find?.(c => c.has_style_class_name?.('login-dialog-auth-menu-button') || c.has_style_class_name?.('login-dialog-session-list-button'));
        if (sessionButton) {
            sessionButton.disconnectObject(this);
            const menu = sessionButton._menu ?? sessionButton.menu;
            if (menu)
                menu.disconnectObject(this);
            if (sessionButton._wackOriginalStyle !== undefined) {
                sessionButton.set_style(sessionButton._wackOriginalStyle);
                delete sessionButton._wackOriginalStyle;
            } else {
                sessionButton.set_style(null);
            }
            delete sessionButton._wackColor;
            delete sessionButton._wackPressed;
        }
    }

    async updateCupertinoPromptBackground(metadata = null) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        const entry = this.findPromptEntry(authPrompt);
        if (!entry)
            return;

        if (!authPrompt.has_style_class_name('wack-cupertino-prompt')) {
            this.clearCupertinoPromptBackground();
            return;
        }

        const effectiveMetadata = metadata ?? this._gdm._currentWallpaperMetadata;

        let promptVibrancy = true;
        if (effectiveMetadata && effectiveMetadata.promptVibrancy != null) {
            promptVibrancy = effectiveMetadata.promptVibrancy;
        } else {
            const settings = this._gdm._extension.getSettings();
            promptVibrancy = settings.get_boolean('prompt-vibrancy');
        }

        if (!promptVibrancy) {
            this.clearCupertinoPromptBackground();
            return;
        }

        let wellH = 0;
        if (this._gdm._cupertinoRestPrompt?._userWell) {
            const [, , , hSize] = this._gdm._cupertinoRestPrompt._userWell.get_preferred_size();
            wellH = hSize > 0 ? hSize : 0;
        }

        let yCenterFraction = null;
        let promptBounds = null;
        if (entry) {
            const [xTrans, yTrans] = entry.get_transformed_position();
            const wTrans = entry.get_width() || 0;
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (yTrans > 0 && monitorHeight > 0)
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            if (wTrans > 0 && hTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && xTrans >= monitorX && yTrans >= monitorY) {
                promptBounds = {
                    x1: Math.max(0, Math.min(1, (xTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (xTrans + wTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (yTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (yTrans + hTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let cancelBounds = null;
        const cancelButton = authPrompt?.cancelButton;
        if (cancelButton && cancelButton.get_stage()) {
            const [cxTrans, cyTrans] = cancelButton.get_transformed_position();
            const cwTrans = cancelButton.get_width() || 34;
            const chTrans = cancelButton.get_height() || 34;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (cwTrans > 0 && chTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && cxTrans >= monitorX && cyTrans >= monitorY) {
                cancelBounds = {
                    x1: Math.max(0, Math.min(1, (cxTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (cxTrans + cwTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (cyTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (cyTrans + chTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let avatarBounds = null;
        const avatarButton = this._gdm._cupertinoRestPrompt?._userWell?.get_child()?._avatarButton
            ?? authPrompt?._userWell?.get_child()?._avatarButton;
        if (avatarButton && avatarButton.get_stage()) {
            const [axTrans, ayTrans] = avatarButton.get_transformed_position();
            const awTrans = avatarButton.get_width() || 56;
            const ahTrans = avatarButton.get_height() || 56;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (awTrans > 0 && ahTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && axTrans >= monitorX && ayTrans >= monitorY) {
                avatarBounds = {
                    x1: Math.max(0, Math.min(1, (axTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (axTrans + awTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (ayTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (ayTrans + ahTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let a11yBounds = null;
        const currentDialog = this._gdm._dialog;
        const a11yButton = currentDialog?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children?.().find?.(c => c.has_style_class_name?.('a11y-button'));
        if (a11yButton && a11yButton.get_stage()) {
            const [axTrans, ayTrans] = a11yButton.get_transformed_position();
            const awTrans = a11yButton.get_width() || A11Y_BUTTON_WIDTH;
            const ahTrans = a11yButton.get_height() || A11Y_BUTTON_HEIGHT;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (awTrans > 0 && ahTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && axTrans >= monitorX && ayTrans >= monitorY) {
                const effectiveX = axTrans + A11Y_BUTTON_X_OFFSET;
                const effectiveY = ayTrans + A11Y_BUTTON_Y_OFFSET;
                a11yBounds = {
                    x1: Math.max(0, Math.min(1, (effectiveX - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (effectiveX + awTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (effectiveY - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (effectiveY + ahTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let sessionBounds = null;
        const sessionButton = currentDialog?._authMenuButton
            ?? currentDialog?._sessionMenuButton?._button
            ?? currentDialog?._sessionMenuButton?.get_child?.()
            ?? currentDialog?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?._authMenuButton
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton?._button
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children?.().find?.(c => c.has_style_class_name?.('login-dialog-auth-menu-button') || c.has_style_class_name?.('login-dialog-session-list-button'));
        if (sessionButton && sessionButton.get_stage()) {
            const [sxTrans, syTrans] = sessionButton.get_transformed_position();
            const swTrans = sessionButton.get_width() || SESSION_BUTTON_WIDTH;
            const shTrans = sessionButton.get_height() || SESSION_BUTTON_HEIGHT;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (swTrans > 0 && shTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && sxTrans >= monitorX && syTrans >= monitorY) {
                const effectiveX = sxTrans + SESSION_BUTTON_X_OFFSET;
                const effectiveY = syTrans + SESSION_BUTTON_Y_OFFSET;
                sessionBounds = {
                    x1: Math.max(0, Math.min(1, (effectiveX - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (effectiveX + swTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (effectiveY - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (effectiveY + shTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let wallpaperParams = null;
        if (effectiveMetadata) {
            const promptColor = effectiveMetadata.promptColor;
            const hasValidPromptImage = promptColor?.imagePath &&
                Gio.File.new_for_path(promptColor.imagePath).query_exists(null);
            const hasValidCancelImages = promptColor?.cancelImagePath &&
                Gio.File.new_for_path(promptColor.cancelImagePath).query_exists(null) &&
                promptColor?.cancelHoverImagePath &&
                Gio.File.new_for_path(promptColor.cancelHoverImagePath).query_exists(null) &&
                promptColor?.cancelActiveImagePath &&
                Gio.File.new_for_path(promptColor.cancelActiveImagePath).query_exists(null);

            let avatarColor = promptColor?.avatarColor;
            if (!avatarColor && promptColor && promptColor.r != null) {
                const raw = { r: promptColor.r, g: promptColor.g, b: promptColor.b };
                const overlay = getPromptBlendOverlay(raw);
                avatarColor = {
                    r: raw.r,
                    g: raw.g,
                    b: raw.b,
                    rgba: `rgba(${raw.r}, ${raw.g}, ${raw.b}, 1.0)`,
                    overlayR: overlay.overlayR,
                    overlayG: overlay.overlayG,
                    overlayB: overlay.overlayB,
                    overlayAlpha: overlay.blendAlpha,
                    overlayRgba: `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`,
                };
            }

            if (promptColor &&
                promptColor.r != null &&
                promptColor.g != null &&
                promptColor.b != null &&
                hasValidPromptImage) {
                this.applyPromptEntryBackground(entry, promptColor);
                if (authPrompt.cancelButton)
                    this.applyCancelButtonBackground(authPrompt.cancelButton, promptColor);
                if (this._gdm?._avatarManager && avatarColor)
                    this._gdm._avatarManager.updateAvatarVibrancy(avatarColor);
                if (a11yButton)
                    this.applyA11yButtonBackground(a11yButton, promptColor);
                if (sessionButton)
                    this.applySessionButtonBackground(sessionButton, promptColor);

                if (hasValidCancelImages)
                    return;
            }

            wallpaperParams = {
                // Prefer the stable source URI (original wallpaper file) over the
                // timestamped temp JPG copy. The temp copy gets a fresh mtime every
                // time _saveWallpaper() runs, which breaks cacheKey stability and
                // causes the slice cleanup to delete still-valid files on every visit.
                // For XML slideshows, use resolved_slide_path directly so the cache
                // key is based on the actual current image file rather than the XML.
                // source_uri points to the user's actual wallpaper file whose mtime
                // only changes when the wallpaper genuinely changes — same strategy
                // as GDM's own background system.
                uri: effectiveMetadata.resolved_slide_path
                    ? `file://${effectiveMetadata.resolved_slide_path}`
                    : (effectiveMetadata.source_uri ?? effectiveMetadata.uri),
                isColor: effectiveMetadata.is_color,
                primaryColor: effectiveMetadata.primary_color,
                secondaryColor: effectiveMetadata.secondary_color,
                shadingType: effectiveMetadata.shading_type,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
                promptBounds: promptBounds,
                cancelBounds: cancelBounds,
                avatarBounds: avatarBounds,
                a11yBounds: a11yBounds,
                sessionBounds: sessionBounds,
            };
        } else {
            const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const uri = bgSettings.get_string('picture-uri');
            const style = bgSettings.get_enum('picture-options');
            const primaryColor = bgSettings.get_string('primary-color');
            const secondaryColor = bgSettings.get_string('secondary-color');
            const shadingType = bgSettings.get_enum('color-shading-type');
            const isColor = (style === 0);

            wallpaperParams = {
                uri,
                isColor,
                primaryColor,
                secondaryColor,
                shadingType,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
                promptBounds: promptBounds,
                cancelBounds: cancelBounds,
                avatarBounds: avatarBounds,
                a11yBounds: a11yBounds,
                sessionBounds: sessionBounds,
            };
        }

        if (!wallpaperParams)
            return;

        const requestId = ++this.promptColorRequestId;
        const color = await getWallpaperPromptColor(wallpaperParams);

        if (requestId !== this.promptColorRequestId)
            return;

        const currentPrompt = this._gdm._dialog?._authPrompt;
        const currentEntry = this.findPromptEntry(currentPrompt);
        if (!currentPrompt || !currentEntry || !currentPrompt.has_style_class_name('wack-cupertino-prompt'))
            return;

        if (!color) {
            this.clearCupertinoPromptBackground();
            return;
        }

        this.applyPromptEntryBackground(currentEntry, color);
        if (currentPrompt.cancelButton)
            this.applyCancelButtonBackground(currentPrompt.cancelButton, color);

        let finalAvatarColor = color?.avatarColor;
        if (!finalAvatarColor && color && color.r != null) {
            const raw = { r: color.r, g: color.g, b: color.b };
            const overlay = getPromptBlendOverlay(raw);
            finalAvatarColor = {
                r: raw.r,
                g: raw.g,
                b: raw.b,
                rgba: `rgba(${raw.r}, ${raw.g}, ${raw.b}, 1.0)`,
                overlayR: overlay.overlayR,
                overlayG: overlay.overlayG,
                overlayB: overlay.overlayB,
                overlayAlpha: overlay.blendAlpha,
                overlayRgba: `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`,
            };
        }
        if (this._gdm?._avatarManager && finalAvatarColor)
            this._gdm._avatarManager.updateAvatarVibrancy(finalAvatarColor);

        if (a11yButton)
            this.applyA11yButtonBackground(a11yButton, color);
        if (sessionButton)
            this.applySessionButtonBackground(sessionButton, color);
    }
}
