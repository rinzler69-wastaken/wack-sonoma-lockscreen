import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { buildComboRow, getGdmStatus } from '../prefsUtils.js';

function buildSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function buildAppearanceGroup(extensionPreferences, settings, _) {
    const group = new Adw.PreferencesGroup({
        title: _('Clock and Status'),
    });

    const clockWeightRow = buildComboRow(settings, 'clock-weight',
        _('Clock Weight'),
        _('Font weight of the lockscreen time.'),
        [
            ['light', 'Light'],
            ['regular', 'Regular'],
            ['medium', 'Medium'],
            ['semibold', 'Semibold'],
            ['bold', 'Bold'],
            ['heavy', 'Heavy'],
        ],
        _);
    const resetClockWeightButton = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: _('Restore defaults'),
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    resetClockWeightButton.connect('clicked', () => settings.reset('clock-weight'));
    clockWeightRow.add_suffix(resetClockWeightButton);

    const syncClockWeightReset = () => {
        resetClockWeightButton.sensitive = settings.get_user_value('clock-weight') !== null;
    };
    syncClockWeightReset();
    const clockWeightSignal = settings.connect('changed::clock-weight', syncClockWeightReset);
    clockWeightRow.connect('destroy', () => settings.disconnect(clockWeightSignal));
    group.add(clockWeightRow);

    group.add(buildComboRow(settings, 'clock-format',
        _('Clock Format'),
        _('Override the system 12/24-hour setting on the lockscreen.'),
        [
            ['system', 'System'],
            ['12h', '12-hour'],
            ['24h', '24-hour'],
        ],
        _));

    group.add(buildSwitchRow(settings, 'clock-tint',
        _('Wallpaper-Tinted Clock'),
        _('Tint the clock and date with a light shade of the wallpaper colour.')));

    group.add(buildSwitchRow(settings, 'password-indicators',
        _('Password Field Indicators'),
        _('Show Caps Lock and keyboard layout icons inside the password field.')));

    group.add(buildSwitchRow(settings, 'status-corner',
        _('Sonoma Status Corner'),
        _('Restyle the top-right battery, network and input source icons. Cupertino mode only.')));

    // Only meaningful on the login screen, so only offered once the GDM DLC is in place.
    if (getGdmStatus(extensionPreferences.dir).enabled && settings.settings_schema.has_key('cupertino-system-actions')) {
        group.add(buildSwitchRow(settings, 'cupertino-system-actions',
            _('Cupertino System Actions'),
            _('Show Suspend, Restart and Power Off under the login user list, replacing the Quick Settings power menu.')));
    }

    return group;
}
