import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';
import { getPromptBlendOverlay } from './colorUtils.js';

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
            this._lastAvatarColor = null;

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

            this._user = null;
            this.connectObject('destroy', () => {
                if (this._user) {
                    this._user.disconnectObject(this);
                    this._user = null;
                }
                const avatar = this._avatarButton?.get_child();
                if (avatar && avatar._wackOrigUpdate) {
                    avatar.update = avatar._wackOrigUpdate;
                    delete avatar._wackOrigUpdate;
                }
            }, this);

            this.setUser(user);
        }

        setUser(user) {
            if (this._user) {
                this._user.disconnectObject(this);
                this._user = null;
            }
            this._user = user;
            if (this._user) {
                this._user.connectObject(
                    'notify::is-loaded', () => this.updateAvatarVibrancy(),
                    'changed', () => this.updateAvatarVibrancy(),
                    this
                );
            }

            const oldChild = this._userWell.get_child();
            if (oldChild) {
                if (this._avatarButton) {
                    const oldAvatar = this._avatarButton.get_child();
                    if (oldAvatar && oldAvatar._wackOrigUpdate) {
                        oldAvatar.update = oldAvatar._wackOrigUpdate;
                        delete oldAvatar._wackOrigUpdate;
                    }
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

                if (!avatar._wackOrigUpdate) {
                    avatar._wackOrigUpdate = avatar.update.bind(avatar);
                    avatar.update = () => {
                        avatar._wackOrigUpdate();
                        this.updateAvatarVibrancy();
                    };
                }

                this._avatarButton.connectObject('clicked', () => {
                    if (this._extension && this._extension._promptActive) {
                        this._extension.triggerSwitchUser();
                    }
                }, this);
            }

            this._userWell.set_child(userWidget);
            this.updateAvatarVibrancy();
        }

        _hasImageAvatar(avatar) {
            if (!avatar || !avatar._user) return false;
            const user = avatar._user;
            if (typeof user.get_icon_file === 'function') {
                const iconFile = user.get_icon_file();
                if (iconFile && typeof iconFile === 'string' && iconFile !== '' && Gio.File.new_for_path(iconFile).query_exists(null))
                    return true;
            }
            return false;
        }

        updateAvatarVibrancy(avatarColor) {
            if (avatarColor)
                this._lastAvatarColor = avatarColor;
            const color = this._lastAvatarColor;
            if (!color || !this._avatarButton || this._updatingVibrancy) return;

            this._updatingVibrancy = true;
            try {
                const avatar = this._avatarButton.get_child();
                if (this._hasImageAvatar(avatar)) {
                    if (this._avatarButton.get_style() !== null)
                        this._avatarButton.set_style(null);
                    this._avatarButton.remove_style_class_name('wack-vibrancied');
                } else {
                    this._avatarButton.add_style_class_name('wack-vibrancied');
                    const bgRgba = color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`;
                    const btnStyle = `background-color: ${bgRgba} !important; border-radius: 999px !important;`;
                    if (this._avatarButton.get_style() !== btnStyle)
                        this._avatarButton.set_style(btnStyle);
                    let overlayRgba = color.overlayRgba;
                    if (!overlayRgba) {
                        if (color.overlayR != null && color.overlayAlpha != null) {
                            overlayRgba = `rgba(${color.overlayR}, ${color.overlayG}, ${color.overlayB}, ${color.overlayAlpha})`;
                        } else {
                            const overlay = getPromptBlendOverlay({ r: color.r, g: color.g, b: color.b });
                            overlayRgba = `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`;
                        }
                    }
                    const avOverlayStyle = `background-color: ${overlayRgba} !important; border-radius: 999px !important;`;
                    if (avatar && avatar.get_style() !== avOverlayStyle)
                        avatar.set_style(avOverlayStyle);
                }
            } finally {
                this._updatingVibrancy = false;
            }
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
