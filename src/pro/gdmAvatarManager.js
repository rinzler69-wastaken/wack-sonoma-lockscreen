import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { _log, _logError, userListItems } from './gdmUtils.js';
import { getUserLabelStyle } from '../main/colorUtils.js';
import { AvatarType } from './gdmAuthState.js';

export { AvatarType };

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
        this._activeSessionUsers = null;
    }

    _classifyAvatar(avatar) {
        if (!avatar || avatar._isDestroyed)
            return null;
        if (this._hasImageAvatar(avatar))
            return AvatarType.IMAGE;
        const user = avatar._user;
        if (user && !user.is_loaded)
            return AvatarType.PENDING;
        return AvatarType.SYMBOLIC;
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

            authPrompt.connectObject('destroy', () => this.teardown(true), this);
        }

        const userList = this._dialog?._userList || this._gdm._dialog?._userList;
        if (userList) {
            userList.connectObject(
                'item-added', (_ul, item) => this._setupUserListItem(item),
                this
            );
            for (const item of userListItems(userList))
                this._setupUserListItem(item);
        }
    }

    teardown(dialogDestroyed = false) {
        const authPrompt = this._dialog?._authPrompt || this._gdm._dialog?._authPrompt;
        if (authPrompt) authPrompt.disconnectObject(this);

        if (!dialogDestroyed) {
            if (authPrompt && authPrompt._userWell && this.gdmOrigUserWellYAlign !== undefined && this.gdmOrigUserWellYAlign !== null) {
                authPrompt._userWell.y_align = this.gdmOrigUserWellYAlign;
            }

            if (authPrompt && this.gdmOrigUpdateUser && this.gdmOrigMethodName) {
                authPrompt[this.gdmOrigMethodName] = this.gdmOrigUpdateUser;
            }
        }
        this.gdmOrigUserWellYAlign = null;
        this.gdmOrigUpdateUser = null;
        this.gdmOrigMethodName = null;

        if (this._connectedUser) {
            this._connectedUser.disconnectObject(this);
            this._connectedUser = null;
        }

        if (!dialogDestroyed)
            this.unwrapGdmAvatar();

        // Disconnect from userList and clear any vibrancy styles and update wrappers
        const userList = this._dialog?._userList || this._gdm._dialog?._userList;
        if (userList) {
            userList.disconnectObject(this);
            for (const item of userListItems(userList))
                this._teardownUserListItem(item, dialogDestroyed);
        }

        this.gdmAvatarSetup = false;
        this._lastAvatarColor = null;
        this._dialog = null;
        this._activeSessionUsers = null;
    }

    _teardownUserListItem(item, dialogDestroyed = false) {
        if (!item) return;
        const userWidget = item._userWidget;
        const avatar = userWidget?._avatar;
        const user = item.user || avatar?._user || userWidget?._user;

        if (user)
            user.disconnectObject(this);

        if (dialogDestroyed) return;

        if (userWidget && userWidget._wackAvatarContainer) {
            const container = userWidget._wackAvatarContainer;
            if (avatar && container.contains(avatar)) {
                container.remove_child(avatar);
                userWidget.remove_child(container);
                userWidget.insert_child_at_index(avatar, 0);
            }
            container.destroy();
            delete userWidget._wackAvatarContainer;
            delete userWidget._wackSessionBadge;
            delete userWidget._wackSessionBadgeConnected;
            delete userWidget._wackUpdateBadge;
        }

        if (avatar) {
            avatar.disconnectObject(this);
            if (!avatar._isDestroyed) {
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

    _getActiveSessionUsers() {
        if (this._activeSessionUsers !== null)
            return this._activeSessionUsers;

        this._activeSessionUsers = new Set();
        try {
            const res = Gio.DBus.system.call_sync(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'ListSessions',
                null, null, Gio.DBusCallFlags.NONE, -1, null
            );
            const [sessions] = res.deepUnpack();
            for (const [, uid, userName, seat] of sessions) {
                if (seat && uid >= 1000)
                    this._activeSessionUsers.add(userName);
            }
        } catch (e) {
            _logError(`[WACK/GdmAvatar] Failed to query active sessions: ${e}`);
        }

        return this._activeSessionUsers;
    }

    _setupUserListItem(item) {
        const userWidget = item?._userWidget;
        const avatar = userWidget?._avatar;
        if (!avatar || !userWidget) return;

        const user = item.user || avatar._user || userWidget._user;

        if (!userWidget._wackAvatarContainer) {
            const container = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: false,
                y_expand: false,
                reactive: false,
            });
            userWidget.remove_child(avatar);
            container.add_child(avatar);

            const badge = new St.Bin({
                style_class: 'wack-gdm-session-badge',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
                translation_x: 1,
                translation_y: 1,
                reactive: false,
                can_focus: false,
            });
            const syncBadgeOffset = () => {
                const node = badge.get_theme_node();
                const ox = node.get_length('offset-x') || node.get_length('translation-x');
                const oy = node.get_length('offset-y') || node.get_length('translation-y');
                if (ox !== 0) badge.translation_x = ox;
                if (oy !== 0) badge.translation_y = oy;
            };
            badge.connect('style-changed', syncBadgeOffset);
            const checkIcon = new St.DrawingArea({
                style_class: 'wack-gdm-session-badge-icon',
                width: 9,
                height: 9,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });
            const syncIconSize = () => {
                const node = checkIcon.get_theme_node();
                const iconSize = node.get_length('icon-size');
                if (iconSize > 0)
                    checkIcon.set_size(iconSize, iconSize);
            };
            checkIcon.connect('style-changed', syncIconSize);
            checkIcon.connect('repaint', (area) => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                if (w <= 0 || h <= 0) {
                    cr.$dispose();
                    return;
                }
                const node = area.get_theme_node();
                const fgColor = node.get_foreground_color();
                if (fgColor) {
                    cr.setSourceRGBA(
                        fgColor.red / 255,
                        fgColor.green / 255,
                        fgColor.blue / 255,
                        fgColor.alpha / 255
                    );
                } else {
                    cr.setSourceRGB(1, 1, 1);
                }
                const scale = Math.max(0.2, w / 10);
                cr.setLineWidth(Math.max(1.0, 1.8 * scale));
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(w * 0.22, h * 0.52);
                cr.lineTo(w * 0.44, h * 0.76);
                cr.lineTo(w * 0.82, h * 0.28);
                cr.stroke();
                cr.$dispose();
            });
            badge.set_child(checkIcon);
            container.add_child(badge);

            userWidget.insert_child_at_index(container, 0);
            userWidget._wackAvatarContainer = container;
            userWidget._wackSessionBadge = badge;
        }

        const badge = userWidget._wackSessionBadge;
        const itemUserName = user ? user.get_user_name() : null;
        const updateBadge = () => {
            if (badge && !badge._isDestroyed) {
                const activeUsers = this._getActiveSessionUsers();
                if (activeUsers.size === 0) {
                    badge.visible = false;
                    return;
                }
                const defaultUser = this._gdm._wallpaperManager?.themeStore?.defaultUser;
                badge.visible = Boolean(defaultUser && itemUserName === defaultUser && activeUsers.has(itemUserName));
            }
        };
        userWidget._wackUpdateBadge = updateBadge;

        if (user && !userWidget._wackSessionBadgeConnected) {
            userWidget._wackSessionBadgeConnected = true;
            user.connectObject(
                'notify::is-loaded', updateBadge,
                'changed', updateBadge,
                this
            );
        }
        updateBadge();

        if (!avatar._wackOrigUpdate) {
            avatar._wackOrigUpdate = avatar.update.bind(avatar);
            avatar.update = () => {
                if (avatar._isDestroyed || avatar._wackSettingStyle || avatar._wackUpdating)
                    return;
                avatar._wackUpdating = true;
                try {
                    avatar._wackOrigUpdate();
                } finally {
                    avatar._wackUpdating = false;
                }

                this._applyStyleToUserListItemAvatar(avatar);
            };

            avatar.connectObject('destroy', () => {
                avatar._isDestroyed = true;
                this._teardownUserListItem(item);
            }, this);

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
        if (!avatar || avatar._isDestroyed || avatar._wackSettingStyle) return;

        const classification = this._classifyAvatar(avatar);
        if (classification === AvatarType.IMAGE) {
            delete avatar._wackHasVibrancy;
            return;
        }

        if (classification === AvatarType.PENDING)
            return;

        const color = this._lastAvatarColor;
        const bgRgba = color ? (color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`) : null;
        const buttonStyle = bgRgba ? `background-color: ${bgRgba} !important; border-radius: 999px !important;` : null;

        if (avatar.get_style() !== buttonStyle) {
            avatar._wackSettingStyle = true;
            try {
                avatar.set_style(buttonStyle);
            } finally {
                avatar._wackSettingStyle = false;
            }
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

        this._updatingVibrancy = true;
        try {
            const color = this._lastAvatarColor;
            const bgRgba = color ? (color.rgba || `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`) : null;
            const buttonStyle = bgRgba ? `background-color: ${bgRgba} !important; border-radius: 999px !important;` : null;

            const applyToWell = (uw) => {
                if (!uw) return;
                const avatar = uw._avatar || uw._avatarButton?.get_child();
                const avatarButton = uw._avatarButton;
                if (!avatarButton) return;

                const classification = this._classifyAvatar(avatar);
                if (classification === AvatarType.IMAGE) {
                    if (avatarButton.get_style() !== null)
                        avatarButton.set_style(null);
                    // Never clear or overwrite avatar.style for picture avatars!
                    delete avatar._wackHasVibrancy;
                } else if (classification === AvatarType.SYMBOLIC) {
                    if (avatarButton.get_style() !== buttonStyle)
                        avatarButton.set_style(buttonStyle);
                    // Apply to the avatar widget directly for placeholder/symbolic avatars
                    if (avatar) {
                        if (avatar.get_style() !== buttonStyle) {
                            avatar._wackSettingStyle = true;
                            try {
                                avatar.set_style(buttonStyle);
                            } finally {
                                avatar._wackSettingStyle = false;
                            }
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
        } finally {
            this._updatingVibrancy = false;
        }
    }

    updateUserListVibrancy() {
        this._activeSessionUsers = null;
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
                    try {
                        avatar._wackOrigUpdate();
                    } finally {
                        avatar._wackUpdating = false;
                    }

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

