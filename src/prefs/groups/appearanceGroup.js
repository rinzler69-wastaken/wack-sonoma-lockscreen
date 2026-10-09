import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { buildComboRow } from '../prefsUtils.js';

function buildSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function buildAppearanceGroup(settings, _, settingsSignalIds) {
    const group = new Adw.PreferencesGroup({
        title: _('Clock and Date'),
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

    const dateStyleRow = new Adw.ActionRow({
        title: _('Date Style'),
        subtitle: _('Choose between shortened and full date names.'),
    });

    const dateStyleBox = new Gtk.Box({ valign: Gtk.Align.CENTER });

    // Linked buttons (wide layout)
    const dateStyleLinkedBox = new Gtk.Box({ css_classes: ['linked'] });
    const btnDateShort = new Gtk.ToggleButton({ label: _('Short') });
    const btnDateFull = new Gtk.ToggleButton({ label: _('Full'), group: btnDateShort });
    dateStyleLinkedBox.append(btnDateShort);
    dateStyleLinkedBox.append(btnDateFull);

    // Dropdown fallback (narrow layout)
    const dateStyleDropdown = new Gtk.DropDown({
        valign: Gtk.Align.CENTER,
        model: Gtk.StringList.new([_('Short'), _('Full')]),
    });

    dateStyleBox.append(dateStyleLinkedBox);
    dateStyleBox.append(dateStyleDropdown);
    dateStyleRow.add_suffix(dateStyleBox);

    let selfChangeDateStyle = false;

    const syncDateStyleButtons = () => {
        const v = settings.get_string('date-style') || 'full';
        selfChangeDateStyle = true;
        btnDateShort.active = (v === 'short');
        btnDateFull.active = (v !== 'short');
        dateStyleDropdown.selected = (v === 'short') ? 0 : 1;
        selfChangeDateStyle = false;
    };
    syncDateStyleButtons();

    btnDateShort.connect('toggled', () => {
        if (selfChangeDateStyle || !btnDateShort.active) return;
        selfChangeDateStyle = true;
        settings.set_string('date-style', 'short');
        dateStyleDropdown.selected = 0;
        selfChangeDateStyle = false;
    });
    btnDateFull.connect('toggled', () => {
        if (selfChangeDateStyle || !btnDateFull.active) return;
        selfChangeDateStyle = true;
        settings.set_string('date-style', 'full');
        dateStyleDropdown.selected = 1;
        selfChangeDateStyle = false;
    });
    dateStyleDropdown.connect('notify::selected', () => {
        if (selfChangeDateStyle) return;
        selfChangeDateStyle = true;
        const val = dateStyleDropdown.selected === 0 ? 'short' : 'full';
        settings.set_string('date-style', val);
        btnDateShort.active = (val === 'short');
        btnDateFull.active = (val !== 'short');
        selfChangeDateStyle = false;
    });
    settingsSignalIds.push(settings.connect('changed::date-style', () => {
        if (!selfChangeDateStyle) syncDateStyleButtons();
    }));

    dateStyleDropdown.visible = false;
    dateStyleLinkedBox.visible = true;

    group.add(dateStyleRow);

    group.add(buildSwitchRow(settings, 'clock-tint',
        _('Wallpaper-Tinted Clock'),
        _('Tint the clock and date with a light shade of the wallpaper colour.')));

    return {
        group,
        dateStyleLinkedBox,
        dateStyleDropdown,
    };
}
