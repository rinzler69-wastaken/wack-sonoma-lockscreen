import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { GDM_USER_STACK_VERTICAL_FRACTION } from '../main/constants.js';

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
        const [, , natW, natH] = box.get_preferred_size();
        box.translation_x = Math.floor(w / 2 - natW / 2) - (box.x || 0);
        box.translation_y = Math.floor(h * GDM_USER_STACK_VERTICAL_FRACTION - natH / 2) - (box.y || 0);
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
        if (!userList || userList._items.size === 0) return;

        let maxW = 0;
        for (const item of userList._items.values()) {
            const w = this.getItemTightWidth(item);
            if (w > maxW) maxW = w;
        }

        for (const item of userList._items.values()) {
            item.x_expand = false;
            item.set_width(maxW);
        }
    }

    setupUserListWidths(dialog = null) {
        const targetDialog = dialog || this._gdm._dialog;
        const userList = targetDialog?._userList;
        if (!userList) return;

        this.applyUserListWidths(targetDialog);

        this.userListItemAddedId = userList.connect('item-added', () => {
            this.applyUserListWidths(targetDialog);
        });
    }

    teardownUserListWidths(dialog = null) {
        const targetDialog = dialog || this._gdm._dialog;
        const userList = targetDialog?._userList;
        if (this.userListItemAddedId && userList) {
            userList.disconnect(this.userListItemAddedId);
            this.userListItemAddedId = null;
        }
        if (userList) {
            for (const item of userList._items.values()) {
                item.x_expand = true;
                item.set_width(-1);
            }
        }
    }
}
