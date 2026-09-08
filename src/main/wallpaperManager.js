import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PROMPT_BLUR_RADIUS, PROMPT_BLUR_BRIGHTNESS } from './constants.js';

export class WallpaperManager {
    constructor(extension) {
        this._extension = extension;
        this.customWallpaperOverlay = null;
    }

    updateCustomWallpaperOverlay() {
        const settings = this._extension._settings;
        const enabled = settings?.get_boolean('lockscreen-wallpaper-enable') ?? false;
        const path = settings?.get_string('lockscreen-wallpaper-path') ?? '';
        const fileExists = path !== '' && Gio.File.new_for_path(path).query_exists(null);

        const dialog = this._extension._dialog;
        if (!dialog)
            return;

        if (enabled && fileExists) {
            const uri = path.startsWith('file://') ? path : `file://${path}`;
            const styleStr = `background-image: url("${uri}"); background-size: cover; background-position: center; background-repeat: no-repeat;`;

            if (!this.customWallpaperOverlay) {
                this.customWallpaperOverlay = new Clutter.Actor({ opacity: 255 });

                for (const monitor of Main.layoutManager.monitors) {
                    const widget = new St.Widget({
                        style_class: 'screen-shield-background',
                        x: monitor.x,
                        y: monitor.y,
                        width: monitor.width,
                        height: monitor.height,
                        effect: new Shell.BlurEffect({ name: 'blur' }),
                    });
                    const effect = widget.get_effect('blur');
                    if (effect)
                        effect.set({ brightness: 1.0, radius: 0 });
                    widget.set_style(styleStr);
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
            } else {
                for (const child of this.customWallpaperOverlay.get_children())
                    child.set_style(styleStr);
                this.customWallpaperOverlay.opacity = 255;
                this.customWallpaperOverlay.visible = true;
            }
        } else {
            if (this.customWallpaperOverlay) {
                this.customWallpaperOverlay.destroy();
                this.customWallpaperOverlay = null;
            }
        }
    }

    setCustomWallpaperBlur(radius, brightness) {
        for (const widget of this.customWallpaperOverlay?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            if (effect)
                effect.set({ radius, brightness });
        }
    }

    teardown() {
        if (this.customWallpaperOverlay) {
            this.customWallpaperOverlay.destroy();
            this.customWallpaperOverlay = null;
        }
    }
}
