import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    GDM_USER_STACK_VERTICAL_FRACTION_WITH_CSA,
    GDM_USER_STACK_VERTICAL_FRACTION_NO_CSA,
    GDM_USER_LIST_CAP_WITH_CSA,
    GDM_USER_LIST_CAP_NO_CSA,
    userListItems,
} from './gdmUtils.js';

export class GdmUserListManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.userListItemAddedId = null;
    }

    setup(dialog) {
        this.setupUserListWidths(dialog);
    }

    teardown(dialog) {
        this.teardownUserListWidths(dialog);
    }

    positionUserList(dialogBox = null) {
        const dialog = this._gdm._dialog;
        if (!dialog?._userSelectionBox) return;
        const box = dialog._userSelectionBox;
        const alloc = dialogBox || dialog.get_allocation_box();
        let w = alloc.x2 - alloc.x1;
        let h = alloc.y2 - alloc.y1;
        if ((w <= 0 || h <= 0) && Main?.layoutManager?.primaryMonitor) {
            if (w <= 0) w = Main.layoutManager.primaryMonitor.width;
            if (h <= 0) h = Main.layoutManager.primaryMonitor.height;
        }
        const hasCsa = Boolean(this._gdm._powerButtons?.actor?.visible);
        const fraction = hasCsa
            ? GDM_USER_STACK_VERTICAL_FRACTION_WITH_CSA
            : GDM_USER_STACK_VERTICAL_FRACTION_NO_CSA;
        const [, , natW, natH] = box.get_preferred_size();
        box.translation_x = Math.floor(w / 2 - natW / 2) - (box.x || 0);
        box.translation_y = Math.floor(h * fraction - natH) - (box.y || 0);
    }

    getItemTightWidth(item) {
        const userWidget = item._userWidget;
        if (!userWidget) return item.get_preferred_width(-1)[1];

        const avatar = userWidget._avatar;
        const labelWidget = userWidget._label;
        if (!avatar || !labelWidget) return item.get_preferred_width(-1)[1];

        const [, avatarNatW] = avatar.get_preferred_width(-1);
        const visibleLabel = labelWidget._realNameLabel ?? labelWidget._userNameLabel;
        const [, labelNatW] = visibleLabel ? visibleLabel.get_preferred_width(-1) : [0, 0];

        const spacing = userWidget.get_theme_node().get_length('spacing');

        const itemNode = item.get_theme_node();
        const padLeft = itemNode.get_padding(St.Side.LEFT);
        const padRight = itemNode.get_padding(St.Side.RIGHT);

        return Math.ceil(padLeft + avatarNatW + spacing + labelNatW + padRight);
    }

    applyUserListWidths(dialog = null) {
        const targetDialog = dialog || this._gdm._dialog;
        const userList = targetDialog?._userList;
        if (!userList || userListItems(userList).length === 0) return;

        let maxW = 0;
        for (const item of userListItems(userList)) {
            const w = this.getItemTightWidth(item);
            if (w > maxW) maxW = w;
        }

        for (const item of userListItems(userList)) {
            item.x_expand = false;
            item.set_width(maxW);
        }

        const hasCsa = Boolean(this._gdm._powerButtons?.actor?.visible);
        const cap = hasCsa ? GDM_USER_LIST_CAP_WITH_CSA : GDM_USER_LIST_CAP_NO_CSA;

        const items = userListItems(userList);
        if (items.length > cap) {
            let capHeight = 0;
            for (let i = 0; i < cap; i++) {
                const [, h] = items[i].get_preferred_height(-1);
                capHeight += h;
            }
            userList.set_height(capHeight);
        } else {
            userList.set_height(-1);
        }
    }

    setupUserListWidths(dialog = null) {
        const targetDialog = dialog || this._gdm._dialog;
        const userList = targetDialog?._userList;
        if (!userList) return;

        userList.vscrollbar_policy = St.PolicyType.NEVER;
        userList.hscrollbar_policy = St.PolicyType.NEVER;
        userList.enable_mouse_scrolling = true;

        this.applyUserListWidths(targetDialog);

        this.userListItemAddedId = userList.connect('item-added', () => {
            this.applyUserListWidths(targetDialog);
        });
    }

    teardownUserListWidths(dialog = null) {
        const targetDialog = dialog || this._gdm._dialog;
        const userList = targetDialog?._userList;
        if (this.userListItemAddedId) {
            if (userList)
                userList.disconnect(this.userListItemAddedId);
            this.userListItemAddedId = null;
        }
        if (userList) {
            userList.set_height(-1);
            userList.vscrollbar_policy = St.PolicyType.AUTOMATIC;
            userList.hscrollbar_policy = St.PolicyType.AUTOMATIC;
            for (const item of userListItems(userList)) {
                item.x_expand = true;
                item.set_width(-1);
            }
        }
    }
}
