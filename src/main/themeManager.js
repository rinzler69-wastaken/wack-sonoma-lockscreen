import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ThemeManager {
    constructor(extension) {
        this._extension = extension;
        this.origSessionModeProps = null;
        this.origStylesheet = undefined;
    }

    applyUserTheme() {
        this.origStylesheet = undefined;
        const userThemeFile = this.getUserThemeFile();
        if (userThemeFile) {
            this.origStylesheet = Main.getThemeStylesheet();
            Main.setThemeStylesheet(userThemeFile.get_path());
            Main.loadTheme();
        }
    }

    restoreUserTheme() {
        if (this.origStylesheet !== undefined) {
            if (Main.sessionMode.currentMode !== 'user') {
                Main.setThemeStylesheet(this.origStylesheet ? this.origStylesheet.get_path() : null);
                Main.loadTheme();
            }
            this.origStylesheet = undefined;
        }
    }

    tempSessionModeOverride() {
        if (this.origSessionModeProps) return;
        this.origSessionModeProps = {
            hasWindows: Main.sessionMode.hasWindows,
            hasWorkspaces: Main.sessionMode.hasWorkspaces,
            panel: Main.sessionMode.panel,
            panelStyle: Main.sessionMode.panelStyle,
        };
        Main.sessionMode.hasWindows = true;
        Main.sessionMode.hasWorkspaces = true;
        Main.sessionMode.panel = {
            left: ['activities'],
            center: ['dateMenu'],
            right: ['screenRecording', 'screenSharing', 'dwellClick', 'a11y', 'keyboard', 'quickSettings'],
        };
        Main.sessionMode.panelStyle = null;
        Main.sessionMode.emit('updated');
    }

    restoreSessionMode() {
        if (!this.origSessionModeProps) return;
        Main.sessionMode.hasWindows = this.origSessionModeProps.hasWindows;
        Main.sessionMode.hasWorkspaces = this.origSessionModeProps.hasWorkspaces;
        Main.sessionMode.panel = this.origSessionModeProps.panel;
        Main.sessionMode.panelStyle = this.origSessionModeProps.panelStyle;
        this.origSessionModeProps = null;
        Main.sessionMode.emit('updated');
    }

    getUserThemeFile() {
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const enabledExtensions = shellSettings.get_strv('enabled-extensions');
        if (!enabledExtensions.includes('user-theme@gnome-shell-extensions.gcampax.github.com')) {
            return null;
        }
        const schemaSource = Gio.SettingsSchemaSource.get_default();
        if (!schemaSource) return null;
        const schema = schemaSource.lookup('org.gnome.shell.extensions.user-theme', true);
        if (!schema) return null;

        const themeSettings = new Gio.Settings({ settings_schema: schema });
        const themeName = themeSettings.get_string('name');
        if (!themeName) return null;

        const paths = [
            GLib.build_filenamev([GLib.get_home_dir(), '.themes', themeName, 'gnome-shell', 'gnome-shell.css']),
            GLib.build_filenamev([GLib.get_user_data_dir(), 'themes', themeName, 'gnome-shell', 'gnome-shell.css']),
            GLib.build_filenamev(['/usr/share/themes', themeName, 'gnome-shell', 'gnome-shell.css']),
        ];

        for (const path of paths) {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) return file;
        }
        return null;
    }

    teardown() {
        this.restoreSessionMode();
        this.restoreUserTheme();
    }
}
