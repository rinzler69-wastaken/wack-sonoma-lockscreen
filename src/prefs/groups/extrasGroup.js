import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { isWackShellInstalled, getGdmStatus, flushWackCache } from '../prefsUtils.js';

export function buildExtrasGroup(extensionPreferences, window, _) {
    const extrasGroup = new Adw.PreferencesGroup({
        title: _('Extras'),
    });

    let showDocs = true;

    // <GDM_EXCLUDE>
    const gdmStatus = getGdmStatus(extensionPreferences.dir);

    if (gdmStatus.enabled) {
        showDocs = false;
        // 1. GDM Expansion Expander Row (Enabled)
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

        const uninstallRow = new Adw.ActionRow({
            title: _('GDM Expansion - Remove'),
            subtitle: _('Revert GDM login screen layout to GNOME Default. To uninstall, run copied command in a terminal.'),
        });

        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy uninstall command to clipboard'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        copyBtn.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/uninstall-gdm-dlc.sh | bash');
            window.add_toast(new Adw.Toast({
                title: _('Copied uninstall command to clipboard!'),
            }));
        });

        uninstallRow.add_suffix(copyBtn);
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
            title: _('Enable GDM DLC Support'),
            subtitle: _('Click icon to copy installer command, then run it in a terminal.'),
        });

        const copyInstallBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy install command to clipboard'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        copyInstallBtn.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-gdm-dlc.sh | bash');
            window.add_toast(new Adw.Toast({
                title: _('Copied install command to clipboard!'),
            }));
        });

        installRow.add_suffix(copyInstallBtn);
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

    // 2. WACK Shell Integration Expander Row
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
            title: _('WACK Shell - Check for Updates'),
            subtitle: _('Copy check command to verify if a newer version of WACK Shell is available.'),
        });

        const checkBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy update-check command to clipboard'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        checkBtn.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken.github.com/wack-sonoma-lockscreen/main/scripts/install-wack-shell.sh | bash -s -- --check');
            window.add_toast(new Adw.Toast({
                title: _('Copied WACK Shell update-check command to clipboard!'),
            }));
        });

        checkUpdatesRow.add_suffix(checkBtn);
        wackShellExpander.add_row(checkUpdatesRow);
    } else {
        wackShellExpander.subtitle = _('Not installed. Install WACK Shell to unlock transition effects.');
        wackShellStatusLabel.label = _('Not Installed');
        wackShellStatusLabel.add_css_class('error');
        wackShellExpander.add_suffix(wackShellStatusLabel);

        const installShellRow = new Adw.ActionRow({
            title: _('WACK Shell - Install'),
            subtitle: _('Get advanced desktop crossfade transitions and Cupertino-inspired shell customisations. May contain bugs, report if found.'),
        });

        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy install command to clipboard'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        copyBtn.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-wack-shell.sh | bash');
            window.add_toast(new Adw.Toast({
                title: _('Copied WACK Shell install command to clipboard!'),
            }));
        });

        const linkBtn = new Gtk.Button({
            icon_name: 'web-browser-symbolic',
            tooltip_text: _('Open WACK Shell repository'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        linkBtn.connect('clicked', () => {
            Gtk.show_uri(window, 'https://github.com/rinzler69-wastaken/wack-shell', GLib.CURRENT_TIME);
        });

        installShellRow.add_suffix(copyBtn);
        installShellRow.add_suffix(linkBtn);
        wackShellExpander.add_row(installShellRow);
    }

    extrasGroup.add(wackShellExpander);

    // 3. Flush Cache Action Row
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
