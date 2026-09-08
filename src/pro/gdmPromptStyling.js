import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperPromptColor } from '../main/alphaManager.js';
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
        if (!entry || !color)
            return;

        if (entry._wackOriginalStyle === undefined)
            entry._wackOriginalStyle = entry.get_style() ?? '';

        let shadowStyle = '';
        if (color.shadowAlpha !== undefined) {
            shadowStyle = ` box-shadow: 0 2px 24px 16px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
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
        if (!button || !color)
            return;

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

        let shadowStyle = '';
        if (color.shadowAlpha !== undefined) {
            shadowStyle = ` box-shadow: 0 2px 24px 16px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
        }

        let bgStyle;
        let imgPath = color.cancelImagePath;
        if (button._wackPressed && color.cancelActiveImagePath) {
            imgPath = color.cancelActiveImagePath;
        } else if (button.hover && color.cancelHoverImagePath) {
            imgPath = color.cancelHoverImagePath;
        }
        if (!imgPath && color.imagePath) {
            imgPath = color.imagePath;
        }

        if (imgPath) {
            const imageUri = imgPath.startsWith('file://')
                ? imgPath
                : `file://${imgPath}`;
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;`;
        } else {
            let r = color.r;
            let g = color.g;
            let b = color.b;

            if (button._wackPressed) {
                r = Math.round(r * 0.75 + 255 * 0.25);
                g = Math.round(g * 0.75 + 255 * 0.25);
                b = Math.round(b * 0.75 + 255 * 0.25);
            } else if (button.hover) {
                r = Math.round(r * 0.875 + 255 * 0.125);
                g = Math.round(g * 0.875 + 255 * 0.125);
                b = Math.round(b * 0.875 + 255 * 0.125);
            }
            bgStyle = ` background-color: rgb(${r}, ${g}, ${b}) !important;`;
        }

        button.set_style(`${button._wackOriginalStyle}${bgStyle}${shadowStyle}`);
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
    }

    async updateCupertinoPromptBackground(metadata = null) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        const entry = this.findPromptEntry(authPrompt);
        if (!entry)
            return;

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

        let wallpaperParams = null;
        if (effectiveMetadata) {
            const promptColor = effectiveMetadata.promptColor;
            const hasValidPromptImage = promptColor?.imagePath &&
                Gio.File.new_for_path(promptColor.imagePath).query_exists(null);

            if (promptColor &&
                promptColor.r != null &&
                promptColor.g != null &&
                promptColor.b != null &&
                hasValidPromptImage) {
                this.applyPromptEntryBackground(entry, promptColor);
                if (authPrompt.cancelButton)
                    this.applyCancelButtonBackground(authPrompt.cancelButton, promptColor);
                return;
            }

            wallpaperParams = {
                uri: effectiveMetadata.uri,
                isColor: effectiveMetadata.is_color,
                primaryColor: effectiveMetadata.primary_color,
                secondaryColor: effectiveMetadata.secondary_color,
                shadingType: effectiveMetadata.shading_type,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
                promptBounds: promptBounds,
                cancelBounds: cancelBounds,
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

        this.applyPromptEntryBackground(currentEntry, color);
        if (currentPrompt.cancelButton)
            this.applyCancelButtonBackground(currentPrompt.cancelButton, color);
    }
}
