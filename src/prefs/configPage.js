import Adw from 'gi://Adw';
import { buildGeneralGroup } from './groups/generalGroup.js';
import { buildModeGroup } from './groups/modeGroup.js';
import { buildDisplayPowerGroup } from './groups/displayPowerGroup.js';
import { buildAppearanceGroup } from './groups/appearanceGroup.js';
import { buildExtrasGroup } from './groups/extrasGroup.js';

export function buildConfigPage(extensionPreferences, window, settings, _, settingsSignalIds, cleanupCallbacks) {
    const animPage = new Adw.PreferencesPage({
        title: _('Configuration'),
        icon_name: 'system-lock-screen-symbolic',
    });

    const { group: generalGroup, dateStyleLinkedBox, dateStyleDropdown } = buildGeneralGroup(
        settings,
        window,
        _,
        settingsSignalIds
    );
    animPage.add(generalGroup);

    animPage.add(buildAppearanceGroup(extensionPreferences, settings, _));

    const { group: modeGroup, linkedBox, dropdown, speedLinkedBox, speedDropdown } = buildModeGroup(
        settings,
        window,
        _,
        settingsSignalIds,
        cleanupCallbacks
    );
    animPage.add(modeGroup);

    const displayPowerGroup = buildDisplayPowerGroup(
        settings,
        _,
        settingsSignalIds
    );
    animPage.add(displayPowerGroup);

    const extrasGroup = buildExtrasGroup(
        extensionPreferences,
        window,
        _
    );
    animPage.add(extrasGroup);

    // Responsive breakpoint handling for linked buttons vs dropdowns
    const cond = Adw.BreakpointCondition.parse('max-width: 450px');
    const breakpoint = new Adw.Breakpoint({ condition: cond });
    breakpoint.add_setter(linkedBox, 'visible', false);
    breakpoint.add_setter(dropdown, 'visible', true);
    breakpoint.add_setter(dateStyleLinkedBox, 'visible', false);
    breakpoint.add_setter(dateStyleDropdown, 'visible', true);
    breakpoint.add_setter(speedLinkedBox, 'visible', false);
    breakpoint.add_setter(speedDropdown, 'visible', true);
    window.add_breakpoint(breakpoint);

    return animPage;
}
