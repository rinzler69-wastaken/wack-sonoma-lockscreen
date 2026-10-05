import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { flushAllCache } from '../main/alphaCache.js';

export function isWackShellInstalled() {
    const userPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'wack-shell@rinzler69-wastaken.github.com']);
    const sysPath1 = '/usr/share/gnome-shell/extensions/wack-shell@rinzler69-wastaken.github.com';
    const sysPath2 = '/usr/local/share/gnome-shell/extensions/wack-shell@rinzler69-wastaken.github.com';
    return Gio.File.new_for_path(userPath).query_exists(null) ||
        Gio.File.new_for_path(sysPath1).query_exists(null) ||
        Gio.File.new_for_path(sysPath2).query_exists(null);
}

export function isWackShellEnabled() {
    const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
    const enabled = shellSettings.get_strv('enabled-extensions');
    return enabled.includes('wack-shell@rinzler69-wastaken.github.com');
}

// <GDM_EXCLUDE>
export function getGdmStatus(dir) {
    const sysPath = '/usr/share/gnome-shell/extensions/wack-lockscreen-clock@rinzler69-wastaken.github.com';
    const sysDir = Gio.File.new_for_path(sysPath);

    const activeDir = (sysDir.query_exists(null)) ? sysDir : dir;
    if (!activeDir || !activeDir.query_exists(null))
        return { enabled: false, reason: 'missing-sys-install' };

    const proDir = activeDir.get_child('src').get_child('pro');
    const hasPro = (proDir.query_exists(null) && proDir.get_child('pro.js').query_exists(null)) ||
        activeDir.get_child('pro.js').query_exists(null);
    const hasCrossSessionJs = activeDir.get_child('crossSessionManager.js').query_exists(null);
    if (!hasPro || !hasCrossSessionJs)
        return { enabled: false, reason: 'missing-modules' };

    let hasGdmSessionMode = false;
    const file = activeDir.get_child('metadata.json');
    if (file.query_exists(null)) {
        try {
            const [, contents] = file.load_contents(null);
            const decoder = new TextDecoder('utf-8');
            const metadata = JSON.parse(decoder.decode(contents));
            hasGdmSessionMode = metadata['session-modes']?.includes('gdm') ?? false;
        } catch (_) {
            // malformed metadata
        }
    }
    if (!hasGdmSessionMode)
        return { enabled: false, reason: 'missing-session-mode' };

    const dconfFile = Gio.File.new_for_path('/etc/dconf/db/gdm.d/99-wack-lockscreen');
    if (!dconfFile.query_exists(null))
        return { enabled: false, reason: 'missing-dconf' };

    return { enabled: true, reason: 'ok' };
}
// </GDM_EXCLUDE>

export function flushWackCache() {
    flushAllCache();
}

export function buildComboRow(settings, key, title, subtitle, options, _) {
    const model = new Gtk.StringList();
    for (const [, label] of options)
        model.append(_(label));

    const row = new Adw.ComboRow({
        title,
        subtitle,
        model,
    });

    const syncFromSettings = () => {
        const current = settings.get_string(key);
        const selected = Math.max(0, options.findIndex(([value]) => value === current));
        row.selected = selected;
    };

    syncFromSettings();
    row.connect('notify::selected', () => {
        const [value] = options[row.selected] ?? options[0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    const sigId = settings.connect(`changed::${key}`, syncFromSettings);
    row.connect('destroy', () => settings.disconnect(sigId));

    return row;
}
