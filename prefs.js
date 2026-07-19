import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { CLOCK_ANIMATION_OPTIONS, PROMPT_ANIMATION_OPTIONS } from './anims.js';

function _isWackShellInstalled() {
    try {
        const userPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'wack-shell@rinzler69-wastaken.github.com']);
        const sysPath1 = '/usr/share/gnome-shell/extensions/wack-shell@rinzler69-wastaken.github.com';
        const sysPath2 = '/usr/local/share/gnome-shell/extensions/wack-shell@rinzler69-wastaken.github.com';
        return Gio.File.new_for_path(userPath).query_exists(null) ||
            Gio.File.new_for_path(sysPath1).query_exists(null) ||
            Gio.File.new_for_path(sysPath2).query_exists(null);
        Gio.File.new_for_path(sysPath1).query_exists(null) ||
            Gio.File.new_for_path(sysPath2).query_exists(null);
    } catch (e) {
        return false;
    }
}

function _isWackShellEnabled() {
    try {
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const enabled = shellSettings.get_strv('enabled-extensions');
        return enabled.includes('wack-shell@rinzler69-wastaken.github.com');
    } catch (e) {
        return false;
    }
}

function _hasDconfOverride(uuid) {
    try {
        const dir = Gio.File.new_for_path('/etc/dconf/db/gdm.d');
        if (!dir.query_exists(null))
            return false;

        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        const decoder = new TextDecoder('utf-8');
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;

            const child = dir.get_child(info.get_name());
            try {
                const [, contents] = child.load_contents(null);
                const text = decoder.decode(contents);
                if (text.includes(uuid))
                    return true;
            } catch (e) {
                // ignore read errors for individual files
            }
        }
    } catch (e) {
        // ignore
    }
    return false;
}

function _getGdmStatus(dir) {
    try {
        if (!dir)
            return { enabled: false, reason: 'missing-dir' };

        const hasGdmJs = dir.get_child('gdm.js').query_exists(null);
        const hasCrossSessionJs = dir.get_child('crossSessionManager.js').query_exists(null);
        if (!hasGdmJs || !hasCrossSessionJs)
            return { enabled: false, reason: 'missing-modules' };

        const uuid = 'wack-lockscreen-clock@rinzler69-wastaken.github.com';
        if (!_hasDconfOverride(uuid))
            return { enabled: false, reason: 'missing-dconf' };

        return { enabled: true, reason: 'ok' };
    } catch (e) {
        return { enabled: false, reason: 'error', error: e.message };
    }
}

