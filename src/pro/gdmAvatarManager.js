import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { _log, userListItems } from './gdmUtils.js';
import { getUserLabelStyle } from '../main/colorUtils.js';

export class GdmAvatarManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.gdmAvatarSetup = false;
        this.gdmOrigUpdateUser = null;
        this.gdmOrigMethodName = null;
        this.gdmOrigUserWellYAlign = null;
        this._lastAvatarColor = null;
        this._connectedUser = null;
        this._dialog = null;
    }

    setup(dialog = null) {
        if (this.gdmAvatarSetup) return;
        this._dialog = dialog || this._gdm._dialog;
        const authPrompt = this._dialog?._authPrompt;
        this.gdmAvatarSetup = true;

        if (authPrompt) {
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

        const userList = this._dialog?._userList;
        if (userList) {
            userList.connectObject(
                'item-added', (_ul, item) => this._setupUserListItem(item),
                this
            );
            for (const item of userListItems(userList))
                this._setupUserListItem(item);
        }
    }

    teardown() {
        const authPrompt = this._dialog?._authPrompt || this._gdm._dialog?._authPrompt;
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

        // Disconnect from userList and clear any vibrancy styles and update wrappers
        const userList = this._dialog?._userList || this._gdm._dialog?._userList;
        if (userList) {
            userList.disconnectObject(this);
            for (const item of userListItems(userList)) {
                const avatar = item._userWidget?._avatar;
                const user = avatar?._user || item._userWidget?._user;
                if (user)
                    user.disconnectObject(this);
                if (avatar) {
                    if (avatar._wackOrigUpdate) {
                        avatar.update = avatar._wackOrigUpdate;
                        delete avatar._wackOrigUpdate;
                    }
                    delete avatar._wackUpdating;
                    delete avatar._wackSettingStyle;
                    if (avatar._wackHasVibrancy) {
                        avatar.set_style(null);
                    }
                    delete avatar._wackHasVibrancy;
                }
            }
        }

        this.gdmAvatarSetup = false;
        this._lastAvatarColor = null;
        this._dialog = null;
    }

    _setupUserListItem(item) {
        const avatar = item?._userWidget?._avatar;
        if (!avatar) return;

        if (!avatar._wackOrigUpdate) {
            avatar._wackOrigUpdate = avatar.update.bind(avatar);
            avatar.update = () => {
                if (avatar._wackSettingStyle || avatar._wackUpdating)
                    return;
                avatar._wackUpdating = true;
                avatar._wackOrigUpdate();
                avatar._wackUpdating = false;

                this._applyStyleToUserListItemAvatar(avatar);
            };

            const user = avatar._user || item?._userWidget?._user;
            if (user && !user.is_loaded) {
                user.connectObject(
                    'notify::is-loaded', () => this._applyStyleToUserListItemAvatar(avatar),
                    'changed', () => this._applyStyleToUserListItemAvatar(avatar),
                    this
                );
            }
        }

        const label = item?._userWidget?._label;
        if (label) {
            label.set_style(this._lastAvatarColor ? getUserLabelStyle(this._lastAvatarColor) : null);
        }

        this._applyStyleToUserListItemAvatar(avatar);
    }

    _applyStyleToUserListItemAvatar(avatar) {
        if (!avatar || avatar._wackSettingStyle) return;

        // Never touch picture avatars! GNOME Shell sets their photo via background-image on avatar.style.
        if (this._hasImageAvatar(avatar)) {
            delete avatar._wackHasVibrancy;
            return;
        }

        // If user info is still loading via AccountsService, wait until it's loaded before styling
        // so we don't prematurely style an account whose photo hasn't been read yet.
        const user = avatar._user;
        if (user && !user.is_loaded)
            return;

        const color = this._lastAvatarColor;
        const bgRgba = color ? (color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`) : null;
        const buttonStyle = bgRgba ? `background-color: ${bgRgba} !important; border-radius: 999px !important;` : null;

        if (avatar.get_style() !== buttonStyle) {
            avatar._wackSettingStyle = true;
            avatar.set_style(buttonStyle);
            avatar._wackSettingStyle = false;
            if (buttonStyle)
                avatar._wackHasVibrancy = true;
            else
                delete avatar._wackHasVibrancy;
        }
        avatar.clip_to_allocation = true;
        const child = avatar.get_child();
        if (child) {
            const iconStyle = buttonStyle ? 'background-color: transparent !important; border-radius: 999px !important;' : null;
            if (child.get_style() !== iconStyle)
                child.set_style(iconStyle);
        }
    }

    _hasImageAvatar(avatar) {
        if (!avatar) return false;
        if (avatar.has_style_class_name?.('user-avatar')) return true;
        const style = avatar.get_style?.() || '';
        if (style.includes('background-image')) return true;
        const user = avatar._user;
        if (user) {
            const iconFile = user.get_icon_file?.();
            if (iconFile && GLib.file_test(iconFile, GLib.FileTest.EXISTS))
                return true;
        }
        return false;
    }

    updateAvatarVibrancy(avatarColor) {
        if (avatarColor !== undefined)
            this._lastAvatarColor = avatarColor;
        if (this._updatingVibrancy) return;

        const color = this._lastAvatarColor;
        this._updatingVibrancy = true;
        const bgRgba = color ? (color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`) : null;
        const buttonStyle = bgRgba ? `background-color: ${bgRgba} !important; border-radius: 999px !important;` : null;

        const applyToWell = (uw) => {
            if (!uw) return;
            const avatar = uw._avatar || uw._avatarButton?.get_child();
            const avatarButton = uw._avatarButton;
            if (!avatarButton) return;

            if (this._hasImageAvatar(avatar)) {
                if (avatarButton.get_style() !== null)
                    avatarButton.set_style(null);
                // Never clear or overwrite avatar.style for picture avatars!
                delete avatar._wackHasVibrancy;
            } else {
                if (avatarButton.get_style() !== buttonStyle)
                    avatarButton.set_style(buttonStyle);
                // Apply to the avatar widget directly for placeholder/symbolic avatars
                if (avatar) {
                    if (avatar.get_style() !== buttonStyle) {
                        avatar._wackSettingStyle = true;
                        avatar.set_style(buttonStyle);
                        avatar._wackSettingStyle = false;
                        if (buttonStyle)
                            avatar._wackHasVibrancy = true;
                        else
                            delete avatar._wackHasVibrancy;
                    }
                    avatar.clip_to_allocation = true;
                    const child = avatar.get_child();
                    if (child) {
                        const iconStyle = buttonStyle ? 'background-color: transparent !important; border-radius: 999px !important;' : null;
                        if (child.get_style() !== iconStyle)
                            child.set_style(iconStyle);
                    }
                }
                if (avatarButton)
                    avatarButton.clip_to_allocation = true;
            }
        };

        const authPrompt = this._dialog?._authPrompt || this._gdm._dialog?._authPrompt;
        const authPromptWell = authPrompt?._userWell?.get_child();
        applyToWell(authPromptWell);
        if (authPromptWell?._label) {
            authPromptWell._label.set_style(color ? getUserLabelStyle(color) : null);
        }

        if (this._gdm._cupertinoRestPrompt?.updateVisuals) {
            this._gdm._cupertinoRestPrompt.updateVisuals(color);
        } else {
            applyToWell(this._gdm._cupertinoRestPrompt?._userWell?.get_child());
        }

        // Also apply to empty-avatar tiles in the user selection list.
        this.updateUserListVibrancy();
        this._updatingVibrancy = false;
    }

    updateUserListVibrancy() {
        const userList = this._dialog?._userList || this._gdm._dialog?._userList;
        for (const item of userListItems(userList))
            this._setupUserListItem(item);
    }


    wrapGdmAvatar() {
        const authPrompt = this._dialog?._authPrompt || this._gdm._dialog?._authPrompt;
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
                    if (avatar._wackSettingStyle || avatar._wackUpdating)
                        return;
                    avatar._wackUpdating = true;
                    avatar._wackOrigUpdate();
                    avatar._wackUpdating = false;

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

        const authPrompt = this._dialog?._authPrompt || this._gdm._dialog?._authPrompt;
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
                delete avatar._wackUpdating;
                delete avatar._wackSettingStyle;
                if (avatar._wackHasVibrancy) {
                    avatar.set_style(null);
                }
                delete avatar._wackHasVibrancy;
                button.set_child(null);
                uw.remove_child(button);
                uw.insert_child_at_index(avatar, 0);
            }
            uw._avatarButton = null;
        }
    }
}

