import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { isWackShellInstalled, flushWackCache } from '../prefsUtils.js';

// <GDM_EXCLUDE>
import { getGdmStatus } from '../prefsUtils.js';
// </GDM_EXCLUDE>

export function buildExtrasGroup(extensionPreferences, window, settings, _) {
    const extrasGroup = new Adw.PreferencesGroup({
        title: _('Extras'),
    });

    let showDocs = true;

    // <GDM_EXCLUDE>
    const gdmStatus = getGdmStatus(extensionPreferences.dir);

    if (gdmStatus.enabled) {
        showDocs = false;
        const gdmExpander = new Adw.ExpanderRow({
            title: _('[PRO] GDM Expansion'),
            subtitle: _('Status: Enabled. Custom layout is active on GDM.'),
        });

        const gdmStatusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            label: _('Enabled'),
        });
        gdmStatusLabel.add_css_class('success');
        gdmExpander.add_suffix(gdmStatusLabel);

        if (settings.settings_schema.has_key('cupertino-system-actions')) {
            const systemActionsRow = new Adw.SwitchRow({
                title: _('Cupertino System Actions'),
                subtitle: _('Show Suspend, Restart and Power Off under the login user list, replacing the Quick Settings power menu.'),
            });
            settings.bind('cupertino-system-actions', systemActionsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            gdmExpander.add_row(systemActionsRow);
        }

        if (settings.settings_schema.has_key('gdm-background-dimmer')) {
            const backgroundDimmerRow = new Adw.SwitchRow({
                title: _('Dim Background Wallpaper'),
                subtitle: _('Apply a subtle 15% darkening overlay to the login wallpaper for enhanced contrast.'),
            });
            settings.bind('gdm-background-dimmer', backgroundDimmerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            gdmExpander.add_row(backgroundDimmerRow);
        }

        const uninstallRow = new Adw.ActionRow({
            title: _('GDM Expansion Documentation'),
            subtitle: _('Revert GDM login screen layout to GNOME Default. See repository instructions.'),
        });

        const linkBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: _('Open repository documentation'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        linkBtn.connect('clicked', () => {
            Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen', GLib.CURRENT_TIME);
        });

        uninstallRow.add_suffix(linkBtn);
        gdmExpander.add_row(uninstallRow);
        extrasGroup.add(gdmExpander);
    } else {
        let explanation = '';
        if (gdmStatus.reason === 'missing-sys-install') {
            explanation = _('Extension is not installed system-wide in /usr/share.');
        } else if (gdmStatus.reason === 'missing-modules') {
            explanation = _('GDM expansion modules (src/pro) are missing system-wide.');
        } else if (gdmStatus.reason === 'missing-session-mode') {
            explanation = _('GDM session mode is not enabled in system-wide metadata.');
        } else if (gdmStatus.reason === 'missing-dconf') {
            explanation = _('GDM dconf override configuration (/etc/dconf/db/gdm.d) is missing.');
        } else {
            explanation = _('GDM integration is not configured.');
        }

        const gdmExpander = new Adw.ExpanderRow({
            title: _('[PRO] GDM Expansion'),
            subtitle: `${_('Status: Disabled.')} ${explanation}`,
        });

        const gdmStatusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            label: _('Disabled'),
        });
        gdmStatusLabel.add_css_class('error');
        gdmExpander.add_suffix(gdmStatusLabel);

        const installRow = new Adw.ActionRow({
            title: _('GDM DLC Documentation'),
            subtitle: _('Visit the repository to view setup and installation documentation.'),
        });

        const linkInstallBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: _('Open repository documentation'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        linkInstallBtn.connect('clicked', () => {
            Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen', GLib.CURRENT_TIME);
        });

        installRow.add_suffix(linkInstallBtn);
        gdmExpander.add_row(installRow);
        extrasGroup.add(gdmExpander);
    }
    // </GDM_EXCLUDE>

    if (showDocs) {
        const docsRow = new Adw.ActionRow({
            title: _('Upgrade to [PRO]'),
            subtitle: _('Check PRO features of this extension on this extension\'s GitHub repo.'),
        });
        const docsBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: _('Visit documentation on GitHub'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        docsBtn.connect('clicked', () => {
            Gtk.show_uri(window, extensionPreferences.metadata.url, GLib.CURRENT_TIME);
        });
        docsRow.add_suffix(docsBtn);
        extrasGroup.add(docsRow);
    }

    const wackShellExpander = new Adw.ExpanderRow({
        title: _('[BETA] WACK Shell Integration'),
    });
    const wackShellStatusLabel = new Gtk.Label({
        valign: Gtk.Align.CENTER,
    });

    const isInstalled = isWackShellInstalled();
    if (isInstalled) {
        wackShellExpander.subtitle = _('Installed. Enables crossfade transitions and Cupertino-inspired shell customisations.');
        wackShellStatusLabel.label = _('Installed');
        wackShellStatusLabel.add_css_class('success');
        wackShellExpander.add_suffix(wackShellStatusLabel);

        const checkUpdatesRow = new Adw.ActionRow({
            title: _('WACK Shell Repository'),
            subtitle: _('Open the WACK Shell repository for documentation and updates.'),
        });

        const linkBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: _('Open WACK Shell repository'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        linkBtn.connect('clicked', () => {
            Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/wack-shell', GLib.CURRENT_TIME);
        });

        checkUpdatesRow.add_suffix(linkBtn);
        wackShellExpander.add_row(checkUpdatesRow);
    } else {
        wackShellExpander.subtitle = _('Not installed. Install WACK Shell to unlock transition effects.');
        wackShellStatusLabel.label = _('Not Installed');
        wackShellStatusLabel.add_css_class('error');
        wackShellExpander.add_suffix(wackShellStatusLabel);

        const installShellRow = new Adw.ActionRow({
            title: _('WACK Shell Repository'),
            subtitle: _('Visit the repository to view installation instructions and release packages.'),
        });

        const linkBtn = new Gtk.Button({
            icon_name: 'adw-external-link-symbolic',
            tooltip_text: _('Open WACK Shell repository'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        linkBtn.connect('clicked', () => {
            Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/wack-shell', GLib.CURRENT_TIME);
        });

        installShellRow.add_suffix(linkBtn);
        wackShellExpander.add_row(installShellRow);
    }

    extrasGroup.add(wackShellExpander);

    const flushCacheRow = new Adw.ActionRow({
        title: _('Clear Visual Cache'),
        subtitle: _('Clears temporary visual data used for wallpapers and vibrancy effects. It will be regenerated automatically.'),
    });

    const flushBtn = new Gtk.Button({
        label: _('Clear'),
        tooltip_text: _('Clears the visual cache used for wallpapers and vibrancy effects'),
        css_classes: ['destructive-action'],
        valign: Gtk.Align.CENTER,
    });
    flushBtn.connect('clicked', () => {
        try {
            flushWackCache();
            window.add_toast(new Adw.Toast({
                title: _('Visual cache cleared successfully!'),
            }));
        } catch (e) {
            window.add_toast(new Adw.Toast({
                title: `${_('Failed to clear cache:')} ${e.message}`,
            }));
        }
    });

    flushCacheRow.add_suffix(flushBtn);
    extrasGroup.add(flushCacheRow);

    return extrasGroup;
}