export default class WackLockscreenClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        // Collect settings signal IDs so they can all be disconnected when the
        // prefs window is destroyed, preventing stale closures from keeping
        // widget objects alive beyond the window lifetime (M5).
        const settingsSignalIds = [];
        const cleanupCallbacks = [];

        // Increase default window size (width, height)
        window.set_default_size(700, 800);

        // -- Home page -------------------------------------------------------
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
            label: this.metadata.name,
            css_classes: ['title-1'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            wrap: true,
            hexpand: true,
        });
        homeBox.append(titleLabel);

        const descriptionLabel = new Gtk.Label({
            label: this.metadata.description,
            css_classes: ['dim-label'],
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            wrap: true,
            max_width_chars: 60,
            hexpand: true,
        });
        homeBox.append(descriptionLabel);

        let versionName = this.metadata['version-name'] || this.metadata.version || '';
        if (!versionName && this.dir) {
            try {
                const file = this.dir.get_child('metadata.json');
                const [, contents] = file.load_contents(null);
                const decoder = new TextDecoder('utf-8');
                const parsedMetadata = JSON.parse(decoder.decode(contents));
                versionName = parsedMetadata['version-name'] || parsedMetadata.version || '';
            } catch (e) {
                console.error('Failed to parse metadata.json:', e);
            }
        }

        versionName = String(versionName);

        const versionLabel = versionName
            ? (versionName.startsWith('v') ? versionName : `v${versionName}`)
            : 'v1.1.0';

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
            Gtk.show_uri(window, this.metadata.url, GLib.CURRENT_TIME);
        });
        repoRow.add_suffix(openBtn);

        resourcesGroup.add(repoRow);

        const supportGroup = new Adw.PreferencesGroup({
            title: _('Enjoying this extension?'),
            description: _('Consider supporting its development!'),
        });

        let donations = this.metadata.donations;
        if (!donations && this.dir) {
            try {
                const file = this.dir.get_child('metadata.json');
                const [, contents] = file.load_contents(null);
                const decoder = new TextDecoder('utf-8');
                donations = JSON.parse(decoder.decode(contents)).donations;
            } catch (e) {
                console.error('Failed to parse metadata.json:', e);
            }
        }
        donations = donations || {
            kofi: 'mikerinzler69',
            custom: 'https://saweria.co/rinzler69'
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

        window.add(homePage);

        // -- Configuration page ----------------------------------------------
        const animPage = new Adw.PreferencesPage({
            title: _('Configuration'),
            icon_name: 'system-lock-screen-symbolic',
        });

        // -- Mode selector --------------------------------------------------
        const modeGroup = new Adw.PreferencesGroup({
            title: _('Lockscreen Mode'),
        });

        const modeRow = new Adw.ExpanderRow({
            title: _('Mode'),
            show_enable_switch: false,
        });
        modeGroup.add(modeRow);

        const modeBox = new Gtk.Box({
            valign: Gtk.Align.CENTER,
        });

        const linkedBox = new Gtk.Box({ css_classes: ['linked'] });
        const btnLegacy = new Gtk.ToggleButton({ label: _('Legacy') });
        const btnCupertino = new Gtk.ToggleButton({ label: _('Cupertino'), group: btnLegacy });
        linkedBox.append(btnLegacy);
        linkedBox.append(btnCupertino);

        const dropdown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: Gtk.StringList.new([_('Legacy'), _('Cupertino')])
        });

        modeBox.append(linkedBox);
        modeBox.append(dropdown);
        modeRow.add_suffix(modeBox);

        // -- Cupertino options ----------------------------------------------
        const alwaysShowUserRow = new Adw.ActionRow({
            title: _('Always Show User Widget'),
            subtitle: _('Hides notifications by default. Press Shift+N to show notifications.'),
        });
        const alwaysShowUserSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('cupertino-always-show-user'),
        });
        alwaysShowUserSwitch.connect('notify::active', () => {
            settings.set_boolean('cupertino-always-show-user', alwaysShowUserSwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::cupertino-always-show-user', () => {
            alwaysShowUserSwitch.active = settings.get_boolean('cupertino-always-show-user');
        }));
        alwaysShowUserRow.add_suffix(alwaysShowUserSwitch);
        alwaysShowUserRow.activatable_widget = alwaysShowUserSwitch;
        modeRow.add_row(alwaysShowUserRow);

        const promptVibrancyRow = new Adw.ActionRow({
            title: _('Prompt Vibrancy'),
            subtitle: _('Applies dynamic color to the password field based on wallpaper colors.'),
        });
        const promptVibrancySwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('prompt-vibrancy'),
        });
        promptVibrancySwitch.connect('notify::active', () => {
            settings.set_boolean('prompt-vibrancy', promptVibrancySwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::prompt-vibrancy', () => {
            promptVibrancySwitch.active = settings.get_boolean('prompt-vibrancy');
        }));
        promptVibrancyRow.add_suffix(promptVibrancySwitch);
        promptVibrancyRow.activatable_widget = promptVibrancySwitch;
        promptVibrancyRow.sensitive = settings.get_string('lockscreen-mode') === 'cupertino';

        modeRow.add_row(promptVibrancyRow);

        const messageEnableRow = new Adw.ActionRow({
            title: _('Show message when locked'),
        });
        const messageEnableSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('cupertino-lockscreen-message-enable'),
        });
        messageEnableSwitch.connect('notify::active', () => {
            settings.set_boolean('cupertino-lockscreen-message-enable', messageEnableSwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::cupertino-lockscreen-message-enable', () => {
            messageEnableSwitch.active = settings.get_boolean('cupertino-lockscreen-message-enable');
        }));
        messageEnableRow.add_suffix(messageEnableSwitch);
        messageEnableRow.activatable_widget = messageEnableSwitch;

        const messageSetButton = new Gtk.Button({
            label: _('Set...'),
            valign: Gtk.Align.CENTER,
            sensitive: settings.get_boolean('cupertino-lockscreen-message-enable'),
        });

        messageEnableSwitch.connect('notify::active', () => {
            messageSetButton.sensitive = messageEnableSwitch.active;
        });
        settingsSignalIds.push(settings.connect('changed::cupertino-lockscreen-message-enable', () => {
            messageSetButton.sensitive = settings.get_boolean('cupertino-lockscreen-message-enable');
        }));

        messageSetButton.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                heading: _('Set a message to appear on the lockscreen'),
                close_response: 'cancel',
                modal: true,
            });

            const textView = new Gtk.TextView({
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                top_margin: 12,
                bottom_margin: 12,
                left_margin: 12,
                right_margin: 12,
                accepts_tab: false,
            });

            const buffer = textView.get_buffer();
            buffer.set_text(
                settings.get_string('cupertino-lockscreen-message-text'),
                -1
            );

            const scrolled = new Gtk.ScrolledWindow({
                min_content_height: 180,
                min_content_width: 420,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
                child: textView,
            });

            const frame = new Gtk.Frame({
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 6,
                margin_end: 6,
                child: scrolled,
            });

            dialog.set_extra_child(frame);

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('ok', _('OK'));
            dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);

            dialog.set_default_response('ok');

            dialog.connect('response', (_self, response) => {
                if (response === 'ok') {
                    const start = buffer.get_start_iter();
                    const end = buffer.get_end_iter();

                    let text = buffer.get_text(start, end, false);

                    // Hard cap at 250 characters
                    if (text.length > 250)
                        text = text.substring(0, 250);

                    settings.set_string(
                        'cupertino-lockscreen-message-text',
                        text
                    );
                }

                dialog.destroy();
            });

            dialog.present();

            // Focus the editor immediately
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                textView.grab_focus();
                return GLib.SOURCE_REMOVE;
            });
        });

        messageEnableRow.add_suffix(messageSetButton);

        const unlockFadeRow = new Adw.ActionRow({
            title: _('Unlock Crossfade'),
            subtitle: _('Crossfade the lockscreen with desktop when unlocking (automatically disabled in Power Saver mode).'),
        });
        const unlockFadeSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('cupertino-unlock-fade'),
        });
        unlockFadeSwitch.connect('notify::active', () => {
            settings.set_boolean('cupertino-unlock-fade', unlockFadeSwitch.active);
            refreshUnlockFadeAvailability();
        });
        settingsSignalIds.push(settings.connect('changed::cupertino-unlock-fade', () => {
            unlockFadeSwitch.active = settings.get_boolean('cupertino-unlock-fade');
            refreshUnlockFadeAvailability();
        }));
        unlockFadeRow.add_suffix(unlockFadeSwitch);
        unlockFadeRow.activatable_widget = unlockFadeSwitch;

        // -- Crossfade Speed child row --------------------------------------
        const speedRow = new Adw.ActionRow({
            title: _('Crossfade Speed'),
        });

        const speedBox = new Gtk.Box({ valign: Gtk.Align.CENTER });

        // Linked buttons (wide layout) — Slower is active by default
        const speedLinkedBox = new Gtk.Box({ css_classes: ['linked'] });
        const btnSlow = new Gtk.ToggleButton({ label: _('Slower'), active: true });
        const btnFast = new Gtk.ToggleButton({ label: _('Faster'), group: btnSlow });
        speedLinkedBox.append(btnSlow);
        speedLinkedBox.append(btnFast);

        // Dropdown fallback (narrow layout)
        const speedDropdown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: Gtk.StringList.new([_('Slower'), _('Faster')]),
        });

        speedBox.append(speedLinkedBox);
        speedBox.append(speedDropdown);
        speedRow.add_suffix(speedBox);

        let selfChangeSpeed = false;

        const syncSpeedButtons = () => {
            const v = settings.get_string('cupertino-crossfade-speed') || 'slow';
            selfChangeSpeed = true;
            btnSlow.active = (v !== 'fast');   // default to Slower for any non-'fast' value
            btnFast.active = (v === 'fast');
            speedDropdown.selected = (v === 'fast') ? 1 : 0;
            selfChangeSpeed = false;
        };
        syncSpeedButtons();

        btnSlow.connect('toggled', () => {
            if (selfChangeSpeed || !btnSlow.active) return;
            selfChangeSpeed = true;
            settings.set_string('cupertino-crossfade-speed', 'slow');
            speedDropdown.selected = 0;
            selfChangeSpeed = false;
        });
        btnFast.connect('toggled', () => {
            if (selfChangeSpeed || !btnFast.active) return;
            selfChangeSpeed = true;
            settings.set_string('cupertino-crossfade-speed', 'fast');
            speedDropdown.selected = 1;
            selfChangeSpeed = false;
        });
        speedDropdown.connect('notify::selected', () => {
            if (selfChangeSpeed) return;
            selfChangeSpeed = true;
            const val = speedDropdown.selected === 1 ? 'fast' : 'slow';
            settings.set_string('cupertino-crossfade-speed', val);
            btnSlow.active = (val !== 'fast');
            btnFast.active = (val === 'fast');
            selfChangeSpeed = false;
        });
        settingsSignalIds.push(settings.connect('changed::cupertino-crossfade-speed', () => {
            if (!selfChangeSpeed) syncSpeedButtons();
        }));

        // Responsive: hide linked buttons, show dropdown on narrow windows
        speedDropdown.visible = false;
        speedLinkedBox.visible = true;

        modeRow.add_row(unlockFadeRow);
        modeRow.add_row(speedRow);
        modeRow.add_row(messageEnableRow);

        // -- Animation options (Legacy mode sub-settings) --------------------
        const clockAnimRow = this._buildComboRow(
            settings,
            'clock-animation',
            _('Clock Animation'),
            _('Applied to the date and time while opening the password prompt'),
            CLOCK_ANIMATION_OPTIONS
        );

        const promptAnimRow = this._buildComboRow(
            settings,
            'prompt-animation',
            _('Prompt Animation'),
            _('Applied to the authentication prompt while it appears'),
            PROMPT_ANIMATION_OPTIONS
        );

        const resetRow = new Adw.ActionRow({
            title: _('Reset Animations'),
            subtitle: _('Restore defaults'),
        });
        const resetButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Reset animations'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('clock-animation');
            settings.reset('prompt-animation');
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;

        modeRow.add_row(clockAnimRow);
        modeRow.add_row(promptAnimRow);
        modeRow.add_row(resetRow);

        animPage.add(modeGroup);

        let selfChangeMode = false;
        function refreshUnlockFadeAvailability() {
            const isCup = settings.get_string('lockscreen-mode') === 'cupertino';
            const wackShellInstalled = _isWackShellInstalled();
            const wackShellEnabled = _isWackShellEnabled();

            let subtitleText = _('Crossfade the lockscreen with desktop when unlocking (automatically disabled in Power Saver mode).');
            if (!wackShellInstalled)
                subtitleText += ' ' + _('Requires WACK Shell to be installed and enabled.');
            else if (!wackShellEnabled)
                subtitleText += ' ' + _('Requires WACK Shell to be enabled.');

            unlockFadeRow.subtitle = subtitleText;
            const available = isCup && wackShellInstalled && wackShellEnabled;
            unlockFadeRow.sensitive = available;
            speedRow.sensitive = available && settings.get_boolean('cupertino-unlock-fade');
        }
        const syncModeFromSettings = () => {
            const val = settings.get_string('lockscreen-mode');
            const isCup = val === 'cupertino';
            const index = isCup ? 1 : 0;

            if (!selfChangeMode) {
                selfChangeMode = true;
                if (index === 0) btnLegacy.active = true;
                else btnCupertino.active = true;
                dropdown.selected = index;
                selfChangeMode = false;
            }

            if (isCup) {
                modeRow.subtitle = _('A complete macOS Sonoma-inspired lockscreen layout (Click user-icon to switch users).');
            } else {
                modeRow.subtitle = _('macOS Sonoma-style clock over the classic, GNOME-compliant layout and flow.');
            }

            // Always keep it expandable since both modes now have sub-settings, but do not auto-expand
            modeRow.enable_expansion = true;

            // Cupertino visibility/sensitivity
            alwaysShowUserRow.visible = isCup;
            alwaysShowUserRow.sensitive = isCup;
            promptVibrancyRow.visible = isCup;
            promptVibrancyRow.sensitive = isCup;
            messageEnableRow.visible = isCup;
            messageEnableRow.sensitive = isCup;
            unlockFadeRow.visible = isCup;
            speedRow.visible = isCup;
            refreshUnlockFadeAvailability();

            // Legacy visibility/sensitivity
            clockAnimRow.visible = !isCup;
            clockAnimRow.sensitive = !isCup;
            promptAnimRow.visible = !isCup;
            promptAnimRow.sensitive = !isCup;
            resetRow.visible = !isCup;
            resetRow.sensitive = !isCup;
        };

        const updateModeSetting = (index) => {
            const val = index === 1 ? 'cupertino' : 'wack';
            if (settings.get_string('lockscreen-mode') !== val) {
                settings.set_string('lockscreen-mode', val);
            }
        };

        btnLegacy.connect('toggled', () => { if (btnLegacy.active) updateModeSetting(0); });
        btnCupertino.connect('toggled', () => { if (btnCupertino.active) updateModeSetting(1); });

        dropdown.connect('notify::selected', () => {
            updateModeSetting(dropdown.selected);
        });

        dropdown.visible = false;
        linkedBox.visible = true;

        const cond = Adw.BreakpointCondition.parse('max-width: 450px');
        const breakpoint = new Adw.Breakpoint({ condition: cond });
        breakpoint.add_setter(linkedBox, 'visible', false);
        breakpoint.add_setter(dropdown, 'visible', true);
        breakpoint.add_setter(speedLinkedBox, 'visible', false);
        breakpoint.add_setter(speedDropdown, 'visible', true);
        window.add_breakpoint(breakpoint);

        settingsSignalIds.push(settings.connect('changed::lockscreen-mode', syncModeFromSettings));
        const shellSettingsSignalId = shellSettings.connect('changed::enabled-extensions', refreshUnlockFadeAvailability);
        cleanupCallbacks.push(() => shellSettings.disconnect(shellSettingsSignalId));

        const extensionDirs = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions']),
            '/usr/share/gnome-shell/extensions',
            '/usr/local/share/gnome-shell/extensions',
        ];

        for (const path of extensionDirs) {
            try {
                const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                const changedId = monitor.connect('changed', refreshUnlockFadeAvailability);
                cleanupCallbacks.push(() => {
                    monitor.disconnect(changedId);
                    monitor.cancel();
                });
            } catch (e) {
                // Ignore unavailable extension roots.
            }
        }

        syncModeFromSettings();

        // -- Screen Timeout options -----------------------------------------
        const timeoutGroup = new Adw.PreferencesGroup({
            title: _('Screen Timeout'),
        });

        const enableUnblankRow = new Adw.ActionRow({
            title: _('Keep Screen On'),
            subtitle: _('Prevent the screen from immediately turning off when locked. The screen will still turn off after the normal timeout duration set in system settings.'),
        });
        const enableUnblankSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('enable-unblank'),
        });
        enableUnblankSwitch.connect('notify::active', () => {
            settings.set_boolean('enable-unblank', enableUnblankSwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::enable-unblank', () => {
            enableUnblankSwitch.active = settings.get_boolean('enable-unblank');
        }));
        enableUnblankRow.add_suffix(enableUnblankSwitch);
        enableUnblankRow.activatable_widget = enableUnblankSwitch;
        timeoutGroup.add(enableUnblankRow);

        const unblankOnAcOnlyRow = new Adw.ActionRow({
            title: _('Only on AC Power'),
            subtitle: _('Only keep the screen on if the system is plugged in'),
        });
        const unblankOnAcOnlySwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('unblank-on-ac-only'),
        });
        unblankOnAcOnlySwitch.connect('notify::active', () => {
            settings.set_boolean('unblank-on-ac-only', unblankOnAcOnlySwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::unblank-on-ac-only', () => {
            unblankOnAcOnlySwitch.active = settings.get_boolean('unblank-on-ac-only');
        }));
        unblankOnAcOnlyRow.add_suffix(unblankOnAcOnlySwitch);
        unblankOnAcOnlyRow.activatable_widget = unblankOnAcOnlySwitch;
        timeoutGroup.add(unblankOnAcOnlyRow);

        const escToSleepRow = new Adw.ActionRow({
            title: _('Escape to Sleep / Suspend'),
            subtitle: _('Press Escape on the lock screen to sleep display (or suspend)'),
        });
        const escToSleepSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean('esc-to-sleep'),
        });
        escToSleepSwitch.connect('notify::active', () => {
            settings.set_boolean('esc-to-sleep', escToSleepSwitch.active);
        });
        settingsSignalIds.push(settings.connect('changed::esc-to-sleep', () => {
            escToSleepSwitch.active = settings.get_boolean('esc-to-sleep');
        }));
        escToSleepRow.add_suffix(escToSleepSwitch);
        escToSleepRow.activatable_widget = escToSleepSwitch;
        timeoutGroup.add(escToSleepRow);

        const syncSensitivity = () => {
            const enabled = settings.get_boolean('enable-unblank');
            unblankOnAcOnlyRow.sensitive = enabled;
        };
        syncSensitivity();
        settingsSignalIds.push(settings.connect('changed::enable-unblank', syncSensitivity));

        animPage.add(timeoutGroup);

        // -- Extras status group --------------------------------------------
        const extrasStatusGroup = new Adw.PreferencesGroup({
            title: _('Extras - Status'),
        });

        // -- Extras actions group -------------------------------------------
        const extrasActionsGroup = new Adw.PreferencesGroup({
            title: _('Extras - Actions'),
        });

        const gdmStatus = _getGdmStatus(this.dir);

        // Row 1: GDM Status Row
        const statusRow = new Adw.ActionRow({
            title: _('[PRO] GDM Expansion'),
        });

        const gdmStatusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
        });

        if (gdmStatus.enabled) {
            statusRow.subtitle = _('Enabled. Custom layout is active on GDM.');
            gdmStatusLabel.label = _('Enabled');
            gdmStatusLabel.add_css_class('success');
        } else {
            gdmStatusLabel.label = _('Disabled');
            gdmStatusLabel.add_css_class('error');

            let explanation = '';
            if (gdmStatus.reason === 'missing-modules') {
                explanation = _('GDM and Cross Session Module are missing.');
            } else if (gdmStatus.reason === 'missing-dconf') {
                explanation = _('GDM dconf override configuration is missing.');
            } else {
                explanation = _('GDM integration is not configured.');
            }
            statusRow.subtitle = `${_('Disabled.')} ${explanation}`;
        }
        statusRow.add_suffix(gdmStatusLabel);
        extrasStatusGroup.add(statusRow);

        // Row 2: Upgrade to Pro Row (only shown when disabled) or Uninstall Row (when enabled)
        if (!gdmStatus.enabled) {
            const upgradeRow = new Adw.ActionRow({
                title: _('Upgrade to Pro'),
                subtitle: _('Get a Sonoma-inspired GDM login screen layout and automatically synchronize your wallpapers from the active user session. To upgrade, run copied command in a terminal.'),
            });

            const copyBtn = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: _('Copy upgrade command to clipboard'),
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            copyBtn.connect('clicked', () => {
                const clipboard = Gdk.Display.get_default().get_clipboard();
                clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-gdm-dlc.sh | bash');
                window.add_toast(new Adw.Toast({
                    title: _('Copied upgrade command to clipboard!'),
                }));
            });

            upgradeRow.add_suffix(copyBtn);
            extrasActionsGroup.add(upgradeRow);
        } else {
            const uninstallRow = new Adw.ActionRow({
                title: _('Uninstall GDM Expansion'),
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
            extrasActionsGroup.add(uninstallRow);
        }

        // -- WACK Shell Integration Rows --
        const wackShellRow = new Adw.ActionRow({
            title: _('[BETA] WACK Shell Integration'),
        });
        const wackShellStatusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
        });

        const isWackShellInstalled = _isWackShellInstalled();
        if (isWackShellInstalled) {
            wackShellRow.subtitle = _('Installed. Enables crossfade transitions and Cupertino-inspired shell customisations.');
            wackShellStatusLabel.label = _('Installed');
            wackShellStatusLabel.add_css_class('success');
            wackShellRow.add_suffix(wackShellStatusLabel);
            extrasStatusGroup.add(wackShellRow);

            const checkUpdatesRow = new Adw.ActionRow({
                title: _('Check for Updates'),
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
                clipboard.set('curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-wack-shell.sh | bash -s -- --check');
                window.add_toast(new Adw.Toast({
                    title: _('Copied WACK Shell update-check command to clipboard!'),
                }));
            });

            checkUpdatesRow.add_suffix(checkBtn);
            extrasActionsGroup.add(checkUpdatesRow);
        } else {
            wackShellRow.subtitle = _('Not installed. Install WACK Shell to unlock transition effects.');
            wackShellStatusLabel.label = _('Not Installed');
            wackShellStatusLabel.add_css_class('error');
            wackShellRow.add_suffix(wackShellStatusLabel);
            extrasStatusGroup.add(wackShellRow);

            const installShellRow = new Adw.ActionRow({
                title: _('Install WACK Shell'),
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
                try {
                    Gio.AppInfo.launch_default_for_uri('https://github.com/rinzler69-wastaken/wack-shell', null);
                } catch (e) {
                    // Ignore or fallback
                }
            });

            installShellRow.add_suffix(copyBtn);
            installShellRow.add_suffix(linkBtn);
            extrasActionsGroup.add(installShellRow);
        }

        animPage.add(extrasStatusGroup);
        animPage.add(extrasActionsGroup);
        window.add(animPage);

        // Disconnect all settings signals when the window is destroyed so stale
        // closures don't hold refs to destroyed widget objects.
        window.connect('destroy', () => {
            for (const id of settingsSignalIds)
                settings.disconnect(id);
            settingsSignalIds.length = 0;

            for (const callback of cleanupCallbacks)
                callback();
            cleanupCallbacks.length = 0;
        });
    }

    _buildComboRow(settings, key, title, subtitle, options) {
        const _ = this.gettext.bind(this);
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
}
