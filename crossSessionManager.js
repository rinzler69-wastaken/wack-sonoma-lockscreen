import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import { resolveSlideshowXmlContent } from './constants.js';

function _log(msg) {
    console.log(msg);
}

export class CrossSessionManager {
    constructor() {
        this._bgSettings = null;
        this._interfaceSettings = null;
        this._settings = null;
        this._clockAlpha = null;
        this._promptColor = null;
    }

    setClockAlphaAndPromptColor(alpha, promptColor) {
        const isColorMatch = (c1, c2) => {
            if (!c1 && !c2) return true;
            if (!c1 || !c2) return false;
            return c1.r === c2.r && c1.g === c2.g && c1.b === c2.b;
        };
        if (this._clockAlpha === alpha && isColorMatch(this._promptColor, promptColor))
            return;
        this._clockAlpha = alpha;
        this._promptColor = promptColor;
        this._saveWallpaper();
    }


    enable() {
        if (this._bgSettings)
            return; // already enabled

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.wack-lockscreen-clock' });
        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        const save = () => this._saveWallpaper();

        this._settings.connectObject(
            'changed::prompt-vibrancy', save,
            this
        );
        this._bgSettings.connectObject(
            'changed::picture-uri', save,
            'changed::picture-uri-dark', save,
            'changed::picture-options', save,
            this
        );
        this._interfaceSettings.connectObject(
            'changed::color-scheme', save,
            'changed::clock-format', save,
            this
        );

        save();
    }

