import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { CLOCK_ANIMATION_OPTIONS, PROMPT_ANIMATION_OPTIONS } from '../../main/anims.js';
import { isWackShellInstalled, isWackShellEnabled, buildComboRow } from '../prefsUtils.js';

export function buildModeGroup(settings, window, _, settingsSignalIds, cleanupCallbacks) {
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
        subtitle: _('Adaptive color and depth enhancements for the password field.'),
    });

    const promptVibrancyBox = new Gtk.Box({ valign: Gtk.Align.CENTER });

    const promptVibrancyLinkedBox = new Gtk.Box({ css_classes: ['linked'] });
    const btnVibrancyTonal = new Gtk.ToggleButton({ label: _('Tonal') });
    const btnVibrancyAcrylic = new Gtk.ToggleButton({ label: _('Acrylic'), group: btnVibrancyTonal, active: true });
    promptVibrancyLinkedBox.append(btnVibrancyTonal);
    promptVibrancyLinkedBox.append(btnVibrancyAcrylic);

    const promptVibrancyDropdown = new Gtk.DropDown({
        valign: Gtk.Align.CENTER,
        model: Gtk.StringList.new([_('Tonal'), _('Acrylic')]),
        selected: 0,
    });

    promptVibrancyBox.append(promptVibrancyLinkedBox);
    promptVibrancyBox.append(promptVibrancyDropdown);
    promptVibrancyRow.add_suffix(promptVibrancyBox);

    let selfChangeVibrancy = false;
    const baseSubtitle = _('Adaptive color and depth enhancements for the password field.');
    const updateVibrancySubtitle = (val) => {
        const isTonal = (val === 'tonal' || val === 'less');
        const detail = isTonal
            ? _('Lightweight, color-based mode.')
            : _('Advanced, blur-based mode.');
        promptVibrancyRow.subtitle = `${baseSubtitle} ${detail}`;
    };

    const syncVibrancyButtons = () => {
        const val = settings.get_string('prompt-vibrancy') || 'tonal';
        selfChangeVibrancy = true;
        btnVibrancyTonal.active = (val === 'tonal' || val === 'less');
        btnVibrancyAcrylic.active = (val !== 'tonal' && val !== 'less');
        promptVibrancyDropdown.selected = (val === 'tonal' || val === 'less') ? 0 : 1;
        updateVibrancySubtitle(val);
        selfChangeVibrancy = false;
    };
    syncVibrancyButtons();

    btnVibrancyTonal.connect('toggled', () => {
        if (selfChangeVibrancy || !btnVibrancyTonal.active) return;
        selfChangeVibrancy = true;
        settings.set_string('prompt-vibrancy', 'tonal');
        promptVibrancyDropdown.selected = 0;
        updateVibrancySubtitle('tonal');
        selfChangeVibrancy = false;
    });
    btnVibrancyAcrylic.connect('toggled', () => {
        if (selfChangeVibrancy || !btnVibrancyAcrylic.active) return;
        selfChangeVibrancy = true;
        settings.set_string('prompt-vibrancy', 'acrylic');
        promptVibrancyDropdown.selected = 1;
        updateVibrancySubtitle('acrylic');
        selfChangeVibrancy = false;
    });
    promptVibrancyDropdown.connect('notify::selected', () => {
        if (selfChangeVibrancy) return;
        selfChangeVibrancy = true;
        const val = promptVibrancyDropdown.selected === 0 ? 'tonal' : 'acrylic';
        settings.set_string('prompt-vibrancy', val);
        btnVibrancyTonal.active = (val === 'tonal' || val === 'less');
        btnVibrancyAcrylic.active = (val !== 'tonal' && val !== 'less');
        updateVibrancySubtitle(val);
        selfChangeVibrancy = false;
    });

    settingsSignalIds.push(settings.connect('changed::prompt-vibrancy', () => {
        if (!selfChangeVibrancy) syncVibrancyButtons();
    }));

    promptVibrancyDropdown.visible = false;
    promptVibrancyLinkedBox.visible = true;
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

    let selfChangeUnlockFade = false;

    unlockFadeSwitch.connect('notify::active', () => {
        if (selfChangeUnlockFade) return;
        settings.set_boolean('cupertino-unlock-fade', unlockFadeSwitch.active);
        refreshUnlockFadeAvailability();
    });
    settingsSignalIds.push(settings.connect('changed::cupertino-unlock-fade', () => {
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
    const clockAnimRow = buildComboRow(
        settings,
        'clock-animation',
        _('Clock Animation'),
        _('Applied to the date and time while opening the password prompt'),
        CLOCK_ANIMATION_OPTIONS,
        _
    );

    const promptAnimRow = buildComboRow(
        settings,
        'prompt-animation',
        _('Prompt Animation'),
        _('Applied to the authentication prompt while it appears'),
        PROMPT_ANIMATION_OPTIONS,
        _
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

    let selfChangeMode = false;
    function refreshUnlockFadeAvailability() {
        const isCup = settings.get_string('lockscreen-mode') === 'cupertino';
        const wackShellInstalled = isWackShellInstalled();
        const wackShellEnabled = isWackShellEnabled();

        let subtitleText = _('Crossfade the lockscreen with desktop when unlocking (automatically disabled in Power Saver mode).');
        if (!wackShellInstalled)
            subtitleText += ' ' + _('Requires WACK Shell to be installed and enabled.');
        else if (!wackShellEnabled)
            subtitleText += ' ' + _('Requires WACK Shell to be enabled.');

        unlockFadeRow.subtitle = subtitleText;
        const available = isCup && wackShellInstalled && wackShellEnabled;
        unlockFadeRow.sensitive = available;

        const persistedFade = settings.get_boolean('cupertino-unlock-fade');
        selfChangeUnlockFade = true;
        unlockFadeSwitch.active = available ? persistedFade : false;
        selfChangeUnlockFade = false;

        const showSpeed = isCup && available && persistedFade;
        speedRow.visible = showSpeed;
        speedRow.sensitive = showSpeed;
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

    settingsSignalIds.push(settings.connect('changed::lockscreen-mode', syncModeFromSettings));

    const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
    const shellSettingsSignalId = shellSettings.connect('changed::enabled-extensions', refreshUnlockFadeAvailability);
    cleanupCallbacks.push(() => shellSettings.disconnect(shellSettingsSignalId));

    const extensionDirs = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions']),
        '/usr/share/gnome-shell/extensions',
        '/usr/local/share/gnome-shell/extensions',
    ];

    for (const path of extensionDirs) {
        const dir = Gio.File.new_for_path(path);
        if (!dir.query_exists(null))
            continue;
        const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        const changedId = monitor.connect('changed', refreshUnlockFadeAvailability);
        cleanupCallbacks.push(() => {
            monitor.disconnect(changedId);
            monitor.cancel();
        });
    }

    syncModeFromSettings();

    return {
        group: modeGroup,
        linkedBox,
        dropdown,
        speedLinkedBox,
        speedDropdown,
    };
}
