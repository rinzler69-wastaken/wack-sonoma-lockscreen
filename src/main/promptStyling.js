import GLib from 'gi://GLib';
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

        entry.set_style(`${entry._wackOriginalStyle} background-color: rgb(${color.r}, ${color.g}, ${color.b}) !important;${shadowStyle}`);
    }

    clearCupertinoPromptBackground() {
        const dialog = this._extension._dialog;
        const authPrompt = dialog?._authPrompt ?? dialog?._promptBox?._authPrompt;
        const entry = this.findPromptEntry(authPrompt);
        if (!entry)
            return;

        if (entry._wackOriginalStyle !== undefined) {
            entry.set_style(entry._wackOriginalStyle);
            delete entry._wackOriginalStyle;
        } else {
            entry.set_style(null);
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
        const dialog = this._extension._dialog;
        const authPrompt = dialog?._authPrompt ?? dialog?._promptBox?._authPrompt;
        const entry = this.findPromptEntry(authPrompt);
        if (entry) {
            const pos = entry.get_transformed_position();
            const yTrans = pos[1];
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            if (yTrans > 0 && monitorHeight > 0) {
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            }
        }

        const wellChanged = wellH !== this.lastWellH;
        const yCenterChanged = yCenterFraction !== null &&
            (this.lastYCenterFraction === undefined || Math.abs(yCenterFraction - this.lastYCenterFraction) > 0.001);

        if (wellChanged || yCenterChanged) {
            if (wellChanged) this.lastWellH = wellH;
            if (yCenterChanged) this.lastYCenterFraction = yCenterFraction;
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
