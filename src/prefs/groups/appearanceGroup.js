import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// Combo row bound to a string key; `options` is [[value, label], ...].
function buildStringComboRow(settings, key, title, subtitle, options, settingsSignalIds) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        const index = options.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settingsSignalIds.push(settings.connect(`changed::${key}`, sync));
    return row;
}

function buildSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function buildAppearanceGroup(settings, _, settingsSignalIds) {
    const group = new Adw.PreferencesGroup({
        title: _('Clock and Status'),
    });

    group.add(buildStringComboRow(settings, 'clock-weight',
        _('Clock Weight'),
        _('Font weight of the lockscreen time.'),
        [
            ['light', _('Light')],
            ['regular', _('Regular')],
            ['medium', _('Medium')],
            ['semibold', _('Semibold')],
            ['bold', _('Bold')],
            ['heavy', _('Heavy')],
        ],
        settingsSignalIds));

    group.add(buildStringComboRow(settings, 'clock-format',
        _('Clock Format'),
        _('Override the system 12/24-hour setting on the lockscreen.'),
        [
            ['system', _('System')],
            ['12h', _('12-hour')],
            ['24h', _('24-hour')],
        ],
        settingsSignalIds));

    group.add(buildSwitchRow(settings, 'clock-tint',
        _('Wallpaper-Tinted Clock'),
        _('Tint the clock and date with a light shade of the wallpaper colour.')));

    group.add(buildSwitchRow(settings, 'password-indicators',
        _('Password Field Indicators'),
        _('Show Caps Lock and keyboard layout icons inside the password field.')));

    group.add(buildSwitchRow(settings, 'status-corner',
        _('Sonoma Status Corner'),
        _('Restyle the top-right battery, network and input source icons. Cupertino mode only.')));

    return group;
}
