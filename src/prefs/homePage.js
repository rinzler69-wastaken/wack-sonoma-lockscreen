import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

export function buildHomePage(extensionPreferences, window, _) {
    const homePage = new Adw.PreferencesPage({
        title: _('Home'),
        icon_name: 'go-home-symbolic',
    });

    const homeGroup = new Adw.PreferencesGroup();
    const homeBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        valign: Gtk.Align.CENTER,
        spacing: 8,
        margin_top: 32,
        margin_bottom: 32,
        margin_start: 24,
        margin_end: 24,
    });

    const icon = new Gtk.Image({
        icon_name: 'preferences-desktop-screensaver-symbolic',
        pixel_size: 128,
        halign: Gtk.Align.CENTER,
    });
    homeBox.append(icon);

    const titleLabel = new Gtk.Label({
        label: extensionPreferences.metadata.name,
        css_classes: ['title-1'],
        justify: Gtk.Justification.CENTER,
        halign: Gtk.Align.CENTER,
        wrap: true,
        hexpand: true,
    });
    homeBox.append(titleLabel);

    const descriptionLabel = new Gtk.Label({
        label: extensionPreferences.metadata.description,
        css_classes: ['dim-label'],
        justify: Gtk.Justification.CENTER,
        halign: Gtk.Align.CENTER,
        wrap: true,
        max_width_chars: 60,
        hexpand: true,
    });
    homeBox.append(descriptionLabel);

    const rawVersion = extensionPreferences.metadata?.['version-name'] ?? extensionPreferences.metadata?.version ?? '2.1.0';
    const versionName = String(rawVersion);

    const versionLabel = versionName
        ? (versionName.startsWith('v') ? versionName : `v${versionName}`)
        : 'v2.1.0';

    const versionButton = new Gtk.Button({
        label: versionLabel,
        css_classes: ['app-version', 'text-button', 'pill'],
        halign: Gtk.Align.CENTER,
        margin_top: 24,
    });
    homeBox.append(versionButton);

    homeGroup.add(homeBox);
    homePage.add(homeGroup);

    const resourcesGroup = new Adw.PreferencesGroup({ title: _('Resources') });

    const repoRow = new Adw.ActionRow({
        title: _('Extension Repo'),
        subtitle: 'github.com/rinzler69-wastaken/wack-sonoma-lockscreen',
    });

    const githubIcon = new Gtk.Image({
        icon_name: 'system-software-install-symbolic',
        pixel_size: 32,
        valign: Gtk.Align.CENTER,
    });
    repoRow.add_prefix(githubIcon);

    const openBtn = new Gtk.Button({
        icon_name: 'adw-external-link-symbolic',
        tooltip_text: _('Open on GitHub'),
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    openBtn.connect('clicked', () => {
        Gtk.show_uri(window, extensionPreferences.metadata.url, GLib.CURRENT_TIME);
    });
    repoRow.add_suffix(openBtn);

    resourcesGroup.add(repoRow);

    const supportGroup = new Adw.PreferencesGroup({
        title: _('Enjoying this extension?'),
        description: _('Consider supporting its development!'),
    });

    const donations = extensionPreferences.metadata?.donations ?? {
        kofi: 'mikerinzler69',
        custom: 'https://saweria.co/rinzler69',
    };

    const kofiRow = new Adw.ActionRow({
        title: _('Ko-fi'),
        subtitle: `ko-fi.com/${donations.kofi}`,
    });

    const kofiIcon = new Gtk.Image({
        icon_name: 'emblem-favorite-symbolic',
        pixel_size: 32,
        valign: Gtk.Align.CENTER,
    });
    kofiRow.add_prefix(kofiIcon);

    const kofiBtn = new Gtk.Button({
        icon_name: 'adw-external-link-symbolic',
        tooltip_text: _('Open Ko-fi'),
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    kofiBtn.connect('clicked', () => {
        Gtk.show_uri(window, `https://ko-fi.com/${donations.kofi}`, GLib.CURRENT_TIME);
    });
    kofiRow.add_suffix(kofiBtn);

    supportGroup.add(kofiRow);

    const saweriaRow = new Adw.ActionRow({
        title: _('Saweria'),
        subtitle: donations.custom.replace('https://', ''),
    });

    const saweriaIcon = new Gtk.Image({
        icon_name: 'emblem-favorite-symbolic',
        pixel_size: 32,
        valign: Gtk.Align.CENTER,
    });
    saweriaRow.add_prefix(saweriaIcon);

    const saweriaBtn = new Gtk.Button({
        icon_name: 'adw-external-link-symbolic',
        tooltip_text: _('Open Saweria'),
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
    });
    saweriaBtn.connect('clicked', () => {
        Gtk.show_uri(window, donations.custom, GLib.CURRENT_TIME);
    });
    saweriaRow.add_suffix(saweriaBtn);

    supportGroup.add(saweriaRow);
    homePage.add(supportGroup);
    homePage.add(resourcesGroup);

    return homePage;
}
