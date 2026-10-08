import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PROMPT_BLUR_RADIUS, PROMPT_BLUR_BRIGHTNESS } from './constants.js';
import { resolveSlideshowXml } from './wallpaperUtils.js';

export class WallpaperManager {
    constructor(extension) {
        this._extension = extension;
        this.customWallpaperOverlay = null;
        this._updateSeq = 0;
        this._refreshId = 0;
    }

    /**
     * Wallpaper path configured for a monitor: its per-monitor entry (keyed by
     * connector) or the global custom path. May be an image or a slideshow XML.
     * @param {number} monitorIndex
     * @returns {string}
     */
    getPathForMonitor(monitorIndex) {
        const settings = this._extension._settings;
        if (!settings)
            return '';

        const perMonitor = settings.get_value('lockscreen-wallpaper-monitors').deepUnpack();
        const monitorManager = global.backend.get_monitor_manager();
        for (const [connector, path] of Object.entries(perMonitor)) {
            if (path && monitorManager.get_monitor_for_connector(connector) === monitorIndex)
                return path;
        }
        return settings.get_string('lockscreen-wallpaper-path');
    }

    /**
     * Resolves a configured path to the image to display now. Slideshow XML
     * (e.g. time-of-day wallpapers) resolves to its current slide.
     * @returns {Promise<{file: string, nextChangeSec: number|null}|null>}
     */
    async _resolveDisplayImage(path) {
        if (!path || !Gio.File.new_for_path(path).query_exists(null))
            return null;
        if (!path.toLowerCase().endsWith('.xml'))
            return { file: path, nextChangeSec: null };

        const slide = await resolveSlideshowXml(path);
        if (!slide?.filePath)
            return null;

        // The slide flips at the midpoint of a transition and at the end of a static.
        let nextChangeSec = slide.remainingDuration ?? null;
        if (slide.isTransition && slide.progress < 0.5)
            nextChangeSec = (0.5 - slide.progress) * slide.duration;
        return { file: slide.filePath, nextChangeSec };
    }

    async updateCustomWallpaperOverlay() {
        const seq = ++this._updateSeq;
        this._stopRefresh();

        const enabled = this._extension._settings?.get_boolean('lockscreen-wallpaper-enable') ?? false;
        const monitors = Main.layoutManager.monitors;
        const images = enabled
            ? await Promise.all(monitors.map(m => this._resolveDisplayImage(this.getPathForMonitor(m.index))))
            : [];

        const dialog = this._extension._dialog;
        if (seq !== this._updateSeq || !dialog)
            return;

        if (!images.some(Boolean)) {
            this.teardown();
            return;
        }

        if (this.customWallpaperOverlay?.get_n_children() !== monitors.length)
            this._destroyOverlay();

        if (!this.customWallpaperOverlay) {
            this.customWallpaperOverlay = new Clutter.Actor({ opacity: 255 });
            for (const monitor of monitors) {
                const widget = new St.Widget({
                    style_class: 'screen-shield-background',
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    effect: new Shell.BlurEffect({ name: 'blur' }),
                });
                widget.get_effect('blur')?.set({ brightness: 1.0, radius: 0 });
                this.customWallpaperOverlay.add_child(widget);
            }

            dialog.add_child(this.customWallpaperOverlay);
            if (dialog._backgroundGroup)
                dialog.set_child_above_sibling(this.customWallpaperOverlay, dialog._backgroundGroup);

            const progress = dialog._adjustment?.value ?? 0;
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const isCupertino = this._extension._lockscreenMode === 'cupertino';
            this.setCustomWallpaperBlur(
                isCupertino ? 0 : PROMPT_BLUR_RADIUS * scaleFactor * progress,
                isCupertino ? 1.0 : 1.0 - (1.0 - PROMPT_BLUR_BRIGHTNESS) * progress
            );
        }

        this.customWallpaperOverlay.get_children().forEach((widget, i) => {
            // Monitors without a usable image show the system background beneath.
            widget.visible = !!images[i];
            if (images[i]) {
                const uri = Gio.File.new_for_path(images[i].file).get_uri();
                widget.set_style(`background-image: url("${uri}"); background-size: cover; background-position: center; background-repeat: no-repeat;`);
            }
        });
        this.customWallpaperOverlay.opacity = 255;
        this.customWallpaperOverlay.visible = true;

        const changes = images.map(img => img?.nextChangeSec).filter(sec => sec != null);
        if (changes.length > 0)
            this._armRefresh(Math.min(...changes));
    }

    // ponytail: slides snap at the transition midpoint instead of cross-blending.
    _armRefresh(seconds) {
        const delayMs = Math.round(Math.max(1, Math.min(3600, seconds + 0.5)) * 1000);
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._refreshId = 0;
            this.updateCustomWallpaperOverlay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    setCustomWallpaperBlur(radius, brightness) {
        for (const widget of this.customWallpaperOverlay?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            if (effect)
                effect.set({ radius, brightness });
        }
    }

    _destroyOverlay() {
        if (this.customWallpaperOverlay) {
            this.customWallpaperOverlay.destroy();
            this.customWallpaperOverlay = null;
        }
    }

    teardown() {
        this._updateSeq++;
        this._stopRefresh();
        this._destroyOverlay();
    }
}
