import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { buildHomePage } from './src/prefs/homePage.js';
import { buildConfigPage } from './src/prefs/configPage.js';

export default class WackLockscreenClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();
        const settingsSignalIds = [];
        const cleanupCallbacks = [];

        // Set default window size (width, height)
        window.set_default_size(700, 800);

        const homePage = buildHomePage(this, window, _);
        window.add(homePage);

        const configPage = buildConfigPage(
            this,
            window,
            settings,
            _,
            settingsSignalIds,
            cleanupCallbacks
        );
        window.add(configPage);

        // Disconnect all settings signals and run directory monitor cleanups
        // when the window is destroyed, preventing stale closures.
        window.connect('destroy', () => {
            for (const id of settingsSignalIds)
                settings.disconnect(id);
            settingsSignalIds.length = 0;

            for (const callback of cleanupCallbacks)
                callback();
            cleanupCallbacks.length = 0;
        });
    }
}
