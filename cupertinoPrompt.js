import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';

export const WackCupertinoRestPrompt = GObject.registerClass(
    class WackCupertinoRestPrompt extends St.BoxLayout {
        _init(user, extension) {
            super._init({
                style_class: 'login-dialog-prompt-layout',
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });

            this._extension = extension;
            this._avatarButton = null;
            this._currentText = '';
            this._currentCount = 0;

            this._userWell = new St.Bin({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
                reactive: false,
            });
            this.add_child(this._userWell);

            // Inline hint box
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

            // Prevent layout shift by ensuring consistent line metrics
            this._hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._hintLabel.clutter_text.line_wrap = true;
            this._hintBox.add_child(this._hintLabel);

            this._hintBoxWrapper = new St.Bin({
                x_expand: true,
                opacity: 255,
                child: this._hintBox,
            });
            this.add_child(this._hintBoxWrapper);

            this.setUser(user);
        }

        setUser(user) {
            const oldChild = this._userWell.get_child();
            if (oldChild) {
                if (this._avatarButton) {
                    this._avatarButton.disconnectObject(this);
                    this._avatarButton = null;
                }
                oldChild.destroy();
            }

            const userWidget = new UserWidget.UserWidget(user, Clutter.Orientation.VERTICAL);
            const avatar = userWidget._avatar;

            if (avatar) {
                userWidget.remove_child(avatar);
                this._avatarButton = new St.Button({
                    style_class: 'wack-avatar-well',
                    x_expand: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.START,
                    can_focus: false,
                    child: avatar,
                    reactive: !!(this._extension && this._extension._promptActive),
                });
                userWidget.insert_child_at_index(this._avatarButton, 0);

                this._avatarButton.connectObject('clicked', () => {
                    if (this._extension && this._extension._promptActive) {
                        this._extension.triggerSwitchUser();
                    }
                }, this);
            }

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
                    `${this._currentCount} <span size="8625">🔔\uFE0E</span>  ·  ${safeText}`
                );
            } else {
                this._hintLabel.clutter_text.use_markup = true;
                this._hintLabel.clutter_text.set_markup(this._currentText);
            }
        }
    });
