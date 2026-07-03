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
        this._clockAlpha = null;
    }

    setClockAlpha(alpha) {
        if (this._clockAlpha === alpha)
            return;
        this._clockAlpha = alpha;
        this._saveWallpaper();
    }

    enable() {
        if (this._bgSettings)
            return; // already enabled

        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        const save = () => this._saveWallpaper();

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
        if (this._bgSettings) {
            this._bgSettings.disconnectObject(this);
            this._bgSettings = null;
        }
        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }
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

            let isColor = (style === 0);
            let isXml = uri && uri.toLowerCase().endsWith('.xml');
            let targetPath = `/var/tmp/wack-shared-wallpaper-${userName}.jpg`;

            let resolvedSlidePath = null;
            if (isXml && uri.startsWith('file://')) {
                try {
                    const srcFile = Gio.File.new_for_uri(uri);
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
                                const fileToCheck = Gio.File.new_for_path(targetPath);
                                if (!fileToCheck.query_exists(null))
                                    metadataMatches = false;
                            }
                        }
                    }
                } catch (e) {
                    _log('[WACK/CrossSession] Failed to verify existing metadata: ' + e);
                }
            }

            let success = metadataMatches;

            if (!metadataMatches && uri && uri.startsWith('file://') && !isColor) {
                let realSrcFile = null;
                if (isXml && resolvedSlidePath) {
                    realSrcFile = Gio.File.new_for_path(resolvedSlidePath);
                    _log('[WACK/CrossSession] XML slideshow: using resolved active slide path ' + resolvedSlidePath);
                } else {
                    realSrcFile = Gio.File.new_for_uri(uri);
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
                        targetPath = `/var/tmp/wack-shared-wallpaper-${userName}${srcExt}`;
                        const destFile = Gio.File.new_for_path(targetPath);
                        realSrcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                        destFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                        success = true;
                    }
                }
            }

            // Write metadata — always, to bump mtime so GDM knows who was last active.
            const metadata = {
                username: userName,
                source_uri: uri,
                resolved_slide_path: resolvedSlidePath,
                uri: (success && !isColor) ? `file://${targetPath}` : uri,
                style: style,
                primary_color: this._bgSettings.get_string('primary-color'),
                secondary_color: this._bgSettings.get_string('secondary-color'),
                shading_type: this._bgSettings.get_enum('color-shading-type'),
                is_color: isColor,
                clockFormat: this._interfaceSettings.get_string('clock-format'),
                clockAlpha: this._clockAlpha ?? 0.6,
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
}
