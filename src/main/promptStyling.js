import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { _log, _logError } from './mainUtils.js';

export class PromptStyling {
    constructor(extension) {
        this._extension = extension;
        this.cursorBlinkTimeoutId = null;
        this.lastWellH = undefined;
        this.lastYCenterFraction = undefined;
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

    startCursorBlink() {
        this.stopCursorBlink();

        const dialog = this._extension._dialog;
        if (!dialog) return;

        const authPrompt = dialog._authPrompt ?? dialog._promptBox?._authPrompt;
        const entry = this.findPromptEntry(authPrompt);
        if (entry && entry.clutter_text) {
            entry.clutter_text.cursor_blink = (this._extension._cursorBlink !== false);
            entry.clutter_text.cursor_visible = true;
        }

        if (this._extension._cursorBlink === false)
            return;

        let visible = true;
        this.cursorBlinkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const currentDialog = this._extension._dialog;
            if (!currentDialog || !this._extension._promptActive) {
                this.cursorBlinkTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }

            const currentAuthPrompt = currentDialog._authPrompt ?? currentDialog._promptBox?._authPrompt;
            if (!currentAuthPrompt) {
                return GLib.SOURCE_CONTINUE;
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
            this.cursorBlinkTimeoutId = null;
        }
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
        const isHovered = button.hover && !button._wackPressed;
        const isPressed = button._wackPressed;

        if (isPressed && color.cancelActiveImagePath) {
            imgPath = color.cancelActiveImagePath;
        } else if (isHovered && color.cancelHoverImagePath) {
            imgPath = color.cancelHoverImagePath;
        }
        if (!imgPath && color.imagePath) {
            imgPath = color.imagePath;
        }

        if (imgPath) {
            const imageUri = imgPath.startsWith('file://')
                ? imgPath
                : `file://${imgPath}`;
            let overlayStyle = '';
            if (isPressed && !color.cancelActiveImagePath) {
                overlayStyle = ' filter: brightness(1.25);';
            } else if (isHovered && !color.cancelHoverImagePath) {
                overlayStyle = ' filter: brightness(1.12);';
            }
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;${overlayStyle}`;
        } else {
            let r = color.r;
            let g = color.g;
            let b = color.b;

            if (isPressed) {
                r = Math.round(r * 0.75 + 255 * 0.25);
                g = Math.round(g * 0.75 + 255 * 0.25);
                b = Math.round(b * 0.75 + 255 * 0.25);
            } else if (isHovered) {
                r = Math.round(r * 0.875 + 255 * 0.125);
                g = Math.round(g * 0.875 + 255 * 0.125);
                b = Math.round(b * 0.875 + 255 * 0.125);
            }
            bgStyle = ` background-color: rgb(${r}, ${g}, ${b}) !important;`;
        }

        button.set_style(`${button._wackOriginalStyle}${bgStyle}${shadowStyle}`);
    }

    applyA11yButtonBackground(button, color) {
        if (!button || !color)
            return;

        button._wackColor = color;

        if (button._wackOriginalStyle === undefined) {
            button._wackOriginalStyle = button.get_style() ?? '';

            button.connectObject(
                'notify::hover', () => this.updateA11yButtonStyle(button),
                'button-press-event', () => {
                    button._wackPressed = true;
                    this.updateA11yButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackPressed = false;
                    this.updateA11yButtonStyle(button);
                    return Clutter.EVENT_PROPAGATE;
                },
                this
            );

            if (button.menu) {
                button.menu.connectObject(
                    'open-state-changed', () => this.updateA11yButtonStyle(button),
                    this
                );
            }
        }

        this.updateA11yButtonStyle(button);
    }

    updateA11yButtonStyle(button) {
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
        let imgPath = color.a11yImagePath;
        const isHovered = button.hover && !button._wackPressed;
        const isPressed = button._wackPressed || button.has_style_pseudo_class?.('active') || (button.menu && button.menu.isOpen);

        if (isPressed && color.a11yActiveImagePath) {
            imgPath = color.a11yActiveImagePath;
        } else if (isHovered && color.a11yHoverImagePath) {
            imgPath = color.a11yHoverImagePath;
        }
        if (!imgPath && color.imagePath) {
            imgPath = color.imagePath;
        }

        if (imgPath) {
            const imageUri = imgPath.startsWith('file://')
                ? imgPath
                : `file://${imgPath}`;
            let overlayStyle = '';
            if (isPressed && !color.a11yActiveImagePath) {
                overlayStyle = ' filter: brightness(1.25);';
            } else if (isHovered && !color.a11yHoverImagePath) {
                overlayStyle = ' filter: brightness(1.12);';
            }
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important;${overlayStyle}`;
        } else {
            let r = color.r;
            let g = color.g;
            let b = color.b;

            if (isPressed) {
                r = Math.round(r * 0.75 + 255 * 0.25);
                g = Math.round(g * 0.75 + 255 * 0.25);
                b = Math.round(b * 0.75 + 255 * 0.25);
            } else if (isHovered) {
                r = Math.round(r * 0.875 + 255 * 0.125);
                g = Math.round(g * 0.875 + 255 * 0.125);
                b = Math.round(b * 0.875 + 255 * 0.125);
            }
            bgStyle = ` background-color: rgb(${r}, ${g}, ${b}) !important;`;
        }

        button.set_style(`${button._wackOriginalStyle}${bgStyle}${shadowStyle}`);
    }

    clearCupertinoPromptBackground() {
        const dialog = this._extension._dialog;
        const authPrompt = dialog?._authPrompt ?? dialog?._promptBox?._authPrompt;
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

        const a11yButton = dialog?._a11yMenuButton ?? dialog?._bottomButtonGroup?._a11yMenuButton;
        if (a11yButton) {
            a11yButton.disconnectObject(this);
            if (a11yButton.menu)
                a11yButton.menu.disconnectObject(this);
            if (a11yButton._wackOriginalStyle !== undefined) {
                a11yButton.set_style(a11yButton._wackOriginalStyle);
                delete a11yButton._wackOriginalStyle;
            } else {
                a11yButton.set_style(null);
            }
            delete a11yButton._wackColor;
            delete a11yButton._wackPressed;
        }
    }

    onAuthPromptAllocation() {
        _log(`[WACK/Extension] onAuthPromptAllocation() called. promptActive=${this._extension._promptActive}`);
        if (!this._extension._promptActor || !this._extension._promptActor.has_style_class_name('wack-cupertino-prompt'))
            return;

        let wellH = 0;
        const restPrompt = this._extension._cupertinoPromptManager?.restPrompt ?? this._extension._cupertinoRestPrompt;
        if (restPrompt?._userWell) {
            const [, , , hSize] = restPrompt._userWell.get_preferred_size();
            wellH = hSize > 0 ? hSize : 0;
        }

        let yCenterFraction = null;
        let promptBounds = null;
        const dialog = this._extension._dialog;
        const authPrompt = dialog?._authPrompt ?? dialog?._promptBox?._authPrompt;
        const entry = this.findPromptEntry(authPrompt) ?? restPrompt?._hintBox;
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

        const wellChanged = wellH !== this.lastWellH;
        const yCenterChanged = yCenterFraction !== null &&
            (this.lastYCenterFraction === undefined || Math.abs(yCenterFraction - this.lastYCenterFraction) > 0.001);
        const boundsChanged = promptBounds && (!this.lastPromptBounds ||
            Math.abs(promptBounds.x1 - this.lastPromptBounds.x1) > 0.002 ||
            Math.abs(promptBounds.x2 - this.lastPromptBounds.x2) > 0.002 ||
            Math.abs(promptBounds.y1 - this.lastPromptBounds.y1) > 0.002);

        if (wellChanged || yCenterChanged || boundsChanged) {
            if (wellChanged) this.lastWellH = wellH;
            if (yCenterChanged) this.lastYCenterFraction = yCenterFraction;
            if (boundsChanged) this.lastPromptBounds = promptBounds;
            this._extension._updateClockAlphaAndPromptColor?.().catch(e => {
                _logError('[WACK/Extension] Failed to update prompt background in allocation: ' + e);
            });
        }
    }

    teardown() {
        this.stopCursorBlink();
        this.clearCupertinoPromptBackground();
    }
}