    disable() {
        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }
        if (this._bgSettings) {
            this._bgSettings.disconnectObject(this);
            this._bgSettings = null;
        }
        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }
        if (this._wallpaperFileMonitor) {
            this._wallpaperFileMonitor.cancel();
            this._wallpaperFileMonitor = null;
        }
        this._lastMonitoredUri = null;
    }

    _saveWallpaper() {
        try {
            const userName = GLib.get_user_name();
            const colorScheme = this._interfaceSettings.get_enum('color-scheme');
            const style = this._bgSettings.get_enum('picture-options');
            const uri = this._bgSettings.get_string(
                colorScheme === 1 // PREFER_DARK
                    ? 'picture-uri-dark'
                    : 'picture-uri'
            );

            if (this._lastMonitoredUri !== uri) {
                this._lastMonitoredUri = uri;
                this._updateWallpaperFileMonitor(uri);
            }

            let isColor = (style === 0);
            let isXml = uri && uri.toLowerCase().endsWith('.xml');
            
            const timestamp = Date.now();
            let targetPath = `/var/tmp/wack-shared-wallpaper-${userName}-${timestamp}.jpg`;

            let resolvedSlidePath = null;
            if (isXml && (uri.startsWith('file://') || uri.startsWith('/'))) {
                try {
                    const srcFile = uri.startsWith('file://') ? Gio.File.new_for_uri(uri) : Gio.File.new_for_path(uri);
                    if (srcFile.query_exists(null)) {
                        const [loadSuccess, contents] = srcFile.load_contents(null);
                        if (loadSuccess) {
                            const xmlText = new TextDecoder().decode(contents);
                            resolvedSlidePath = resolveSlideshowXmlContent(xmlText, colorScheme);
                        }
                    }
                } catch (xmlErr) {
                    _log('[WACK/CrossSession] Failed to parse XML slideshow: ' + xmlErr);
                }
            }

            // Check if existing wallpaper metadata matches current settings
            const metaFile = Gio.File.new_for_path(`/var/tmp/wack-shared-wallpaper-${userName}.json`);
            let metadataMatches = false;

            let srcMtime = 0;
            let srcSize = 0;
            if (uri && (uri.startsWith('file://') || uri.startsWith('/')) && !isColor) {
                let realSrcFile = null;
                if (isXml && resolvedSlidePath) {
                    realSrcFile = Gio.File.new_for_path(resolvedSlidePath);
                } else if (uri.startsWith('file://')) {
                    realSrcFile = Gio.File.new_for_uri(uri);
                } else {
                    realSrcFile = Gio.File.new_for_path(uri);
                }
                if (realSrcFile && realSrcFile.query_exists(null)) {
                    try {
                        const info = realSrcFile.query_info('time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, null);
                        srcMtime = info.get_attribute_uint64('time::modified');
                        srcSize = info.get_attribute_uint64('standard::size');
                    } catch (e) {
                        // ignore
                    }
                }
            }

            if (metaFile.query_exists(null)) {
                try {
                    const [loadSuccess, contents] = metaFile.load_contents(null);
                    if (loadSuccess) {
                        const existingMetadata = JSON.parse(new TextDecoder().decode(contents));
                        const currentPrimary = this._bgSettings.get_string('primary-color');
                        const currentSecondary = this._bgSettings.get_string('secondary-color');
                        const currentShading = this._bgSettings.get_enum('color-shading-type');

                        if (existingMetadata &&
                            existingMetadata.source_uri === uri &&
                            existingMetadata.source_mtime === srcMtime &&
                            existingMetadata.source_size === srcSize &&
                            existingMetadata.style === style &&
                            existingMetadata.primary_color === currentPrimary &&
                            existingMetadata.secondary_color === currentSecondary &&
                            existingMetadata.shading_type === currentShading) {

                            if (isXml) {
                                if (existingMetadata.resolved_slide_path === resolvedSlidePath)
                                    metadataMatches = true;
                            } else {
                                metadataMatches = true;
                            }

                            if (metadataMatches && !isColor) {
                                if (existingMetadata.uri) {
                                    const pathToCheck = existingMetadata.uri.startsWith('file://')
                                        ? existingMetadata.uri.substring(7)
                                        : existingMetadata.uri;
                                    const fileToCheck = Gio.File.new_for_path(pathToCheck);
                                    if (fileToCheck.query_exists(null)) {
                                        targetPath = pathToCheck;
                                    } else {
                                        metadataMatches = false;
                                    }
                                } else {
                                    metadataMatches = false;
                                }
                            }
                        }
                    }
                } catch (e) {
                    _log('[WACK/CrossSession] Failed to verify existing metadata: ' + e);
                }
            }

            let success = metadataMatches;

            if (!metadataMatches) {
                // Delete old wallpaper files for this user to avoid filling /var/tmp
                const dir = Gio.File.new_for_path('/var/tmp');
                if (dir.query_exists(null)) {
                    try {
                        const enumerator = dir.enumerate_children(
                            'standard::name',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );
                        let info;
                        while ((info = enumerator.next_file(null)) !== null) {
                            const name = info.get_name();
                            if (name.startsWith(`wack-shared-wallpaper-${userName}-`) &&
                                (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png'))) {
                                try {
                                    const oldFile = Gio.File.new_for_path(`/var/tmp/${name}`);
                                    oldFile.delete(null);
                                } catch (e) {
                                    // ignore
                                }
                            }
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                if (uri && (uri.startsWith('file://') || uri.startsWith('/')) && !isColor) {
                    let realSrcFile = null;
                    if (isXml && resolvedSlidePath) {
                        realSrcFile = Gio.File.new_for_path(resolvedSlidePath);
                        _log('[WACK/CrossSession] XML slideshow: using resolved active slide path ' + resolvedSlidePath);
                    } else if (uri.startsWith('file://')) {
                        realSrcFile = Gio.File.new_for_uri(uri);
                    } else {
                        realSrcFile = Gio.File.new_for_path(uri);
                    }

                    if (realSrcFile && realSrcFile.query_exists(null)) {
                        try {
                            const srcPath = realSrcFile.get_path();
                            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(srcPath);
                            const w = pixbuf.get_width();
                            const h = pixbuf.get_height();

                            const MAX_DIM = 2560;
                            let scaleW = w;
                            let scaleH = h;
                            if (w > MAX_DIM || h > MAX_DIM) {
                                if (w > h) {
                                    scaleW = MAX_DIM;
                                    scaleH = Math.round((h * MAX_DIM) / w);
                                } else {
                                    scaleH = MAX_DIM;
                                    scaleW = Math.round((w * MAX_DIM) / h);
                                }
                            }

                            const scaled = pixbuf.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR);
                            scaled.savev(targetPath, 'jpeg', ['quality'], ['80']);

                            const destFile = Gio.File.new_for_path(targetPath);
                            destFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                            success = true;
                            _log('[WACK/CrossSession] Successfully optimized and saved resolved wallpaper JPEG');
                        } catch (err) {
                            _log('[WACK/CrossSession] Fallback to direct copy due to GdkPixbuf error: ' + err);
                            const srcPath = realSrcFile.get_path();
                            let srcExt = '.jpg';
                            const lastDot = srcPath.lastIndexOf('.');
                            if (lastDot !== -1)
                                srcExt = srcPath.substring(lastDot);
                            targetPath = `/var/tmp/wack-shared-wallpaper-${userName}-${timestamp}${srcExt}`;
                            const destFile = Gio.File.new_for_path(targetPath);
                            realSrcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                            destFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                            success = true;
                        }
                    }
                }
            }

            // Write metadata — always, to bump mtime so GDM knows who was last active.
            const metadata = {
                username: userName,
                source_uri: uri,
                source_mtime: srcMtime,
                source_size: srcSize,
                resolved_slide_path: resolvedSlidePath,
                uri: (success && !isColor) ? `file://${targetPath}` : uri,
                style: style,
                primary_color: this._bgSettings.get_string('primary-color'),
                secondary_color: this._bgSettings.get_string('secondary-color'),
                shading_type: this._bgSettings.get_enum('color-shading-type'),
                is_color: isColor,
                clockFormat: this._interfaceSettings.get_string('clock-format'),
                clockAlpha: this._clockAlpha ?? 0.6,
                promptColor: this._promptColor,
                promptVibrancy: this._settings ? this._settings.get_boolean('prompt-vibrancy') : true,
            };

            metaFile.replace_contents(
                JSON.stringify(metadata),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            metaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            _log('[WACK/CrossSession] Failed to save wallpaper: ' + e);
        }
    }

    _updateWallpaperFileMonitor(uri) {
        if (this._wallpaperFileMonitor) {
            this._wallpaperFileMonitor.cancel();
            this._wallpaperFileMonitor = null;
        }

        if (!uri || uri === '')
            return;

        try {
            let file = null;
            if (uri.startsWith('file://')) {
                file = Gio.File.new_for_uri(uri);
            } else if (uri.startsWith('/')) {
                file = Gio.File.new_for_path(uri);
            }

            if (file && file.query_exists(null)) {
                this._wallpaperFileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                this._wallpaperFileMonitor.connect('changed', (_monitor, _file, _other, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CHANGED ||
                        eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        _log('[WACK/CrossSession] Wallpaper file modified on disk, triggering save');
                        this._saveWallpaper();
                    }
                });
            }
        } catch (e) {
            _log('[WACK/CrossSession] Failed to monitor wallpaper file: ' + e);
        }
    }
}

