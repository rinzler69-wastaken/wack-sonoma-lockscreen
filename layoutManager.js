import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { CUPERTINO_PROMPT_VERTICAL_FRACTION } from './constants.js';

/**
 * WackLayout is a custom layout manager for the screen shield's main box.
 * It ensures that the clock and notifications are positioned correctly,
 * especially when the unlock prompt is visible.
 */
export const WackLayout = GObject.registerClass(
    class WackLayout extends Clutter.LayoutManager {
        _init(extension, stack, notifications, switchUserButton) {
            super._init();
            this._extension = extension;
            this._stack = stack;
            this._notifications = notifications;
            this._switchUserButton = switchUserButton;
        }

        /**
         * Standard Clutter layout delegation for width requests.
         */
        vfunc_get_preferred_width(_container, forHeight) {
            return this._stack.get_preferred_width(forHeight);
        }

        /**
         * Standard Clutter layout delegation for height requests.
         */
        vfunc_get_preferred_height(_container, forWidth) {
            return this._stack.get_preferred_height(forWidth);
        }

        /**
         * Orchestrates the spatial arrangement of the lock screen UI elements.
         * This is called by Clutter whenever the main box needs to be laid out.
         */
        vfunc_allocate(_container, box) {
            const [width, height] = box.get_size();
            const tenthOfHeight = height / 10.0;

            const [, , stackWidth, stackHeight] = this._stack.get_preferred_size();
            const [, , notificationsWidth, notificationsHeight] = this._notifications.get_preferred_size();

            const columnWidth = Math.max(stackWidth, notificationsWidth);
            const columnX1 = Math.floor((width - columnWidth) / 2.0);
            const actorBox = new Clutter.ActorBox();

            // Calculate maximum allowed height for notifications to prevent overlap
            const maxNotificationsHeight = Math.min(
                notificationsHeight,
                height - tenthOfHeight - stackHeight);
            actorBox.x1 = columnX1;
            actorBox.y1 = height - maxNotificationsHeight;
            actorBox.x2 = columnX1 + columnWidth;
            actorBox.y2 = actorBox.y1 + maxNotificationsHeight;
            this._notifications.allocate(actorBox);

            // Position the stack (which contains the auth prompt)
            let stackY;
            if (this._extension._lockscreenMode === 'cupertino') {
                // Anchor the full rest widget bottom at CUPERTINO_PROMPT_VERTICAL_FRACTION.
                // We use the rest prompt container's preferred height (avatar spacing + name
                // + hint) as the anchor. This value is stable across rest↔prompt transitions
                // because the container stays in the actor tree regardless of visibility, so
                // get_preferred_size() always returns the rest-state height even when the
                // container is hidden during the prompt. The logical coordinate system
                // already scales proportionally with display scale, so no fraction adjustment
                // is needed — the visual fraction stays consistent at any DPI setting.
                const restContainer = this._extension._cupertinoRestPromptContainer;
                const [, , , restH] = restContainer
                    ? restContainer.get_preferred_size()
                    : [0, 0, 0, stackHeight];
                const anchorH = restH > 0 ? restH : stackHeight;
                stackY = Math.floor(height * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
            } else {
                stackY = Math.min(
                    Math.floor(height / 3.0),
                    height - stackHeight - maxNotificationsHeight);
            }

            actorBox.x1 = columnX1;
            actorBox.y1 = stackY;
            actorBox.x2 = columnX1 + columnWidth;
            actorBox.y2 = stackY + stackHeight;
            this._stack.allocate(actorBox);

            // Position the "Switch User" button if it's visible
            if (this._switchUserButton.visible) {
                const [, , natWidth, natHeight] = this._switchUserButton.get_preferred_size();
                const textDirection = this._switchUserButton.get_text_direction();
                if (textDirection === Clutter.TextDirection.RTL)
                    actorBox.x1 = box.x1 + natWidth;
                else
                    actorBox.x1 = box.x2 - (natWidth * 2);
                actorBox.y1 = box.y2 - (natHeight * 2);
                actorBox.x2 = actorBox.x1 + natWidth;
                actorBox.y2 = actorBox.y1 + natHeight;
                this._switchUserButton.allocate(actorBox);
            }
        }
    });
