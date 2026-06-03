import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';

export const WackCupertinoRestPrompt = GObject.registerClass(
    class WackCupertinoRestPrompt extends St.BoxLayout {
        _init(user) {
            super._init({
                style_class: 'login-dialog-prompt-layout',
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });

            this._userWell = new St.Bin({
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            this.add_child(this._userWell);

            // Inline hint box — anchored to the user widget stack.
            // Contains notification count/icon (if always-show-user hides them) and the unlock hint.
            this._hintBox = new St.BoxLayout({
                style_class: 'wack-cupertino-hint',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                opacity: 255,
            });

            this._hintLabel = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._currentText = '';
            this._hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._hintLabel.clutter_text.line_wrap = true;

            this._hintBox.add_child(this._hintLabel);

            this._hintBoxWrapper = new St.Bin({
                x_expand: true,
                opacity: 255,
            });
            this._hintBoxWrapper.set_child(this._hintBox);
            this.add_child(this._hintBoxWrapper);

            this._currentText = '';
            this._currentCount = 0;

            this.setUser(user);
        }

        setUser(user) {
            let oldChild = this._userWell.get_child();
            if (oldChild)
                oldChild.destroy();
            let userWidget = new UserWidget.UserWidget(user, Clutter.Orientation.VERTICAL);
            this._userWell.set_child(userWidget);
        }

        setHintText(text) {
            this._currentText = text ?? '';
            this._updateHintLabel();
        }

        setNotifCount(count) {
            this._currentCount = count ?? 0;
            this._updateHintLabel();
        }

        _updateHintLabel() {
            if (!this._hintLabel) return;

            // Escape the text to prevent markup injection errors
            const safeText = GLib.markup_escape_text(this._currentText, -1);

            // Always use the same markup structure so Pango's line metrics are
            // constant whether or not the bell emoji is present. Without this,
            // switching between "N 🔔 · hint" and plain hint nudges the widget
            // by ~2 px because the emoji has taller ascent/descent metrics.
            if (this._currentCount > 0) {
                this._hintLabel.clutter_text.use_markup = true;
                this._hintLabel.clutter_text.set_markup(
                    `${this._currentCount} <span size="smaller">🔔\uFE0E</span>  ·  ${safeText}`);
            } else {
                this._hintLabel.clutter_text.use_markup = false;
                this._hintLabel.text = this._currentText;
            }
        }
    });
