import Clutter from 'gi://Clutter';
import St from 'gi://St';

// St.BoxLayout has `vertical` through GNOME 50 and `orientation` from 50; 51 dropped `vertical`.
export const VERTICAL_BOX = St.BoxLayout.find_property('orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

export function _log(msg) {
    console.debug(msg);
}

export function _logError(msg) {
    console.error(msg);
}

export function _setActorVisible(actor, visible, opacity) {
    if (!actor || actor._isDestroyed)
        return;

    actor.visible = visible;
    actor.opacity = opacity;
}

export const PowerProfilesIface = `<node>
<interface name="net.hadess.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
</interface>
</node>`;
