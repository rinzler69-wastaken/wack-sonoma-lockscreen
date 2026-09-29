import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { getChromeAlpha, getHintTextStyle, getPromptDimVeilAlpha } from '../main/colorUtils.js';

export class GdmPromptStyling {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.cursorBlinkTimeoutId = 0;
        this._lastA11yColor = null;
        this._lastSessionColor = null;
        this._lastPromptColor = null;
        this._lastClockAlpha = null;
    }

    teardown() {
        this.stopCursorBlink();
        this.clearCupertinoPromptBackground();
        this.clearBottomButtonsBackground();
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

        if (actor.has_style_class_name && actor.has_style_class_name('login-dialog-prompt-entry')) {
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
        if (!entry)
            return;

        const authPrompt = this._gdm._dialog?._authPrompt;
        const isCupertino = authPrompt && authPrompt.has_style_class_name('wack-cupertino-prompt');
        if (color && !isCupertino)
            color = null;

        if (!color) {
            entry.disconnectObject(this);
            if (entry.clutter_text)
                entry.clutter_text.disconnectObject(this);
            if (global.stage)
                global.stage.disconnectObject(entry);

            if (authPrompt)
                authPrompt.disconnectObject(this);

            if (entry._wackOriginalStyle !== undefined) {
                entry.set_style(entry._wackOriginalStyle);
                delete entry._wackOriginalStyle;
            } else {
                entry.set_style(null);
            }
            delete entry._wackColor;
            delete entry._wackPreserveFocus;
            return;
        }

        entry._wackColor = color;

        if (entry._wackOriginalStyle === undefined) {
            entry._wackOriginalStyle = entry.get_style() ?? '';

            entry.connectObject(
                'notify::has-focus', () => this._updatePromptEntryStyle(entry),
                'key-focus-in', () => {
                    entry._wackPreserveFocus = false;
                    this._updatePromptEntryStyle(entry);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-focus-out', () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (entry && entry.get_stage && entry.get_stage())
                            this._updatePromptEntryStyle(entry);
                        return GLib.SOURCE_REMOVE;
                    });
                    return Clutter.EVENT_PROPAGATE;
                },
                'destroy', () => {
                    if (global.stage)
                        global.stage.disconnectObject(entry);
                },
                this
            );
            if (entry.clutter_text) {
                entry.clutter_text.connectObject(
                    'notify::has-key-focus', () => this._updatePromptEntryStyle(entry),
                    'key-focus-in', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                        return Clutter.EVENT_PROPAGATE;
                    },
                    'key-focus-out', () => {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (entry && entry.get_stage && entry.get_stage())
                                this._updatePromptEntryStyle(entry);
                            return GLib.SOURCE_REMOVE;
                        });
                        return Clutter.EVENT_PROPAGATE;
                    },
                    'activate', () => {
                        entry._wackPreserveFocus = true;
                        this._updatePromptEntryStyle(entry);
                    },
                    this
                );
            }

            if (global.stage) {
                global.stage.connectObject(
                    'notify::key-focus', () => {
                        if (!entry || !entry.get_stage || !entry.get_stage())
                            return;
                        this._updatePromptEntryStyle(entry);
                    },
                    entry
                );
            }

            const authPrompt = this._gdm._dialog?._authPrompt;
            if (authPrompt) {
                authPrompt.connectObject(
                    'reset', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    'failed', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    'cancelled', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    this
                );
            }
        }

        this._updatePromptEntryStyle(entry);
    }

    _updatePromptEntryStyle(entry) {
        if (!entry || !entry.get_stage || !entry.get_stage())
            return;

        const color = entry._wackColor;
        if (!color)
            return;

        const keyFocus = global.stage ? global.stage.key_focus : null;
        const textActor = entry.clutter_text ?? null;
        const hasDirectFocus = entry.has_focus ||
            keyFocus === entry ||
            (textActor ? (keyFocus === textActor || textActor.has_key_focus()) : false);

        const isFocused = hasDirectFocus || (entry._wackPreserveFocus === true);

        const visualState = color.visualState ?? color;
        const veilAlpha = getPromptDimVeilAlpha(visualState);

        const defaultVibrancy = this._gdm._extension ? this._gdm._extension.getSettings().get_string('prompt-vibrancy') : 'tonal';
        const vibrancyMode = color.vibrancyMode ?? defaultVibrancy;
        const isSolid = (vibrancyMode === 'tonal' || vibrancyMode === 'less');

        let shadowStyle = '';
        let bgStyle;

        if (!isSolid && color.imagePath) {
            const imageUri = color.imagePath.startsWith('file://') ? color.imagePath : `file://${color.imagePath}`;
            if (isFocused) {
                if (color.shadowAlpha !== undefined)
                    shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
            } else {
                const sAlpha = color.shadowAlpha !== undefined ? (color.shadowAlpha * (1.0 - veilAlpha)).toFixed(3) : '0';
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${sAlpha}), inset 0 0 0 999px rgba(0, 0, 0, ${veilAlpha.toFixed(3)}) !important;`;
            }
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; border: none !important;`;
        } else {
            const dimFactor = isFocused ? 1.0 : (1.0 - veilAlpha);

            if (color.shadowAlpha !== undefined) {
                const sAlpha = isFocused ? color.shadowAlpha : color.shadowAlpha * dimFactor;
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${sAlpha.toFixed(3)}) !important;`;
            }

            if (color.start && color.end && color.direction && color.direction !== 'none') {
                const sR = Math.round(color.start.r * dimFactor);
                const sG = Math.round(color.start.g * dimFactor);
                const sB = Math.round(color.start.b * dimFactor);
                const eR = Math.round(color.end.r * dimFactor);
                const eG = Math.round(color.end.g * dimFactor);
                const eB = Math.round(color.end.b * dimFactor);
                bgStyle = ` background-color: transparent !important; background-gradient-direction: ${color.direction} !important; background-gradient-start: rgb(${sR}, ${sG}, ${sB}) !important; background-gradient-end: rgb(${eR}, ${eG}, ${eB}) !important; background-image: none !important; border: none !important;`;
            } else {
                const curR = Math.round(color.r * dimFactor);
                const curG = Math.round(color.g * dimFactor);
                const curB = Math.round(color.b * dimFactor);
                bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${curR}, ${curG}, ${curB}) !important; border: none !important;`;
            }
        }

        entry.set_style(`${entry._wackOriginalStyle}${bgStyle}${shadowStyle}`);

        this._lastPromptColor = color;
        this.updatePromptMessageStyle(color);
    }

    updatePromptMessageStyle(color = null, alpha = null) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt || !authPrompt.has_style_class_name('wack-cupertino-prompt'))
            return;

        if (color)
            this._lastPromptColor = color;
        if (alpha != null)
            this._lastClockAlpha = alpha;

        const effectiveColor = color
            ?? this._lastPromptColor
            ?? this._gdm._currentWallpaperMetadata?.promptColor
            ?? this._gdm._avatarManager?._lastAvatarColor
            ?? null;

        const effectiveAlpha = alpha
            ?? this._lastClockAlpha
            ?? this._gdm._currentWallpaperMetadata?.clockAlpha
            ?? this._gdm._lastClockAlpha
            ?? null;

        if (effectiveColor || effectiveAlpha != null) {
            const msgStyle = getHintTextStyle(effectiveColor, effectiveAlpha);
            if (authPrompt._message) {
                authPrompt._message.set_style(msgStyle);
                authPrompt._message.add_style_class_name('wack-cupertino-message');
            }
            if (authPrompt._capsLockWarningLabel)
                authPrompt._capsLockWarningLabel.set_style(msgStyle);
        }
    }

    _findMenuForButton(button) {
        if (!button)
            return null;
        if (button._menu)
            return button._menu;
        if (button.menu)
            return button.menu;
        if (button._authMenuButton?._menu)
            return button._authMenuButton._menu;
        if (button._authMenuButton?.menu)
            return button._authMenuButton.menu;
        if (button._sessionMenuButton?._menu)
            return button._sessionMenuButton._menu;
        if (button._sessionMenuButton?.menu)
            return button._sessionMenuButton.menu;
        const parent = button.get_parent ? button.get_parent() : null;
        if (parent) {
            if (parent._menu)
                return parent._menu;
            if (parent.menu)
                return parent.menu;
            if (parent._authMenuButton?._menu)
                return parent._authMenuButton._menu;
            if (parent._sessionMenuButton?._menu)
                return parent._sessionMenuButton._menu;
        }
        const dialog = this._gdm?._dialog;
        if (dialog) {
            if (dialog._authMenuButton?._menu)
                return dialog._authMenuButton._menu;
            if (dialog._sessionMenuButton?._menu)
                return dialog._sessionMenuButton._menu;
            if (dialog._sessionMenuButton?.menu)
                return dialog._sessionMenuButton.menu;
        }
        return null;
    }

    _setupChromeButton(button, color, buttonType = 'generic') {
        if (!button)
            return;

        if (buttonType === 'cancel' && color) {
            const authPrompt = this._gdm._dialog?._authPrompt;
            const isCupertino = authPrompt && authPrompt.has_style_class_name('wack-cupertino-prompt');
            if (!isCupertino)
                color = null;
        }

        if (!color) {
            button.disconnectObject(this);
            const menu = this._findMenuForButton(button);
            if (menu)
                menu.disconnectObject(button);
            if (button._wackOriginalStyle !== undefined) {
                button.set_style(button._wackOriginalStyle);
                delete button._wackOriginalStyle;
            } else {
                button.set_style(null);
            }
            delete button._wackColor;
            delete button._wackMousePressed;
            delete button._wackKeyPressed;
            delete button._wackButtonType;
            delete button._wackMenuConnected;
            delete button._wackOpenedViaKey;
            return;
        }

        button._wackColor = color;
        button._wackButtonType = buttonType;

        if (button._wackOriginalStyle === undefined) {
            button._wackOriginalStyle = button.get_style() ?? '';

            button.connectObject(
                'notify::hover', () => {
                    if (!button.hover)
                        button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                'notify::has-focus', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'notify::pseudo-class', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'notify::checked', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'clicked', () => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                'button-press-event', () => {
                    button._wackMousePressed = true;
                    button._wackOpenedViaKey = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'leave-event', () => {
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-press-event', (actor, event) => {
                    const keyval = event.get_key_symbol();
                    if (keyval === Clutter.KEY_space || keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter || keyval === Clutter.KEY_ISO_Enter) {
                        button._wackKeyPressed = true;
                        button._wackOpenedViaKey = true;
                        this._updateChromeButtonStyle(button, button._wackButtonType);
                    }
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-release-event', (actor, event) => {
                    button._wackKeyPressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-focus-out', () => {
                    button._wackKeyPressed = false;
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                this
            );
        }

        const menu = this._findMenuForButton(button);
        if (menu && !button._wackMenuConnected) {
            button._wackMenuConnected = true;
            menu.connectObject(
                'open-state-changed', (m, isOpen) => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    if (!isOpen) {
                        button._wackOpenedViaKey = false;
                    }
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                button
            );
        }

        this._updateChromeButtonStyle(button, buttonType);
    }

    _updateChromeButtonStyle(button, buttonType = 'generic') {
        const color = button._wackColor;
        if (!color)
            return;

        const menu = this._findMenuForButton(button);
        if (menu && !button._wackMenuConnected) {
            button._wackMenuConnected = true;
            menu.connectObject(
                'open-state-changed', (m, isOpen) => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    if (!isOpen) {
                        button._wackOpenedViaKey = false;
                    }
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                button
            );
        }

        const isMenuOpen = menu ? menu.isOpen : false;

        const isPressed = button._wackMousePressed ||
            button._wackKeyPressed ||
            isMenuOpen ||
            button.has_style_pseudo_class('active') ||
            button.has_style_pseudo_class('checked') ||
            button.checked;
        const isHovered = button.hover && !isPressed;
        const isFocused = button.has_focus || (isMenuOpen && button._wackOpenedViaKey);

        const colorObj = buttonType === 'cancel'
            ? (color.cancelColor ?? (color.r !== undefined ? color : null))
            : buttonType === 'a11y'
                ? (color.a11yColor ?? (color.r !== undefined ? color : null))
                : buttonType === 'session'
                    ? (color.sessionColor ?? (color.r !== undefined ? color : null))
                    : color;

        if (!colorObj || colorObj.r == null || colorObj.g == null || colorObj.b == null)
            return;

        const visualState = colorObj.visualState ?? color.visualState ?? colorObj;
        const hoverAlpha = getChromeAlpha(visualState, 'hover');
        const activeAlpha = getChromeAlpha(visualState, 'active');
        const focusAlpha = getChromeAlpha(visualState, 'focus');

        let curR = colorObj.r;
        let curG = colorObj.g;
        let curB = colorObj.b;

        if (isPressed) {
            const invA = 1 - activeAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * activeAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * activeAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * activeAlpha)));
        } else if (isHovered) {
            const invA = 1 - hoverAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * hoverAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * hoverAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * hoverAlpha)));
        }

        let overlayStyle = '';
        if (isHovered) {
            overlayStyle += ` color: #ffffff !important;`;
        }
        if (isFocused) {
            overlayStyle += ` border: 1px solid rgba(255, 255, 255, 0.8) !important;`;
        }

        let shadowStyle = '';
        if (buttonType === 'cancel') {
            const rawShadow = colorObj.shadowAlpha ?? color.shadowAlpha ?? visualState.shadowAlpha;
            if (rawShadow !== undefined && rawShadow !== null && rawShadow > 0) {
                const cancelShadowAlpha = rawShadow * 0.75;
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${cancelShadowAlpha.toFixed(3)}) !important;`;
            }
        }

        const bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${curR}, ${curG}, ${curB}) !important;${overlayStyle}${shadowStyle}`;

        button.set_style(`${button._wackOriginalStyle}${bgStyle}`);
    }

    _findA11yButton() {
        const dialog = this._gdm._dialog;
        if (!dialog) return null;
        if (dialog._a11yMenuButton)
            return dialog._a11yMenuButton;
        if (dialog._bottomButtonGroup && dialog._bottomButtonGroup._a11yMenuButton)
            return dialog._bottomButtonGroup._a11yMenuButton;
        if (dialog._bottomButtonGroup && dialog._bottomButtonGroup.get_children) {
            const match = dialog._bottomButtonGroup.get_children().find(c => c.has_style_class_name && c.has_style_class_name('a11y-button'));
            if (match) return match;
        }
        return null;
    }

    _findSessionButton() {
        const dialog = this._gdm._dialog;
        if (!dialog) return null;
        if (dialog._authMenuButton)
            return dialog._authMenuButton;
        if (dialog._sessionMenuButton) {
            if (dialog._sessionMenuButton._button)
                return dialog._sessionMenuButton._button;
            if (dialog._sessionMenuButton.get_child)
                return dialog._sessionMenuButton.get_child();
            return dialog._sessionMenuButton;
        }
        if (dialog._bottomButtonGroup) {
            if (dialog._bottomButtonGroup._authMenuButton)
                return dialog._bottomButtonGroup._authMenuButton;
            if (dialog._bottomButtonGroup._sessionMenuButton) {
                if (dialog._bottomButtonGroup._sessionMenuButton._button)
                    return dialog._bottomButtonGroup._sessionMenuButton._button;
                return dialog._bottomButtonGroup._sessionMenuButton;
            }
            if (dialog._bottomButtonGroup.get_children) {
                const match = dialog._bottomButtonGroup.get_children().find(c => c.has_style_class_name && (c.has_style_class_name('login-dialog-auth-menu-button') || c.has_style_class_name('login-dialog-session-list-button')));
                if (match) return match;
            }
        }
        return null;
    }

    applyCancelButtonBackground(button, color) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        const isCupertino = authPrompt && authPrompt.has_style_class_name('wack-cupertino-prompt');
        this._setupChromeButton(button, isCupertino ? color : null, 'cancel');
    }

    applyA11yButtonBackground(button, color) {
        this._setupChromeButton(button, color, 'a11y');
    }

    applySessionButtonBackground(button, color) {
        this._setupChromeButton(button, color, 'session');
    }

    applyTheme(theme) {
        if (!theme)
            return;

        const authPrompt = this._gdm._dialog ? this._gdm._dialog._authPrompt : null;
        const entry = authPrompt ? this.findPromptEntry(authPrompt) : null;
        const cancelButton = authPrompt ? (authPrompt.cancelButton || authPrompt._cancelButton) : null;
        const a11yButton = this._findA11yButton();
        const sessionButton = this._findSessionButton();

        const isSlideMismatch = theme.slide !== null && (
            !theme.meta?.resolved_slide_path ||
            (theme.slide.filePath !== theme.meta.resolved_slide_path &&
             !theme.meta.resolved_slide_path.endsWith(theme.slide.filePath) &&
             !theme.slide.filePath.endsWith(theme.meta.resolved_slide_path))
        );

        const promptColor = theme.palette ? theme.palette.value : (
            (!isSlideMismatch && theme.meta?.promptColor) ? theme.meta.promptColor : null
        );

        if (promptColor) {
            this._lastPromptColor = promptColor;
            this._lastA11yColor = promptColor.a11yColor ?? null;
            this._lastSessionColor = promptColor.sessionColor ?? null;
        } else {
            this._lastPromptColor = null;
            this._lastA11yColor = null;
            this._lastSessionColor = null;
        }

        const a11yColorToApply = (promptColor && promptColor.a11yColor) ? promptColor.a11yColor : this._lastA11yColor;
        const sessionColorToApply = (promptColor && promptColor.sessionColor) ? promptColor.sessionColor : this._lastSessionColor;

        const isCupertinoPrompt = authPrompt && authPrompt.has_style_class_name('wack-cupertino-prompt');

        if (entry) {
            this.applyPromptEntryBackground(entry, isCupertinoPrompt ? promptColor : null);
        }
        if (cancelButton) {
            this.applyCancelButtonBackground(cancelButton, isCupertinoPrompt ? promptColor : null);
        }

        const avatarColor = (promptColor && promptColor.avatarColor) ? promptColor.avatarColor : (promptColor && promptColor.r != null ? {
            r: promptColor.r,
            g: promptColor.g,
            b: promptColor.b,
            rgba: promptColor.rgba || `rgba(${promptColor.r}, ${promptColor.g}, ${promptColor.b}, 1.0)`,
        } : null);

        if (this._gdm._avatarManager) {
            this._gdm._avatarManager.updateAvatarVibrancy(avatarColor);
        }
        if (a11yButton) {
            this.applyA11yButtonBackground(a11yButton, a11yColorToApply);
        }
        if (sessionButton) {
            this.applySessionButtonBackground(sessionButton, sessionColorToApply);
        }

        if (theme.clockAlpha != null) {
            this.updatePromptMessageStyle(null, theme.clockAlpha);
        }
    }

    clearCupertinoPromptBackground() {
        const authPrompt = this._gdm._dialog ? this._gdm._dialog._authPrompt : null;
        const entry = this.findPromptEntry(authPrompt);
        if (entry)
            this.applyPromptEntryBackground(entry, null);

        const cancelButton = authPrompt ? (authPrompt.cancelButton || authPrompt._cancelButton) : null;
        if (cancelButton)
            this.applyCancelButtonBackground(cancelButton, null);

        if (authPrompt && authPrompt._message)
            authPrompt._message.set_style(null);
        if (authPrompt && authPrompt._capsLockWarningLabel)
            authPrompt._capsLockWarningLabel.set_style(null);
    }

    clearBottomButtonsBackground() {
        const a11yButton = this._findA11yButton();
        if (a11yButton)
            this.applyA11yButtonBackground(a11yButton, null);

        const sessionButton = this._findSessionButton();
        if (sessionButton)
            this.applySessionButtonBackground(sessionButton, null);
    }
}
