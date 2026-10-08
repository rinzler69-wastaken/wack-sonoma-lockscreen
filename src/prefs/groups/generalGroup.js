import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

export function buildGeneralGroup(settings, window, _, settingsSignalIds) {
    const generalGroup = new Adw.PreferencesGroup({
        title: _('General'),
    });

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

    generalGroup.add(dateStyleRow);

    const cursorBlinkRow = new Adw.ActionRow({
        title: _('Cursor Blinking'),
        subtitle: _('Enable or disable text cursor blinking in the password field.'),
    });
    const cursorBlinkSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: settings.get_boolean('cursor-blink'),
    });
    cursorBlinkSwitch.connect('notify::active', () => {
        settings.set_boolean('cursor-blink', cursorBlinkSwitch.active);
    });
    settingsSignalIds.push(settings.connect('changed::cursor-blink', () => {
        cursorBlinkSwitch.active = settings.get_boolean('cursor-blink');
    }));
    cursorBlinkRow.add_suffix(cursorBlinkSwitch);
    cursorBlinkRow.activatable_widget = cursorBlinkSwitch;
    generalGroup.add(cursorBlinkRow);

    const wallpaperEnableRow = new Adw.ActionRow({
        title: _('Custom Lockscreen Wallpaper'),
        subtitle: _('Use a custom image overlay for the lockscreen background.'),
    });
    const wallpaperEnableSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        active: settings.get_boolean('lockscreen-wallpaper-enable'),
    });
    wallpaperEnableSwitch.connect('notify::active', () => {
        settings.set_boolean('lockscreen-wallpaper-enable', wallpaperEnableSwitch.active);
        refreshWallpaperPathSensitivity();
    });
    settingsSignalIds.push(settings.connect('changed::lockscreen-wallpaper-enable', () => {
        wallpaperEnableSwitch.active = settings.get_boolean('lockscreen-wallpaper-enable');
        refreshWallpaperPathSensitivity();
    }));
    wallpaperEnableRow.add_suffix(wallpaperEnableSwitch);
    wallpaperEnableRow.activatable_widget = wallpaperEnableSwitch;
    generalGroup.add(wallpaperEnableRow);

    const wallpaperPathRow = new Adw.ActionRow({
        title: _('Wallpaper Image Path'),
        subtitle: settings.get_string('lockscreen-wallpaper-path') || _('No image selected'),
    });

    const wallpaperChooseBtn = new Gtk.Button({
        icon_name: 'folder-open-symbolic',
        tooltip_text: _('Select Image File'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });

    wallpaperChooseBtn.connect('clicked', () => {
        const chooser = new Gtk.FileChooserNative({
            title: _('Select Lockscreen Wallpaper'),
            transient_for: window,
            action: Gtk.FileChooserAction.OPEN,
            accept_label: _('Select'),
            cancel_label: _('Cancel'),
        });

        const filter = new Gtk.FileFilter();
        filter.set_name(_('Image Files'));
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/jpeg');
        filter.add_mime_type('image/webp');
        filter.add_mime_type('image/jxl');
        filter.add_mime_type('image/svg+xml');
        chooser.add_filter(filter);

        chooser.connect('response', (_self, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                const file = chooser.get_file();
                if (file) {
                    const path = file.get_path();
                    settings.set_string('lockscreen-wallpaper-path', path);
                }
            }
            chooser.destroy();
        });

        chooser.show();
    });

    wallpaperPathRow.add_suffix(wallpaperChooseBtn);

    const refreshWallpaperPathSensitivity = () => {
        const enabled = settings.get_boolean('lockscreen-wallpaper-enable');
        wallpaperPathRow.sensitive = enabled;
    };

    settingsSignalIds.push(settings.connect('changed::lockscreen-wallpaper-path', () => {
        const currentPath = settings.get_string('lockscreen-wallpaper-path');
        wallpaperPathRow.subtitle = currentPath || _('No image selected');
    }));

    refreshWallpaperPathSensitivity();
    generalGroup.add(wallpaperPathRow);

    return {
        group: generalGroup,
        dateStyleLinkedBox,
        dateStyleDropdown,
    };
}
