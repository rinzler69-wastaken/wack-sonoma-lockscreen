import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import Gettext from 'gettext';

// Reuse gnome-shell's translated action names.
const shellDomain = Gettext.domain('gnome-shell');
const actionName = name => shellDomain.pgettext('search-result', name);

// Gap between the bottom of the user list and the buttons.
const CSA_TOP_GAP = 36;

/**
 * Reports no width to its parent and lays its child out centred. Inside the
 * user list this keeps the buttons from widening the list, so the list stays
 * horizontally dead centre, while the buttons still follow the list's
 * visibility, fades and movement. The real height is reported so the list
 * still makes room for the buttons above the bottom of the screen.
 */
const OverflowBin = GObject.registerClass(
class WackCsaOverflowBin extends St.Bin {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        const [, height] = this.get_child()?.get_preferred_height(-1) ?? [0, 0];
        return [CSA_TOP_GAP + height, CSA_TOP_GAP + height];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.get_child();
        if (!child)
            return;
        const [, width] = child.get_preferred_width(-1);
        const [, height] = child.get_preferred_height(width);
        const x = Math.floor((box.get_width() - width) / 2);
        child.allocate(new Clutter.ActorBox({ x1: x, y1: CSA_TOP_GAP, x2: x + width, y2: CSA_TOP_GAP + height }));
    }
});

/**
 * Cupertino System Actions (CSA): macOS-style Suspend / Restart / Power Off
 * buttons under the GDM user list. Each button follows SystemActions, which
 * already honours logind availability and org.gnome.login-screen
 * disable-restart-buttons. While enabled, the Quick Settings power menu is
 * hidden since CSA replaces it.
 */
export class GdmPowerButtons {
    constructor() {
        this.actor = null;
        this._shutdownItem = null;
    }

    setup(dialog) {
        const userSelectionBox = dialog?._userSelectionBox;
        if (!userSelectionBox || this.actor)
            return;

        const actions = SystemActions.getDefault();
        const row = new St.BoxLayout({ style_class: 'wack-gdm-power-buttons' });

        const buttons = [
            ['can-suspend', 'media-playback-pause-symbolic', actionName('Suspend'), () => actions.activateSuspend()],
            ['can-restart', 'system-reboot-symbolic', actionName('Restart'), () => actions.activateRestart()],
            ['can-power-off', 'system-shutdown-symbolic', actionName('Power Off'), () => actions.activatePowerOff()],
        ];
        for (const [property, iconName, label, activate] of buttons) {
            const content = new St.BoxLayout({ vertical: true });
            content.add_child(new St.Icon({ icon_name: iconName, style_class: 'wack-gdm-power-icon', x_align: Clutter.ActorAlign.CENTER }));
            content.add_child(new St.Label({ text: label, style_class: 'wack-gdm-power-label', x_align: Clutter.ActorAlign.CENTER }));
            const button = new St.Button({
                style_class: 'wack-gdm-power-button',
                can_focus: true,
                accessible_name: label,
                child: content,
            });
            button.connect('clicked', activate);
            actions.bind_property(property, button, 'visible', GObject.BindingFlags.SYNC_CREATE);
            row.add_child(button);
        }

        this.actor = new OverflowBin({ child: row });
        userSelectionBox.add_child(this.actor);
    }

    /**
     * Toggle CSA (per-user setting from the cross-session manifest).
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        if (!this.actor)
            return;
        this.actor.visible = enabled;
        this._setQuickSettingsPowerMenuHidden(enabled);
    }

    // GNOME re-syncs the item's visibility through this._sync whenever an
    // action's availability changes; shadow it so it stays hidden.
    // ponytail: Quick Settings loads its indicators asynchronously; if it is
    // not ready yet, the next setEnabled() (every user/theme change) retries.
    _setQuickSettingsPowerMenuHidden(hidden) {
        if (hidden && !this._shutdownItem) {
            const systemItem = Main.panel.statusArea.quickSettings?._system?._systemItem;
            const item = systemItem?.child?.get_children().find(c => c.menu && c.menu === systemItem.menu);
            if (!item?._sync)
                return;
            this._shutdownItem = item;
            item._sync = () => (item.visible = false);
            item._sync();
        } else if (!hidden && this._shutdownItem) {
            delete this._shutdownItem._sync;
            this._shutdownItem._sync();
            this._shutdownItem = null;
        }
    }

    teardown() {
        this._setQuickSettingsPowerMenuHidden(false);
        this.actor?.destroy();
        this.actor = null;
    }
}
