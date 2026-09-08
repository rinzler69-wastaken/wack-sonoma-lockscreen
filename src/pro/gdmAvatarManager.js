import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { _log } from './gdmUtils.js';

export class GdmAvatarManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.gdmAvatarSetup = false;
        this.gdmOrigUpdateUser = null;
        this.gdmOrigMethodName = null;
        this.gdmOrigUserWellYAlign = null;
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

        this.unwrapGdmAvatar();
        this.gdmAvatarSetup = false;
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
        }
    }

    unwrapGdmAvatar() {
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
            const avatar = button.get_child();
            if (avatar) {
                button.set_child(null);
                uw.remove_child(button);
                uw.insert_child_at_index(avatar, 0);
            }
            uw._avatarButton = null;
        }
    }
}
