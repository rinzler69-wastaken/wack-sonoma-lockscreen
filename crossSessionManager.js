import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import { resolveSlideshowXmlContent } from './src/main/constants.js';
import { blendPixbufs } from './src/main/wallpaperUtils.js';
import { _log, _logError } from './src/main/mainUtils.js';

function loadContentsAsync(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [success, contents, etag] = f.load_contents_finish(res);
                if (success)
                    resolve([contents, etag]);
                else
                    reject(new Error('Failed to load file contents'));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function queryInfoAsync(file, attributes, flags = Gio.FileQueryInfoFlags.NONE, ioPriority = GLib.PRIORITY_DEFAULT, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, flags, ioPriority, cancellable, (f, res) => {
            try {
                const info = f.query_info_finish(res);
                resolve(info);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function replaceContentsAsync(file, contents, etag = null, makeBackup = false, flags = Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.replace_contents_async(contents, etag, makeBackup, flags, cancellable, (f, res) => {
            try {
                const [success, newEtag] = f.replace_contents_finish(res);
                if (success)
                    resolve([success, newEtag]);
                else
                    reject(new Error('Failed to replace file contents'));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function enumerateChildrenAsync(file, attributes, flags = Gio.FileQueryInfoFlags.NONE, ioPriority = GLib.PRIORITY_DEFAULT, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.enumerate_children_async(attributes, flags, ioPriority, cancellable, (f, res) => {
            try {
                const enumerator = f.enumerate_children_finish(res);
                resolve(enumerator);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function nextFilesAsync(enumerator, numFiles, ioPriority = GLib.PRIORITY_DEFAULT, cancellable = null) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(numFiles, ioPriority, cancellable, (e, res) => {
            try {
                const files = e.next_files_finish(res);
                resolve(files);
            } catch (err) {
                reject(err);
            }
        });
    });
}

export class CrossSessionManager {
    constructor(extensionSettings) {
        this._bgSettings = null;
        this._interfaceSettings = null;
        this._settings = extensionSettings;
        this._clockAlpha = null;
        this._promptColor = null;
        this._inactiveClockAlpha = null;
        this._inactivePromptColor = null;
        this._wallpaperFileMonitor = null;
        this._wallpaperFileMonitorId = 0;
        this._lastMonitoredUri = null;

        this._saving = false;
        this._saveRequested = false;
        this._dirty = false;
    }

    setClockAlphaAndPromptColor(alpha, promptColor, inactiveClockAlpha = null, inactivePromptColor = null) {
        const isColorMatch = (c1, c2) => {
            if (!c1 && !c2) return true;
            if (!c1 || !c2) return false;
            if (c1.r !== c2.r || c1.g !== c2.g || c1.b !== c2.b) return false;
            if (c1.useInverse !== c2.useInverse) return false;
            if (c1.vibrancyMode !== c2.vibrancyMode) return false;
            if (c1.start && c2.start) {
                if (c1.start.r !== c2.start.r || c1.start.g !== c2.start.g || c1.start.b !== c2.start.b) return false;
                if (c1.end.r !== c2.end.r || c1.end.g !== c2.end.g || c1.end.b !== c2.end.b) return false;
                if (c1.direction !== c2.direction) return false;
            } else if (c1.start || c2.start) {
                return false;
            }
            if (c1.imagePath !== c2.imagePath) return false;
            if (c1.cancelImagePath !== c2.cancelImagePath) return false;
            if (c1.cancelColor && c2.cancelColor) {
                if (c1.cancelColor.r !== c2.cancelColor.r || c1.cancelColor.g !== c2.cancelColor.g || c1.cancelColor.b !== c2.cancelColor.b) return false;
                if (c1.cancelColor.rgba !== c2.cancelColor.rgba) return false;
                if (c1.cancelColor.useInverse !== c2.cancelColor.useInverse) return false;
            } else if (c1.cancelColor || c2.cancelColor) {
                return false;
            }
            if (c1.avatarColor && c2.avatarColor) {
                if (c1.avatarColor.r !== c2.avatarColor.r || c1.avatarColor.g !== c2.avatarColor.g || c1.avatarColor.b !== c2.avatarColor.b) return false;
                if (c1.avatarColor.rgba !== c2.avatarColor.rgba) return false;
                if (c1.avatarColor.useInverse !== c2.avatarColor.useInverse) return false;
            } else if (c1.avatarColor || c2.avatarColor) {
                return false;
            }
            if (c1.a11yColor && c2.a11yColor) {
                if (c1.a11yColor.r !== c2.a11yColor.r || c1.a11yColor.g !== c2.a11yColor.g || c1.a11yColor.b !== c2.a11yColor.b) return false;
                if (c1.a11yColor.rgba !== c2.a11yColor.rgba) return false;
                if (c1.a11yColor.useInverse !== c2.a11yColor.useInverse) return false;
            } else if (c1.a11yColor || c2.a11yColor) {
                return false;
            }
            if (c1.sessionColor && c2.sessionColor) {
                if (c1.sessionColor.r !== c2.sessionColor.r || c1.sessionColor.g !== c2.sessionColor.g || c1.sessionColor.b !== c2.sessionColor.b) return false;
                if (c1.sessionColor.rgba !== c2.sessionColor.rgba) return false;
                if (c1.sessionColor.useInverse !== c2.sessionColor.useInverse) return false;
            } else if (c1.sessionColor || c2.sessionColor) {
                return false;
            }
            return true;
        };
        const userName = GLib.get_user_name();
        const SHARED_DIR = '/var/tmp/wack/shared';
        const metaFile = Gio.File.new_for_path(`${SHARED_DIR}/wack-shared-wallpaper-${userName}.json`);

        if (this._clockAlpha === alpha && isColorMatch(this._promptColor, promptColor) && metaFile.query_exists(null))
            return;
        this._clockAlpha = alpha;
        this._promptColor = promptColor;
        this._inactiveClockAlpha = inactiveClockAlpha;
        this._inactivePromptColor = inactivePromptColor;
        this._triggerSave();
    }

    enable() {
        if (this._bgSettings)
            return;

        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        const save = () => this._triggerSave();

        this._settings.connectObject(
            'changed::prompt-vibrancy', save,
            'changed::cursor-blink', save,
            'changed::lockscreen-mode', save,
            'changed::cupertino-lockscreen-message-enable', save,
            'changed::cupertino-lockscreen-message-text', save,
            'changed::lockscreen-wallpaper-enable', save,
            'changed::lockscreen-wallpaper-path', save,
            'changed::date-style', save,
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

        this._triggerSave();
    }

    disable() {
        if (this._settings) {
            this._settings.disconnectObject(this);
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
            if (this._wallpaperFileMonitorId) {
                this._wallpaperFileMonitor.disconnect(this._wallpaperFileMonitorId);
                this._wallpaperFileMonitorId = 0;
            }
            this._wallpaperFileMonitor.cancel();
            this._wallpaperFileMonitor = null;
        }
        this._lastMonitoredUri = null;
        this._saving = false;
        this._saveRequested = false;
        this._dirty = false;
    }

    _triggerSave() {
        this._dirty = true;
        if (this._saving) {
            this._saveRequested = true;
            return;
        }
        this._flushSave();
    }

    async _flushSave() {
        if (this._saving)
            return;

        this._saving = true;
        this._dirty = false;
        this._saveRequested = false;

        try {
            await this._saveWallpaperAsync();
        } catch (e) {
            _logError(`[WACK/CrossSession] Failed in _saveWallpaperAsync: ${e}`);
        } finally {
            this._saving = false;
            if (this._saveRequested || this._dirty) {
                this._flushSave();
            }
        }
    }

    async _processVariant(uri, variantTag, timestamp, colorScheme, existingVariant, isColor) {
        if (!uri || isColor) {
            return {
                source_uri: uri,
                source_mtime: 0,
                source_size: 0,
                uri: uri,
                target_path: null,
                slideshow_xml_text: null,
                resolved_slide_path: null,
                resolved_slide_progress: 0.0,
                is_color: isColor,
            };
        }

        const SHARED_DIR = '/var/tmp/wack/shared';
        const userName = GLib.get_user_name();
        const isXml = uri && uri.toLowerCase().endsWith('.xml');
        let targetPath = `${SHARED_DIR}/wack-shared-wallpaper-${userName}-${variantTag}-${timestamp}.jpg`;

        let resolvedSlidePath = null;
        let resolvedSlideInfo = null;
        let slideshowXmlText = null;

        if (isXml && (uri.startsWith('file://') || uri.startsWith('/'))) {
            try {
                const srcFile = uri.startsWith('file://') ? Gio.File.new_for_uri(uri) : Gio.File.new_for_path(uri);
                if (srcFile.query_exists(null)) {
                    const [contents] = await loadContentsAsync(srcFile);
                    if (contents) {
                        const xmlText = new TextDecoder().decode(contents);
                        slideshowXmlText = xmlText;
                        const resolved = resolveSlideshowXmlContent(xmlText, colorScheme);
                        if (resolved) {
                            if (typeof resolved === 'string') {
                                resolvedSlidePath = resolved;
                                resolvedSlideInfo = { filePath: resolved, isTransition: false, from: resolved, to: resolved, progress: 0.0 };
                            } else {
                                resolvedSlidePath = resolved.filePath;
                                resolvedSlideInfo = resolved;
                            }
                        }
                    }
                }
            } catch (xmlErr) {
                _log(`[WACK/CrossSession] Failed to parse XML slideshow (${variantTag}): ${xmlErr}`);
            }
        }

        const currentSlideProgress = resolvedSlideInfo?.isTransition
            ? Math.round((resolvedSlideInfo.progress ?? 0) * 100) / 100
            : 0.0;

        let srcMtime = 0;
        let srcSize = 0;
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
                const info = await queryInfoAsync(realSrcFile, 'time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
                srcMtime = info.get_attribute_uint64('time::modified');
                srcSize = info.get_attribute_uint64('standard::size');
            } catch (_) {}
        }

        let metadataMatches = false;
        if (existingVariant) {
            if (existingVariant.source_uri === uri &&
                existingVariant.source_mtime === srcMtime &&
                existingVariant.source_size === srcSize) {
                if (isXml) {
                    if (existingVariant.resolved_slide_path === resolvedSlidePath &&
                        (existingVariant.resolved_slide_progress ?? 0.0) === currentSlideProgress)
                        metadataMatches = true;
                } else {
                    metadataMatches = true;
                }

                if (metadataMatches && existingVariant.uri) {
                    const pathToCheck = existingVariant.uri.startsWith('file://')
                        ? existingVariant.uri.substring(7)
                        : existingVariant.uri;
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

        let success = metadataMatches;
        if (!metadataMatches) {
            if (isXml && resolvedSlideInfo?.isTransition && resolvedSlideInfo.from && resolvedSlideInfo.to) {
                try {
                    const fileFrom = Gio.File.new_for_path(resolvedSlideInfo.from);
                    const fileTo = Gio.File.new_for_path(resolvedSlideInfo.to);
                    if (fileFrom.query_exists(null) && fileTo.query_exists(null)) {
                        const pbFrom = GdkPixbuf.Pixbuf.new_from_file(resolvedSlideInfo.from);
                        const pbTo = GdkPixbuf.Pixbuf.new_from_file(resolvedSlideInfo.to);
                        const MAX_DIM = 2560;

                        const w = pbFrom.get_width();
                        const h = pbFrom.get_height();
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

                        const scaledFrom = (scaleW !== w || scaleH !== h)
                            ? pbFrom.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR)
                            : pbFrom;
                        const scaledTo = (scaleW !== pbTo.get_width() || scaleH !== pbTo.get_height())
                            ? pbTo.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR)
                            : pbTo;

                        const blended = blendPixbufs(scaledFrom, scaledTo, resolvedSlideInfo.progress);
                        if (blended) {
                            const tmpTargetPath = `${targetPath}.tmp.${GLib.random_int()}`;
                            blended.savev(tmpTargetPath, 'jpeg', ['quality'], ['80']);
                            const tmpDestFile = Gio.File.new_for_path(tmpTargetPath);
                            tmpDestFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                            const finalDestFile = Gio.File.new_for_path(targetPath);
                            tmpDestFile.move(finalDestFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                            success = true;
                            _log(`[WACK/CrossSession] Successfully blended and saved transition wallpaper JPEG (${variantTag})`);
                        }
                    }
                } catch (blendErr) {
                    _log(`[WACK/CrossSession] Fallback from transition blend error (${variantTag}): ${blendErr}`);
                }
            }

            if (!success && realSrcFile && realSrcFile.query_exists(null)) {
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

                    const scaled = (scaleW !== w || scaleH !== h)
                        ? pixbuf.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR)
                        : pixbuf;

                    const tmpTargetPath = `${targetPath}.tmp.${GLib.random_int()}`;
                    scaled.savev(tmpTargetPath, 'jpeg', ['quality'], ['80']);
                    const tmpDestFile = Gio.File.new_for_path(tmpTargetPath);
                    tmpDestFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                    const finalDestFile = Gio.File.new_for_path(targetPath);
                    tmpDestFile.move(finalDestFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                    success = true;
                    _log(`[WACK/CrossSession] Successfully optimized and saved wallpaper JPEG (${variantTag})`);
                } catch (err) {
                    _log(`[WACK/CrossSession] Fallback to direct copy due to GdkPixbuf error (${variantTag}): ${err}`);
                    try {
                        const srcPath = realSrcFile.get_path();
                        let srcExt = '.jpg';
                        const lastDot = srcPath.lastIndexOf('.');
                        if (lastDot !== -1)
                            srcExt = srcPath.substring(lastDot);
                        targetPath = `${SHARED_DIR}/wack-shared-wallpaper-${userName}-${variantTag}-${timestamp}${srcExt}`;
                        const destFile = Gio.File.new_for_path(targetPath);
                        realSrcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                        destFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                        success = true;
                    } catch (_) {}
                }
            }
        }

        return {
            source_uri: uri,
            source_mtime: srcMtime,
            source_size: srcSize,
            uri: success ? `file://${targetPath}` : uri,
            target_path: success ? targetPath : null,
            slideshow_xml_text: slideshowXmlText,
            resolved_slide_path: resolvedSlidePath,
            resolved_slide_progress: currentSlideProgress,
            is_color: false,
            metadataMatches,
        };
    }

    async _saveWallpaperAsync() {
        const SHARED_DIR = '/var/tmp/wack/shared';
        const LEGACY_SHARED_DIR = '/var/tmp';

        for (const dPath of ['/var/tmp/wack', SHARED_DIR]) {
            try {
                const d = Gio.File.new_for_path(dPath);
                if (!d.query_exists(null)) {
                    d.make_directory_with_parents(null);
                    d.set_attribute_uint32('unix::mode', 0o1777, Gio.FileQueryInfoFlags.NONE, null);
                }
            } catch (_) {}
        }

        if (!this._interfaceSettings || !this._bgSettings)
            return;

        const userName = GLib.get_user_name();
        const activeColorScheme = this._interfaceSettings.get_enum('color-scheme');
        const style = this._bgSettings.get_enum('picture-options');
        const isColor = (style === 0);

        const customWallpaperEnabled = this._settings ? this._settings.get_boolean('lockscreen-wallpaper-enable') : false;
        const customWallpaperPath = this._settings ? this._settings.get_string('lockscreen-wallpaper-path') : '';

        let lightUri, darkUri;
        if (customWallpaperEnabled && customWallpaperPath && Gio.File.new_for_path(customWallpaperPath).query_exists(null)) {
            const customUri = customWallpaperPath.startsWith('file://') ? customWallpaperPath : `file://${customWallpaperPath}`;
            lightUri = customUri;
            darkUri = customUri;
        } else {
            lightUri = this._bgSettings.get_string('picture-uri');
            darkUri = this._bgSettings.get_string('picture-uri-dark');
            if (!darkUri) darkUri = lightUri;
            if (!lightUri) lightUri = darkUri;
        }

        const activeUri = activeColorScheme === 1 ? darkUri : lightUri;

        if (this._lastMonitoredUri !== activeUri) {
            this._lastMonitoredUri = activeUri;
            this._updateWallpaperFileMonitor(activeUri);
        }

        // Read existing metadata to reuse cached JPEGs if possible
        let metaFile = Gio.File.new_for_path(`${SHARED_DIR}/wack-shared-wallpaper-${userName}.json`);
        if (!metaFile.query_exists(null)) {
            const legacyMeta = Gio.File.new_for_path(`${LEGACY_SHARED_DIR}/wack-shared-wallpaper-${userName}.json`);
            if (legacyMeta.query_exists(null))
                metaFile = legacyMeta;
        }

        let existingMeta = null;
        if (metaFile.query_exists(null)) {
            try {
                const [contents] = await loadContentsAsync(metaFile);
                if (contents)
                    existingMeta = JSON.parse(new TextDecoder().decode(contents));
            } catch (_) {}
        }

        const existingLight = existingMeta?.variants?.light ?? (existingMeta?.color_scheme === 0 ? existingMeta : null);
        const existingDark = existingMeta?.variants?.dark ?? (existingMeta?.color_scheme === 1 ? existingMeta : null);
        const timestamp = Date.now();

        let lightVariant, darkVariant;
        if (lightUri === darkUri && !isColor && !lightUri.toLowerCase().endsWith('.xml')) {
            lightVariant = await this._processVariant(lightUri, 'light', timestamp, 0, existingLight, isColor);
            darkVariant = { ...lightVariant };
        } else {
            if (activeColorScheme === 1) {
                darkVariant = await this._processVariant(darkUri, 'dark', timestamp, 1, existingDark, isColor);
                lightVariant = await this._processVariant(lightUri, 'light', timestamp, 0, existingLight, isColor);
            } else {
                lightVariant = await this._processVariant(lightUri, 'light', timestamp, 0, existingLight, isColor);
                darkVariant = await this._processVariant(darkUri, 'dark', timestamp, 1, existingDark, isColor);
            }
        }

        // Attach session's computed visuals to active variant and preserve/reuse for inactive variant.
        // For ACRYLIC variants the promptColor carries an imagePath; validate it still exists
        // before publishing — never write a dead artifact reference into the manifest.
        const _isPromptColorLive = pc => {
            if (!pc) return false;
            if (!pc.imagePath) return true;   // TONAL / scalar — no file dependency
            return Gio.File.new_for_path(pc.imagePath).query_exists(null);
        };

        if (activeColorScheme === 1) {
            darkVariant.clockAlpha = this._clockAlpha ?? 0.6;
            darkVariant.promptColor = this._promptColor;
            if (lightVariant && lightVariant.source_uri === darkVariant.source_uri) {
                lightVariant.clockAlpha = darkVariant.clockAlpha;
                lightVariant.promptColor = darkVariant.promptColor;
            } else if (existingLight && existingLight.promptColor && _isPromptColorLive(existingLight.promptColor) &&
                       existingLight.source_uri === lightVariant?.source_uri && existingLight.source_mtime === lightVariant?.source_mtime) {
                lightVariant.clockAlpha = existingLight.clockAlpha ?? 0.6;
                lightVariant.promptColor = existingLight.promptColor;
            } else if (lightVariant && this._inactivePromptColor && _isPromptColorLive(this._inactivePromptColor)) {
                // Pre-warmed by extension.js for the inactive URI — use it directly.
                lightVariant.clockAlpha = this._inactiveClockAlpha ?? null;
                lightVariant.promptColor = this._inactivePromptColor;
            } else if (lightVariant) {
                lightVariant.clockAlpha = null;
                lightVariant.promptColor = null;
            }
        } else {
            lightVariant.clockAlpha = this._clockAlpha ?? 0.6;
            lightVariant.promptColor = this._promptColor;
            if (darkVariant && darkVariant.source_uri === lightVariant.source_uri) {
                darkVariant.clockAlpha = lightVariant.clockAlpha;
                darkVariant.promptColor = lightVariant.promptColor;
            } else if (existingDark && existingDark.promptColor && _isPromptColorLive(existingDark.promptColor) &&
                       existingDark.source_uri === darkVariant?.source_uri && existingDark.source_mtime === darkVariant?.source_mtime) {
                darkVariant.clockAlpha = existingDark.clockAlpha ?? 0.6;
                darkVariant.promptColor = existingDark.promptColor;
            } else if (darkVariant && this._inactivePromptColor && _isPromptColorLive(this._inactivePromptColor)) {
                // Pre-warmed by extension.js for the inactive URI — use it directly.
                darkVariant.clockAlpha = this._inactiveClockAlpha ?? null;
                darkVariant.promptColor = this._inactivePromptColor;
            } else if (darkVariant) {
                darkVariant.clockAlpha = null;
                darkVariant.promptColor = null;
            }
        }


        const activeVariant = activeColorScheme === 1 ? darkVariant : lightVariant;

        // Strict Publication Invariant:
        // Metadata is published AFTER the referenced JPEGs are verified and on disk.
        const metadata = {
            username: userName,
            color_scheme: activeColorScheme,
            source_uri: activeVariant.source_uri,
            source_mtime: activeVariant.source_mtime,
            source_size: activeVariant.source_size,
            slideshow_xml_text: activeVariant.slideshow_xml_text,
            resolved_slide_path: activeVariant.resolved_slide_path,
            resolved_slide_progress: activeVariant.resolved_slide_progress,
            uri: activeVariant.uri,
            style: style,
            primary_color: this._bgSettings.get_string('primary-color'),
            secondary_color: this._bgSettings.get_string('secondary-color'),
            shading_type: this._bgSettings.get_enum('color-shading-type'),
            is_color: isColor,
            clockFormat: this._interfaceSettings.get_string('clock-format'),
            dateStyle: this._settings ? (this._settings.get_string('date-style') || 'full') : 'full',
            userLocale: GLib.getenv('LC_TIME') || GLib.getenv('LANG') || Intl.DateTimeFormat().resolvedOptions().locale || null,
            clockAlpha: this._clockAlpha ?? 0.6,
            promptColor: this._promptColor,
            promptVibrancy: true,
            promptVibrancyMode: this._settings ? (this._settings.get_string('prompt-vibrancy') || 'tonal') : 'tonal',
            cursorBlink: this._settings ? this._settings.get_boolean('cursor-blink') : true,
            lockscreenMode: this._settings ? this._settings.get_string('lockscreen-mode') : 'cupertino',
            lockscreenMessageText: this._settings ? this._settings.get_string('cupertino-lockscreen-message-text') : '',
            lockscreenMessageEnable: this._settings ? this._settings.get_boolean('cupertino-lockscreen-message-enable') : false,
            variants: {
                light: lightVariant,
                dark: darkVariant,
            },
        };

        const destMetaFile = Gio.File.new_for_path(`${SHARED_DIR}/wack-shared-wallpaper-${userName}.json`);
        const encodedMeta = new TextEncoder().encode(JSON.stringify(metadata));
        await replaceContentsAsync(
            destMetaFile,
            encodedMeta,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        try {
            destMetaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {}

        // Clean up older wallpaper files for this user in shared directory and legacy /var/tmp
        const validPaths = new Set();
        if (lightVariant?.target_path) validPaths.add(lightVariant.target_path);
        if (darkVariant?.target_path) validPaths.add(darkVariant.target_path);

        for (const dPath of [SHARED_DIR, LEGACY_SHARED_DIR]) {
            const dir = Gio.File.new_for_path(dPath);
            if (dir.query_exists(null)) {
                try {
                    const enumerator = await enumerateChildrenAsync(
                        dir,
                        'standard::name',
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        null
                    );
                    let infos;
                    while ((infos = await nextFilesAsync(enumerator, 10, GLib.PRIORITY_DEFAULT, null)) && infos.length > 0) {
                        for (const info of infos) {
                            const name = info.get_name();
                            if (name.startsWith(`wack-shared-wallpaper-${userName}-`) &&
                                (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) &&
                                !validPaths.has(`${dPath}/${name}`)) {
                                try {
                                    const oldFile = Gio.File.new_for_path(`${dPath}/${name}`);
                                    oldFile.delete(null);
                                } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        // Clean up legacy root JSON file if present
        try {
            const legacyFile = Gio.File.new_for_path(`${LEGACY_SHARED_DIR}/wack-shared-wallpaper-${userName}.json`);
            if (legacyFile.query_exists(null))
                legacyFile.delete(null);
        } catch (_) {}
    }

    _updateWallpaperFileMonitor(uri) {
        if (this._wallpaperFileMonitor) {
            if (this._wallpaperFileMonitorId) {
                this._wallpaperFileMonitor.disconnect(this._wallpaperFileMonitorId);
                this._wallpaperFileMonitorId = 0;
            }
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
                this._wallpaperFileMonitorId = this._wallpaperFileMonitor.connect('changed', (_monitor, _file, _other, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CHANGED ||
                        eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        _log('[WACK/CrossSession] Wallpaper file modified on disk, triggering save');
                        this._triggerSave();
                    }
                });
            }
        } catch (e) {
            _log(`[WACK/CrossSession] Failed to monitor wallpaper file: ${e}`);
        }
    }
}
