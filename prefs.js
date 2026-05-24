import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { CLOCK_ANIMATION_OPTIONS, PROMPT_ANIMATION_OPTIONS } from './anims.js';

export default class WackLockscreenClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // -- Home page -------------------------------------------------------
        const homePage = new Adw.PreferencesPage({
            title: 'Home',
            icon_name: 'go-home-symbolic',
        });

        const homeGroup = new Adw.PreferencesGroup();
        const homeBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            spacing: 12,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 24,
            margin_end: 24,
        });

        const icon = new Gtk.Image({
            icon_name: 'preferences-desktop-screensaver-symbolic',
            pixel_size: 128,
        });
        homeBox.append(icon);

        const titleLabel = new Gtk.Label({
            label: this.metadata.name,
            css_classes: ['title-1'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
        });
        homeBox.append(titleLabel);

        const descriptionLabel = new Gtk.Label({
            label: this.metadata.description,
            css_classes: ['dim-label'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            wrap: true,
            max_width_chars: 60,
        });
        homeBox.append(descriptionLabel);

        homeGroup.add(homeBox);
        homePage.add(homeGroup);

        const resourcesGroup = new Adw.PreferencesGroup({ title: 'Resources' });

        const repoRow = new Adw.ActionRow({
            title: 'Extension Repo',
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
            tooltip_text: 'Open on GitHub',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        openBtn.connect('clicked', () => {
            Gtk.show_uri(window, this.metadata.url, GLib.CURRENT_TIME);
        });
        repoRow.add_suffix(openBtn);

        resourcesGroup.add(repoRow);
        homePage.add(resourcesGroup);

        window.add(homePage);

        // -- Configuration page ----------------------------------------------
        const animPage = new Adw.PreferencesPage({
            title: 'Configuration',
            icon_name: 'system-lock-screen-symbolic',
        });

        // -- Mode selector --------------------------------------------------
        const modeGroup = new Adw.PreferencesGroup({
            title: 'Lockscreen Mode',
            description: 'WACK is the classic GNOME-compliant style. Cupertino emulates macOS Sonoma.',
        });

        const modeRow = new Adw.ActionRow({
            title: 'Mode',
        });
        const modeSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_string('lockscreen-mode') === 'cupertino',
        });
        modeSwitch.connect('notify::active', () => {
            settings.set_string('lockscreen-mode', modeSwitch.active ? 'cupertino' : 'wack');
            animationGroup.sensitive = !modeSwitch.active;
        });
        settings.connect('changed::lockscreen-mode', () => {
            const isCupertino = settings.get_string('lockscreen-mode') === 'cupertino';
            modeSwitch.active = isCupertino;
            animationGroup.sensitive = !isCupertino;
        });

        const wackLabel = new Gtk.Label({ label: 'WACK', valign: Gtk.Align.CENTER });
        const cupertinoLabel = new Gtk.Label({ label: 'Cupertino', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] });
        const modeBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
        modeBox.append(wackLabel);
        modeBox.append(modeSwitch);
        modeBox.append(cupertinoLabel);
        modeRow.add_suffix(modeBox);
        modeGroup.add(modeRow);

        // -- Cupertino options ----------------------------------------------
        const alwaysShowUserRow = new Adw.ActionRow({
            title: 'Always Show User Widget (Cupertino)',
            subtitle: 'Always shows user widget, hides notifications by default. Press Shift+N to show notifications.',
        });
        const alwaysShowUserSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('cupertino-always-show-user'),
        });
        alwaysShowUserSwitch.connect('notify::active', () => {
            settings.set_boolean('cupertino-always-show-user', alwaysShowUserSwitch.active);
        });
        settings.connect('changed::cupertino-always-show-user', () => {
            alwaysShowUserSwitch.active = settings.get_boolean('cupertino-always-show-user');
        });
        alwaysShowUserRow.add_suffix(alwaysShowUserSwitch);
        alwaysShowUserRow.activatable_widget = alwaysShowUserSwitch;
        alwaysShowUserRow.sensitive = settings.get_string('lockscreen-mode') === 'cupertino';

        modeSwitch.connect('notify::active', () => {
            alwaysShowUserRow.sensitive = modeSwitch.active;
        });
        settings.connect('changed::lockscreen-mode', () => {
            alwaysShowUserRow.sensitive = settings.get_string('lockscreen-mode') === 'cupertino';
        });

        modeGroup.add(alwaysShowUserRow);

        animPage.add(modeGroup);

        // -- Animation options (greyed out in Cupertino mode) ---------------
        const animationGroup = new Adw.PreferencesGroup({
            title: 'Animations',
            description: 'Choose how the lock screen clock leaves and how the password prompt enters.',
        });
        animationGroup.sensitive = settings.get_string('lockscreen-mode') !== 'cupertino';

        animationGroup.add(this._buildComboRow(
            settings,
            'clock-animation',
            'Clock Animation',
            'Applied to the date and time while opening the password prompt',
            CLOCK_ANIMATION_OPTIONS));

        animationGroup.add(this._buildComboRow(
            settings,
            'prompt-animation',
            'Prompt Animation',
            'Applied to the authentication prompt while it appears',
            PROMPT_ANIMATION_OPTIONS));

        const resetRow = new Adw.ActionRow({
            title: 'Reset Animations',
            subtitle: 'Restore defaults',
        });
        const resetButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Reset animations',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('clock-animation');
            settings.reset('prompt-animation');
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        animationGroup.add(resetRow);

        animPage.add(animationGroup);
        window.add(animPage);
    }

    _buildComboRow(settings, key, title, subtitle, options) {
        const model = new Gtk.StringList();
        for (const [, label] of options)
            model.append(label);

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
        settings.connect(`changed::${key}`, syncFromSettings);

        return row;
    }
}