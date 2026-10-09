import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

function chooseWallpaper(window, _, onPicked) {
    const chooser = new Gtk.FileChooserNative({
        title: _('Select Lockscreen Wallpaper'),
        transient_for: window,
        action: Gtk.FileChooserAction.OPEN,
        accept_label: _('Select'),
        cancel_label: _('Cancel'),
    });

    const filter = new Gtk.FileFilter();
    filter.set_name(_('Images and Slideshows'));
    filter.add_mime_type('image/png');
    filter.add_mime_type('image/jpeg');
    filter.add_mime_type('image/webp');
    filter.add_mime_type('image/jxl');
    filter.add_mime_type('image/svg+xml');
    // GNOME slideshow XML, e.g. time-of-day wallpapers in /usr/share/backgrounds
    filter.add_pattern('*.xml');
    chooser.add_filter(filter);

    chooser.connect('response', (_self, responseId) => {
        const path = responseId === Gtk.ResponseType.ACCEPT ? chooser.get_file()?.get_path() : null;
        if (path)
            onPicked(path);
        chooser.destroy();
    });

    chooser.show();
}

export function buildGeneralGroup(settings, window, _, settingsSignalIds) {
    const generalGroup = new Adw.PreferencesGroup({
        title: _('General'),
    });

    const passwordIndicatorsRow = new Adw.SwitchRow({
        title: _('Password Field Indicators'),
        subtitle: _('Show Caps Lock and keyboard layout icons inside the password field.'),
    });
    settings.bind('password-indicators', passwordIndicatorsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    generalGroup.add(passwordIndicatorsRow);

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
        chooseWallpaper(window, _, path => settings.set_string('lockscreen-wallpaper-path', path));
    });

    wallpaperPathRow.add_suffix(wallpaperChooseBtn);

    // 5. Per-monitor overrides, keyed by connector name.
    // ponytail: rows are built once; reopen prefs after plugging in a monitor.
    const monitorsRow = new Adw.ExpanderRow({
        title: _('Per-Monitor Wallpapers'),
        subtitle: _('Monitors without their own wallpaper use the one above.'),
    });
    const getMonitorPaths = () => settings.get_value('lockscreen-wallpaper-monitors').deepUnpack();
    const setMonitorPath = (connector, path) => {
        const paths = getMonitorPaths();
        if (path)
            paths[connector] = path;
        else
            delete paths[connector];
        settings.set_value('lockscreen-wallpaper-monitors', new GLib.Variant('a{ss}', paths));
    };

    const monitorRows = [];
    const monitors = Gdk.Display.get_default()?.get_monitors();
    for (let i = 0; i < (monitors?.get_n_items() ?? 0); i++) {
        const monitor = monitors.get_item(i);
        const connector = monitor.get_connector();
        if (!connector)
            continue;

        const row = new Adw.ActionRow({
            title: monitor.get_description() || connector,
            use_markup: false, // subtitle shows raw file paths
        });
        const chooseBtn = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: _('Select Image File'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        chooseBtn.connect('clicked', () => chooseWallpaper(window, _, path => setMonitorPath(connector, path)));
        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Use the Default Wallpaper'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clearBtn.connect('clicked', () => setMonitorPath(connector, null));
        row.add_suffix(chooseBtn);
        row.add_suffix(clearBtn);
        monitorsRow.add_row(row);
        monitorRows.push({ row, connector, clearBtn });
    }

    const syncMonitorRows = () => {
        const paths = getMonitorPaths();
        for (const { row, connector, clearBtn } of monitorRows) {
            row.subtitle = paths[connector] || _('Default');
            clearBtn.sensitive = !!paths[connector];
        }
    };
    syncMonitorRows();
    settingsSignalIds.push(settings.connect('changed::lockscreen-wallpaper-monitors', syncMonitorRows));

    const refreshWallpaperPathSensitivity = () => {
        const enabled = settings.get_boolean('lockscreen-wallpaper-enable');
        wallpaperPathRow.sensitive = enabled;
        monitorsRow.sensitive = enabled;
    };

    settingsSignalIds.push(settings.connect('changed::lockscreen-wallpaper-path', () => {
        const currentPath = settings.get_string('lockscreen-wallpaper-path');
        wallpaperPathRow.subtitle = currentPath || _('No image selected');
    }));

    refreshWallpaperPathSensitivity();
    generalGroup.add(wallpaperPathRow);
    if (monitorRows.length > 0)
        generalGroup.add(monitorsRow);

    return {
        group: generalGroup,
    };
}
