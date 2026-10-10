import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as UserWidget from 'resource:///org/gnome/shell/ui/userWidget.js';
import { VERTICAL_BOX } from './mainUtils.js';
import { getPromptBlendOverlay, getUserLabelStyle, getHintTextStyle } from './colorUtils.js';

export const WackCupertinoRestPrompt = GObject.registerClass(
    class WackCupertinoRestPrompt extends St.BoxLayout {
        _init(user, extension) {
            super._init({
                style_class: 'login-dialog-prompt-layout',
                ...VERTICAL_BOX,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });

            this._extension = extension;
            this._avatarButton = null;
            this._currentText = '';
            this._currentCount = 0;
            this._lastAvatarColor = null;
            this._lastVisualState = null;
            this._lastClockAlpha = null;

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

            this._isDestroyed = false;
            this._user = null;
            this.connectObject('destroy', () => {
                this._isDestroyed = true;
                if (this._user) {
                    this._user.disconnectObject(this);
                    this._user = null;
                }
                if (this._avatarButton) {
                    const avatar = this._avatarButton.get_child();
                    if (avatar && avatar._wackOrigUpdate) {
                        avatar.update = avatar._wackOrigUpdate;
                        delete avatar._wackOrigUpdate;
                    }
                    this._avatarButton.disconnectObject(this);
                    this._avatarButton = null;
                }
                this._hintBox = null;
                this._hintBoxWrapper = null;
                this._hintLabel = null;
                this._userWell = null;
            }, this);

            this.setUser(user);
        }

        setUser(user) {
            if (this._isDestroyed) return;
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

            const oldChild = this._userWell?.get_child();
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
                        if (!this._isDestroyed)
                            this.updateAvatarVibrancy();
                    };
                }

                this._avatarButton.connectObject('clicked', () => {
                    if (this._extension && this._extension._promptActive) {
                        this._extension.triggerSwitchUser();
                    }
                }, this);
            }

            this._userWell?.set_child(userWidget);
            this._applyUserLabelStyle();
            this._applyHintLabelStyle();
            this.updateAvatarVibrancy();
        }

        _applyUserLabelStyle() {
            if (this._isDestroyed) return;
            const userWidget = this._userWell?.get_child();
            const label = userWidget?._label;
            if (!label) return;
            if (this._lastVisualState || this._lastClockAlpha != null) {
                label.set_style(getUserLabelStyle(this._lastVisualState ?? this._lastClockAlpha));
            }
        }

        _applyHintLabelStyle() {
            if (this._isDestroyed || !this._hintLabel) return;
            if (this._lastVisualState || this._lastClockAlpha != null) {
                this._hintLabel.set_style(getHintTextStyle(this._lastVisualState, this._lastClockAlpha));
            }
        }

        updateVisuals(promptColor, alpha = null) {
            if (this._isDestroyed) return;
            if (promptColor)
                this._lastVisualState = promptColor;
            if (alpha != null)
                this._lastClockAlpha = alpha;

            this._applyUserLabelStyle();
            this._applyHintLabelStyle();

            const avColor = promptColor?.avatarColor ?? promptColor;
            if (avColor)
                this.updateAvatarVibrancy(avColor);
        }

        _hasImageAvatar(avatar) {
            if (!avatar || !avatar._user) return false;
            const iconFile = avatar._user.get_icon_file();
            return Boolean(iconFile && GLib.file_test(iconFile, GLib.FileTest.EXISTS));
        }

        updateAvatarVibrancy(avatarColor) {
            if (this._isDestroyed) return;
            if (avatarColor)
                this._lastAvatarColor = avatarColor;
            const color = this._lastAvatarColor;
            if (!color || !this._avatarButton || this._updatingVibrancy) return;

            this._updatingVibrancy = true;
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
                if (avatar)
                    avatar.clip_to_allocation = true;
                if (this._avatarButton)
                    this._avatarButton.clip_to_allocation = true;
                const child = avatar?.get_child();
                if (child) {
                    const iconStyle = 'background-color: transparent !important; border-radius: 999px !important;';
                    if (child.get_style() !== iconStyle)
                        child.set_style(iconStyle);
                }
            }
            this._updatingVibrancy = false;
        }



        setHintText(text) {
            if (this._isDestroyed) return;
            this._currentText = text ?? '';
            this._updateHintLabel();
        }

        setNotifCount(count) {
            if (this._isDestroyed) return;
            this._currentCount = count ?? 0;
            this._updateHintLabel();
        }

        setHint(text, count = 0) {
            if (this._isDestroyed) return;
            this._currentText = text ?? '';
            this._currentCount = count ?? 0;
            this._updateHintLabel();
        }

        _updateHintLabel() {
            if (this._isDestroyed || !this._hintLabel) return;

            // Invalidate StLabel's cached shadow pipeline (st_label_set_text clears text_shadow_pipeline)
            this._hintLabel.text = '';

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
                this._hintLabel.clutter_text.use_markup = false;
                this._hintLabel.text = this._currentText;
            }
        }
    });

