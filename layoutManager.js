import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { CUPERTINO_PROMPT_VERTICAL_FRACTION } from './constants.js';

// Extracted magic numbers for clarity and easy tweaking
const NOTIF_MIN_TOP_MARGIN_FRACTION = 0.1; // Was: height / 10.0
const SWITCH_USER_MARGIN = 24; // Logical pixels for switch user button spacing

export const WackLayout = GObject.registerClass(
class WackLayout extends Clutter.LayoutManager {
    _init(extension, stack, notifications, switchUserButton) {
        super._init();
        this._extension = extension;
        this._stack = stack;
        this._notifications = notifications;
        this._switchUserButton = switchUserButton;
    }

    vfunc_get_preferred_width(_container, forHeight) {
        return this._stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(_container, forWidth) {
        return this._stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        const [width, height] = box.get_size();
        
        // 1. Get natural sizes safely
        const [, , stackWidth, stackHeight] = this._stack.get_preferred_size();
        const [, , notifWidth, notifHeight] = this._notifications.get_preferred_size();

        // 2. Allocate Notifications (independent width, prevents auth prompt stretching)
        const notifBox = new Clutter.ActorBox();
        const maxNotifHeight = Math.min(notifHeight, height - (height * NOTIF_MIN_TOP_MARGIN_FRACTION) - stackHeight);
        
        notifBox.x1 = Math.floor((width - notifWidth) / 2.0);
        notifBox.y1 = height - maxNotifHeight;
        notifBox.x2 = notifBox.x1 + notifWidth;
        notifBox.y2 = notifBox.y1 + maxNotifHeight;
        this._notifications.allocate(notifBox);

        // 3. Allocate Stack (Auth Prompt)
        const stackBox = new Clutter.ActorBox();
        let stackY;

        if (this._extension._lockscreenMode === 'cupertino') {
            // FAIL-SAFE DUMMY MEASUREMENT: 
            // Prefer allocated height (cheap & safe). Fallback to preferred_size. 
            // Ultimate fallback to stackHeight to prevent NaN/0 layout jumps.
            const restPrompt = this._extension._cupertinoRestPrompt;
            const userWell = restPrompt?._userWell;
            
            let wellH = userWell?.get_height() ?? 0;
            if (wellH === 0) {
                const [, , , preferredH] = userWell ? userWell.get_preferred_size() : [0, 0, 0, 0];
                wellH = preferredH > 0 ? preferredH : stackHeight;
            }

            const anchorH = Math.floor(wellH * 1.3);
            stackY = Math.floor(height * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
        } else {
            stackY = Math.min(
                Math.floor(height / 3.0),
                height - stackHeight - maxNotifHeight
            );
        }

        stackBox.x1 = Math.floor((width - stackWidth) / 2.0);
        stackBox.y1 = stackY;
        stackBox.x2 = stackBox.x1 + stackWidth;
        stackBox.y2 = stackY + stackHeight;
        this._stack.allocate(stackBox);

        // 4. Allocate Switch User Button (if visible and exists)
        if (this._switchUserButton?.visible) {
            const [, , natWidth, natHeight] = this._switchUserButton.get_preferred_size();
            const switchBox = new Clutter.ActorBox();
            const isRTL = this._switchUserButton.get_text_direction() === Clutter.TextDirection.RTL;

            switchBox.x1 = isRTL ? box.x1 + SWITCH_USER_MARGIN : box.x2 - natWidth - SWITCH_USER_MARGIN;
            switchBox.y1 = box.y2 - natHeight - SWITCH_USER_MARGIN;
            switchBox.x2 = switchBox.x1 + natWidth;
            switchBox.y2 = switchBox.y1 + natHeight;
            
            this._switchUserButton.allocate(switchBox);
        }
    }
});
