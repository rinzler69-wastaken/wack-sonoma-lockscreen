import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { _log } from './gdmUtils.js';
import { getPromptBlendOverlay } from '../main/colorUtils.js';

export class GdmAvatarManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.gdmAvatarSetup = false;
        this.gdmOrigUpdateUser = null;
        this.gdmOrigMethodName = null;
        this.gdmOrigUserWellYAlign = null;
        this._lastAvatarColor = null;
        this._connectedUser = null;
    }

    setup() {
        if (this.gdmAvatarSetup) return;
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;
        this.gdmAvatarSetup = true;

        if (authPrompt._userWell) {
            this.gdmOrigUserWellYAlign = authPrompt._userWell.y_align;
            authPrompt._userWell.y_align = Clutter.ActorAlign.START;
        }

        if (!this.gdmOrigUpdateUser) {
            const methodName = authPrompt.setUser ? 'setUser' : 'updateUser';
            this.gdmOrigMethodName = methodName;
            this.gdmOrigUpdateUser = authPrompt[methodName].bind(authPrompt);
            authPrompt[methodName] = (user) => {
                this.gdmOrigUpdateUser(user);
                this.wrapGdmAvatar();
            };
            this.wrapGdmAvatar();
        }

        authPrompt.connectObject('destroy', () => this.teardown(), this);
    }

    teardown() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (authPrompt) authPrompt.disconnectObject(this);

        if (authPrompt && authPrompt._userWell && this.gdmOrigUserWellYAlign !== undefined && this.gdmOrigUserWellYAlign !== null) {
            authPrompt._userWell.y_align = this.gdmOrigUserWellYAlign;
            this.gdmOrigUserWellYAlign = null;
        }

        if (authPrompt && this.gdmOrigUpdateUser && this.gdmOrigMethodName) {
            authPrompt[this.gdmOrigMethodName] = this.gdmOrigUpdateUser;
        }
        this.gdmOrigUpdateUser = null;
        this.gdmOrigMethodName = null;

        if (this._connectedUser) {
            this._connectedUser.disconnectObject(this);
            this._connectedUser = null;
        }

        this.unwrapGdmAvatar();
        this.gdmAvatarSetup = false;
        this._lastAvatarColor = null;
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
        if (!color || this._updatingVibrancy) return;

        this._updatingVibrancy = true;
        try {
            const bgRgba = color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`;
            const buttonStyle = `background-color: ${bgRgba} !important; border-radius: 999px !important;`;
            let overlayRgba = color.overlayRgba;
            if (!overlayRgba) {
                if (color.overlayR != null && color.overlayAlpha != null) {
                    overlayRgba = `rgba(${color.overlayR}, ${color.overlayG}, ${color.overlayB}, ${color.overlayAlpha})`;
                } else {
                    const overlay = getPromptBlendOverlay({ r: color.r, g: color.g, b: color.b });
                    overlayRgba = `rgba(${overlay.overlayR}, ${overlay.overlayG}, ${overlay.overlayB}, ${overlay.blendAlpha.toFixed(4)})`;
                }
            }
            const avatarOverlayStyle = `background-color: ${overlayRgba} !important; border-radius: 999px !important;`;

            const applyToWell = (uw) => {
                if (!uw) return;
                const avatar = uw._avatar || uw._avatarButton?.get_child();
                const avatarButton = uw._avatarButton;
                if (!avatarButton) return;

                if (this._hasImageAvatar(avatar)) {
                    if (avatarButton.get_style() !== null)
                        avatarButton.set_style(null);
                } else {
                    if (avatarButton.get_style() !== buttonStyle)
                        avatarButton.set_style(buttonStyle);
                    if (avatar && avatar.get_style() !== avatarOverlayStyle)
                        avatar.set_style(avatarOverlayStyle);
                }
            };

            const authPrompt = this._gdm._dialog?._authPrompt;
            applyToWell(authPrompt?._userWell?.get_child());
            applyToWell(this._gdm._cupertinoRestPrompt?._userWell?.get_child());
        } finally {
            this._updatingVibrancy = false;
        }
    }

    wrapGdmAvatar() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) {
            _log('[WACK/GdmManager] _wrapGdmAvatar: no authPrompt');
            return;
        }

        const uw = authPrompt._userWell?.get_child();
        if (uw && uw._avatar && !uw._avatarButton) {
            const avatar = uw._avatar;
            uw.remove_child(avatar);

            uw._avatarButton = new St.Button({
                style_class: 'wack-avatar-well',
                x_expand: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
                can_focus: false,
                child: avatar,
                reactive: false,
            });
            uw.insert_child_at_index(uw._avatarButton, 0);

            if (avatar && !avatar._wackOrigUpdate) {
                avatar._wackOrigUpdate = avatar.update.bind(avatar);
                avatar.update = () => {
                    avatar._wackOrigUpdate();
                    this.updateAvatarVibrancy();
                };
            }

            const label = uw?._label;
            if (label && label.vfunc_allocate) {
                if (label._wackOrigVfuncAllocate === undefined)
                    label._wackOrigVfuncAllocate = label.vfunc_allocate;
                label.vfunc_allocate = function (box) {
                    this.set_allocation(box);
                    const availWidth = box.x2 - box.x1;
                    const availHeight = box.y2 - box.y1;
                    const childBox = new Clutter.ActorBox();
                    this._currentLabel = this._userNameLabel;
                    this.label_actor = this._currentLabel;
                    this._realNameLabel.allocate(childBox);
                    childBox.set_size(availWidth, availHeight);
                    this._userNameLabel.allocate(childBox);
                };
            }
            if (this._connectedUser) {
                this._connectedUser.disconnectObject(this);
                this._connectedUser = null;
            }
            if (avatar && avatar._user) {
                this._connectedUser = avatar._user;
                this._connectedUser.connectObject(
                    'notify::is-loaded', () => this.updateAvatarVibrancy(),
                    'changed', () => this.updateAvatarVibrancy(),
                    this
                );
            }
        }

        this.updateAvatarVibrancy();
    }

    unwrapGdmAvatar() {
        if (this._connectedUser) {
            this._connectedUser.disconnectObject(this);
            this._connectedUser = null;
        }

        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;

        const uw = authPrompt._userWell?.get_child();

        const label = uw?._label;
        if (label && label._wackOrigVfuncAllocate !== undefined) {
            label.vfunc_allocate = label._wackOrigVfuncAllocate;
            delete label._wackOrigVfuncAllocate;
        }

        if (uw && uw._avatarButton) {
            const button = uw._avatarButton;
            button.set_style(null);
            const avatar = button.get_child();
            if (avatar) {
                if (avatar._wackOrigUpdate) {
                    avatar.update = avatar._wackOrigUpdate;
                    delete avatar._wackOrigUpdate;
                }
                avatar.set_style(null);
                button.set_child(null);
                uw.remove_child(button);
                uw.insert_child_at_index(avatar, 0);
            }
            uw._avatarButton = null;
        }
    }
}

