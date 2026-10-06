import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import Gettext from 'gettext';

// Reuse gnome-shell's translated action names.
const shellDomain = Gettext.domain('gnome-shell');
const actionName = name => shellDomain.pgettext('search-result', name);

/**
 * macOS-style Sleep / Restart / Shut Down buttons under the GDM user list.
 * Visibility follows SystemActions, which already honours logind availability
 * and org.gnome.login-screen disable-restart-buttons.
 */
export class GdmPowerButtons {
    constructor() {
        this.actor = null;
    }

    setup(dialog) {
        const userSelectionBox = dialog?._userSelectionBox;
        if (!userSelectionBox || this.actor)
            return;

        const actions = SystemActions.getDefault();
        this.actor = new St.BoxLayout({
            style_class: 'wack-gdm-power-buttons',
            x_align: Clutter.ActorAlign.CENTER,
        });

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
            this.actor.add_child(button);
        }

        userSelectionBox.add_child(this.actor);
    }

    teardown() {
        this.actor?.destroy();
        this.actor = null;
    }
}
