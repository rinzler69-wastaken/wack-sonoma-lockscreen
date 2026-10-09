import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperAlpha, getWallpaperPromptColor } from '../main/alphaManager.js';
import { initCache } from '../main/alphaCache.js';
import { resolveSlideshowXmlContent } from '../main/constants.js';
import { resolveGdmAccessibleUri, _log, _logError } from './gdmUtils.js';
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

const SHARED_DIR = '/var/tmp/wack/shared';
const LEGACY_SHARED_DIR = '/var/tmp';
const PREFIX = 'wack-shared-wallpaper-';
const SLIDE_STEPS = 16;
const MAX_WARM_STACKS = 4;

export const CURRENT_MANIFEST_VERSION = 1;

export function isManifestVersionSupported(meta) {
    if (!meta || typeof meta !== 'object')
        return false;
    if (meta.__manifest_version__ === undefined)
        return true;
    return meta.__manifest_version__ === CURRENT_MANIFEST_VERSION;
}

const isSolidMode = mode => mode === 'tonal' || mode === 'less';

export class GdmThemeStore {
    /**
     * @param {Extension} extension Extension instance
     * @param {(userName: string) => void} onChanged Notification callback on theme updates
     */
    constructor(extension, onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._themes = new Map();
        this._paletteCache = new Map();
        this._fallback = null;
        this._defaultUser = null;
        this._layout = null;
        this._pending = [];
        this._busy = false;
        this._idleId = 0;
        this._slideTimerId = 0;
        this._revision = 0;

        initCache();

        this._settings = extension.getSettings();
        this._vibrancy = this._settings.get_string('prompt-vibrancy');
        this._settings.connectObject('changed::prompt-vibrancy', () => {
            this._vibrancy = this._settings.get_string('prompt-vibrancy');
            this._requeueAll();
        }, this);

        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._interfaceSettings.connectObject('changed::color-scheme', () => {
            this._onColorSchemeChanged();
        }, this);

        this._stSettings = St.Settings.get();
        if (this._stSettings) {
            this._stSettings.connectObject('notify::color-scheme', () => {
                this._onColorSchemeChanged();
            }, this);
        }

        const monitor = Main.layoutManager?.primaryMonitor;
        const monitorWidth = monitor ? monitor.width : 1920;
        const monitorHeight = monitor ? monitor.height : 1080;
        this._layout = this._buildDefaultLayout(monitorWidth, monitorHeight);

        this._fallback = this._buildFallbackTheme();
        this.loadSync();
    }

    _buildDefaultLayout(monitorWidth, monitorHeight) {
        const layoutKey = `${monitorWidth}x${monitorHeight}@default`;
        return {
            key: layoutKey,
            wellH: 0,
            yCenterFraction: 0.9025,
            bounds: {
                prompt: null,
                cancel: null,
                avatar: null,
                a11y: null,
                session: null,
                suspend: null,
                restart: null,
                powerOff: null,
            },
        };
    }

    get vibrancy() { return this._vibrancy; }

    // ---- read side: the only thing the click path may call -----------------
    hasUser(userName) {
        return userName !== null && this._themes.has(userName);
    }

    peek(userName) {
        if (this.hasUser(userName))
            return this._themes.get(userName);
        return this.defaultTheme();
    }

    defaultTheme() {
        if (this._defaultUser !== null && this._themes.has(this._defaultUser))
            return this._themes.get(this._defaultUser);
        return this._fallback;
    }

    // ---- write side --------------------------------------------------------
    setLayout(layout) {
        // layout = { key, wellH, yCenterFraction, bounds: {prompt,cancel,avatar,a11y,session} }
        // Captured ONCE after first allocation and again on monitors-changed. Never on click.
        if (this._layout !== null && this._layout.key === layout.key)
            return;
        this._layout = layout;
        this._requeueAll();
    }

    loadSync() {
        try {
            const entries = [];
            for (const dPath of [SHARED_DIR, LEGACY_SHARED_DIR]) {
                const dir = Gio.File.new_for_path(dPath);
                if (!dir.query_exists(null))
                    continue;
                const enumerator = dir.enumerate_children(
                    'standard::name,time::modified',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (!name.startsWith(PREFIX) || !name.endsWith('.json'))
                        continue;
                    const userName = name.slice(PREFIX.length, -'.json'.length);
                    if (userName === 'gdm' || entries.some(e => e.name === userName))
                        continue;
                    entries.push({
                        name: userName,
                        mtime: info.get_attribute_uint64('time::modified'),
                        file: dir.get_child(name),
                    });
                }
                enumerator.close(null);
            }
            entries.sort((a, b) => b.mtime - a.mtime);

            for (const entry of entries) {
                this.loadUserSync(entry.name, entry.file);
            }
            this._pickDefaultUser(entries);
            this._armSlideClock();

            if (this._pending.length > 0 && !this._busy) {
                this._drainOne().catch(e => _logError(`[WACK/ThemeStore] drain: ${e}`));
            }
        } catch (e) {
            _logError(`[WACK/ThemeStore] loadSync: ${e}`);
        }
    }

    loadUserSync(userName, file = null) {
        let metaFile = file ?? Gio.File.new_for_path(`${SHARED_DIR}/${PREFIX}${userName}.json`);
        if (!metaFile.query_exists(null)) {
            const legacy = Gio.File.new_for_path(`${LEGACY_SHARED_DIR}/${PREFIX}${userName}.json`);
            if (legacy.query_exists(null))
                metaFile = legacy;
            else
                return;
        }
        try {
            const [ok, contents] = metaFile.load_contents(null);
            if (!ok) return;
            const meta = JSON.parse(new TextDecoder().decode(contents));
            if (!isManifestVersionSupported(meta)) {
                _log(`[WACK/ThemeStore] Unsupported manifest version ${meta.__manifest_version__} for user ${userName} (expected ${CURRENT_MANIFEST_VERSION}), skipping`);
                return;
            }
            let xmlText = meta.slideshow_xml_text || null;
            if (!xmlText && meta.source_uri && (meta.source_uri.endsWith('.xml') || meta.source_uri.endsWith('.xml.in'))) {
                const f = meta.source_uri.startsWith('file://') ? Gio.File.new_for_uri(meta.source_uri) : Gio.File.new_for_path(meta.source_uri);
                if (f.query_exists(null)) {
                    const [xOk, xBytes] = f.load_contents(null);
                    if (xOk) xmlText = new TextDecoder().decode(xBytes);
                }
            }
            const effectiveName = meta.username || userName;
            this._install(effectiveName, meta, xmlText);
        } catch (e) {
            _logError(`[WACK/ThemeStore] loadUserSync ${userName}: ${e}`);
        }
    }

    async load() {
        const entries = await this._listUserFiles();
        for (const entry of entries) {
            if (this._cancellable.is_cancelled())
                return;
            await this.loadUser(entry.name, entry.file);
        }
        this._pickDefaultUser(entries);
        this._armSlideClock();
    }

    /** Also called by the file-monitor handler, debounced per user by the caller. */
    async loadUser(userName, file = null) {
        let metaFile = file ?? Gio.File.new_for_path(`${SHARED_DIR}/${PREFIX}${userName}.json`);
        if (!metaFile.query_exists(null)) {
            const legacy = Gio.File.new_for_path(`${LEGACY_SHARED_DIR}/${PREFIX}${userName}.json`);
            if (legacy.query_exists(null))
                metaFile = legacy;
        }
        let meta = null;
        let xmlText = null;
        try {
            const [bytes] = await loadContentsAsync(metaFile, this._cancellable);
            meta = JSON.parse(new TextDecoder().decode(bytes));
            if (!isManifestVersionSupported(meta)) {
                _log(`[WACK/ThemeStore] Unsupported manifest version ${meta.__manifest_version__} for user ${userName} (expected ${CURRENT_MANIFEST_VERSION}), skipping`);
                return;
            }
            xmlText = await this._readSlideXml(meta);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                _logError(`[WACK/ThemeStore] load ${userName}: ${e}`);
            return;
        }
        if (this._cancellable.is_cancelled())
            return;

        const effectiveName = meta.username || userName;
        this._install(effectiveName, meta, xmlText);
        this._onChanged(effectiveName);
    }

    // ---- internals ---------------------------------------------------------
    _userVibrancy(meta) {
        return meta?.promptVibrancyMode ?? this._vibrancy;
    }

    _getColorScheme() {
        if (this._interfaceSettings)
            return this._interfaceSettings.get_enum('color-scheme');
        const stScheme = St.Settings.get()?.color_scheme;
        if (stScheme === St.SystemColorScheme.PREFER_DARK || stScheme === 1)
            return 1;
        return 0;
    }

    _resolveVariant(rawMeta, colorScheme = null) {
        if (!rawMeta)
            return null;
        const scheme = colorScheme ?? this._getColorScheme();
        const variantKey = scheme === 1 ? 'dark' : 'light';
        if (rawMeta.variants && rawMeta.variants[variantKey]) {
            const v = rawMeta.variants[variantKey];
            const isSameSource = !v.source_uri || !rawMeta.source_uri || (v.source_uri === rawMeta.source_uri);
            return {
                ...rawMeta,
                source_uri: v.source_uri ?? rawMeta.source_uri,
                source_mtime: v.source_mtime ?? rawMeta.source_mtime,
                source_size: v.source_size ?? rawMeta.source_size,
                uri: v.uri ?? rawMeta.uri,
                slideshow_xml_text: v.slideshow_xml_text ?? rawMeta.slideshow_xml_text,
                resolved_slide_path: v.resolved_slide_path ?? rawMeta.resolved_slide_path,
                resolved_slide_progress: v.resolved_slide_progress ?? rawMeta.resolved_slide_progress,
                is_color: v.is_color ?? rawMeta.is_color,
                clockAlpha: v.clockAlpha ?? (isSameSource ? rawMeta.clockAlpha : null),
                promptColor: v.promptColor ?? (isSameSource ? rawMeta.promptColor : null),
                active_color_scheme: scheme,
            };
        }
        return {
            ...rawMeta,
            active_color_scheme: scheme,
        };
    }

    _install(userName, rawMeta, xmlText) {
        const meta = this._resolveVariant(rawMeta);
        const slide = this._resolveSlide(meta, xmlText);
        const image = this._imageKey(meta, slide);
        const userVibrancy = this._userVibrancy(meta);
        const paletteKey = this._paletteKey(image, userVibrancy);

        // Prefer: cached-by-key > palette shipped by the user session (if it
        // matches current slide) > previous palette (stale fallback for display only if matching image).
        const previous = this._themes.get(userName);
        let palette = this._paletteCache.get(paletteKey) ?? null;
        // For ACRYLIC palettes the visual result depends on a PNG file artifact.
        // If that artifact was deleted (e.g. by the sibling Light/Dark variant's
        // pruning pass) while the in-memory entry survived, treat it as a miss so
        // the generation pipeline is triggered to recreate the file.
        if (palette !== null && !isSolidMode(palette.mode) &&
            !(palette.value?.imagePath && Gio.File.new_for_path(palette.value.imagePath).query_exists(null))) {
            this._paletteCache.delete(paletteKey);
            palette = null;
        }
        if (palette === null)
            palette = this._adoptShippedPalette(meta, image, slide);
        if (palette === null && previous !== undefined && previous.palette !== null && previous.palette.image === image && previous.palette.mode === userVibrancy)
            palette = previous.palette;

        const isSlideMismatch = slide !== null && (
            !meta.resolved_slide_path ||
            (slide.filePath !== meta.resolved_slide_path &&
             !meta.resolved_slide_path.endsWith(slide.filePath) &&
             !slide.filePath.endsWith(meta.resolved_slide_path))
        );

        const clockAlpha = isSlideMismatch ? null : (meta.clockAlpha ?? null);

        const theme = this._freeze({
            userName,
            meta,
            rawMeta,
            xmlText,
            slide,          // null for static wallpapers
            image,          // the single image the palette is sampled from
            palette,        // { mode, image, layoutKey, isShipped, value } | null
            clockAlpha,
        });
        this._themes.set(userName, theme);

        if (!this._isPaletteValid(theme))
            this._enqueue(userName);
    }

    _freeze(t) {
        return Object.freeze({ ...t, revision: ++this._revision });
    }

    _imageKey(meta, slide) {
        if (slide !== null && slide.isTransition)
            return `${slide.from}>${slide.to}@${slide.progress}`;
        if (slide !== null)
            return slide.filePath;
        if (meta?.is_color)
            return `color:${meta.primary_color}:${meta.secondary_color}:${meta.shading_type}`;
        return resolveGdmAccessibleUri(meta) ?? meta.uri ?? '';
    }

    _paletteKey(image, mode = null) {
        const effectiveMode = mode ?? this._vibrancy;
        return `${image}|${effectiveMode}`;
    }

    _isPaletteValid(theme) {
        const p = theme.palette;
        if (p === null)
            return false;
        const userVibrancy = this._userVibrancy(theme.meta);
        if (p.mode !== userVibrancy)
            return false;
        if (p.image !== theme.image)
            return false;
        return isSolidMode(p.mode) || Boolean(p.value?.imagePath && Gio.File.new_for_path(p.value.imagePath).query_exists(null));
    }

    _adoptShippedPalette(meta, image, slide) {
        const pc = meta.promptColor;
        if (!pc || pc.r == null || pc.g == null || pc.b == null)
            return null;
        const userVibrancy = this._userVibrancy(meta);
        if (pc.vibrancyMode && pc.vibrancyMode !== userVibrancy)
            return null;
        const isSolid = isSolidMode(userVibrancy);
        const hasImg = pc.imagePath && Gio.File.new_for_path(pc.imagePath).query_exists(null);
        if (!isSolid && !hasImg)
            return null;

        // If this is a slideshow, ensure the shipped palette matches the current slide
        if (slide !== null) {
            const shippedPath = meta.resolved_slide_path ?? null;
            if (!shippedPath)
                return null;
            if (slide.isTransition) {
                const shippedProg = meta.resolved_slide_progress ?? 0;
                if (Math.abs(slide.progress - shippedProg) > 0.1)
                    return null;
                if (slide.from !== shippedPath && slide.to !== shippedPath && slide.filePath !== shippedPath)
                    return null;
            } else {
                if (slide.filePath !== shippedPath && !shippedPath.endsWith(slide.filePath) && !slide.filePath.endsWith(shippedPath))
                    return null;
            }
        }

        const palette = {
            mode: userVibrancy,
            image: image,
            layoutKey: this._layout !== null ? this._layout.key : 'default',
            isShipped: true,
            value: pc,
        };
        this._paletteCache.set(this._paletteKey(image, userVibrancy), palette);
        return palette;
    }

    _enqueue(userName) {
        if (!this._pending.includes(userName))
            this._pending.push(userName);
        this._scheduleDrain();
    }

    _requeueAll() {
        for (const [name, theme] of this._themes) {
            if (!this._isPaletteValid(theme))
                this._enqueue(name);
        }
    }

    _scheduleDrain() {
        if (this._idleId !== 0 || this._busy || this._pending.length === 0)
            return;
        if (this._layout === null)
            return;   // cannot sample without the canonical layout
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._drainOne().catch(e => _logError(`[WACK/ThemeStore] drain: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._idleId, '[WACK] GdmThemeStore.drain');
    }

    async _drainOne() {
        const userName = this._pending.shift();
        const snapshot = this._themes.get(userName);
        if (snapshot === undefined)
            return;

        this._busy = true;
        try {
            const meta = snapshot.meta;
            const layout = this._layout;
            let sampleUri;
            if (meta.source_uri && (meta.source_uri.endsWith('.xml') || meta.source_uri.endsWith('.xml.in'))) {
                sampleUri = meta.source_uri.startsWith('file://') ? meta.source_uri : `file://${meta.source_uri}`;
            } else {
                sampleUri = resolveGdmAccessibleUri(meta) || snapshot.image || meta.uri;
            }

            const common = {
                uri: sampleUri,
                isColor: meta.is_color,
                primaryColor: meta.primary_color,
                secondaryColor: meta.secondary_color,
                shadingType: meta.shading_type,
                pictureOptions: meta.style,
            };
            const userVibrancy = this._userVibrancy(meta);
            const [value, alpha] = await Promise.all([
                getWallpaperPromptColor({
                    ...common,
                    wellH: layout.wellH,
                    yCenterFraction: layout.yCenterFraction,
                    promptBounds: layout.bounds.prompt,
                    cancelBounds: layout.bounds.cancel,
                    avatarBounds: layout.bounds.avatar,
                    a11yBounds: layout.bounds.a11y,
                    sessionBounds: layout.bounds.session,
                    suspendBounds: layout.bounds.suspend,
                    restartBounds: layout.bounds.restart,
                    powerOffBounds: layout.bounds.powerOff,
                    vibrancyMode: userVibrancy,
                }),
                (snapshot.clockAlpha !== null && snapshot.slide === null)
                    ? Promise.resolve(snapshot.clockAlpha)
                    : getWallpaperAlpha({ ...common, textLuminance: 1.0 }),
            ]);
            if (this._cancellable.is_cancelled())
                return;

            // The theme may have been replaced (slide advanced, file changed) while
            // we awaited. Write only into the same image; never into "current".
            const current = this._themes.get(userName);
            if (current === undefined || current.image !== snapshot.image || value === null) {
                if (current !== undefined && current.image !== snapshot.image)
                    this._enqueue(userName);
                return;
            }

            const palette = {
                mode: userVibrancy,
                image: snapshot.image,
                layoutKey: layout.key,
                isShipped: false,
                value,
            };
            this._paletteCache.set(this._paletteKey(snapshot.image, userVibrancy), palette);
            this._themes.set(userName, this._freeze({ ...current, palette, clockAlpha: alpha }));
            this._onChanged(userName);
        } finally {
            this._busy = false;
            if (!this._cancellable.is_cancelled())
                this._scheduleDrain();
        }
    }

    // ---- slideshow: one timer for the whole store --------------------------
    _resolveSlide(meta, xmlText) {
        if (xmlText === null || meta.is_color)
            return null;
        const r = resolveSlideshowXmlContent(xmlText, meta.color_scheme ?? 0);
        if (!r)
            return null;
        const step = r.isTransition ? Math.round(r.progress * SLIDE_STEPS) / SLIDE_STEPS : 0;
        return {
            isTransition: r.isTransition,
            filePath: r.filePath ?? r.from,
            from: r.from ?? null,
            to: r.to ?? null,
            progress: step,
            nextDelayMs: r.isTransition
                ? Math.max(1000, Math.min((r.duration * 1000) / SLIDE_STEPS, r.remainingDuration * 1000 + 100))
                : Math.max(1000, r.remainingDuration * 1000 + 500),
        };
    }

    _armSlideClock() {
        this._stopSlideClock();
        let next = Infinity;
        for (const theme of this._themes.values()) {
            if (theme.slide !== null)
                next = Math.min(next, theme.slide.nextDelayMs);
        }
        if (!Number.isFinite(next))
            return;

        this._slideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, next, () => {
            this._slideTimerId = 0;
            this._advanceSlides();
            this._armSlideClock();   // re-derived from wall clock, so no drift accumulates
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._slideTimerId, '[WACK] GdmThemeStore.slideClock');
    }

    _advanceSlides() {
        for (const [name, theme] of this._themes) {
            if (theme.slide === null)
                continue;
            const raw = theme.rawMeta ?? theme.meta;
            this._install(name, raw, theme.xmlText);   // keeps the old palette until replaced
            const updated = this._themes.get(name);
            if (updated && this._isPaletteValid(updated)) {
                this._onChanged(name);
            }
        }
    }

    _onColorSchemeChanged() {
        this._fallback = this._buildFallbackTheme();
        if (this._themes.size === 0) {
            if (this._onChanged)
                this._onChanged(null);
            return;
        }
        for (const [name, theme] of this._themes) {
            const raw = theme.rawMeta ?? theme.meta;
            this._install(name, raw, theme.xmlText);
            const updated = this._themes.get(name);
            if (updated && this._onChanged) {
                this._onChanged(name);
            }
        }
    }

    _stopSlideClock() {
        if (this._slideTimerId !== 0) {
            GLib.source_remove(this._slideTimerId);
            this._slideTimerId = 0;
        }
    }

    // ---- async file helpers ------------------------------------------------
    async _listUserFiles() {
        const out = [];
        for (const dPath of [SHARED_DIR, LEGACY_SHARED_DIR]) {
            const dir = Gio.File.new_for_path(dPath);
            if (!dir.query_exists(null))
                continue;
            let enumerator = null;
            try {
                enumerator = await enumerateChildrenAsync(
                    dir,
                    'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW, this._cancellable);
                for (;;) {
                    const infos = await nextFilesAsync(enumerator, 32, GLib.PRIORITY_LOW, this._cancellable);
                    if (infos.length === 0)
                        break;
                    for (const info of infos) {
                        const name = info.get_name();
                        if (!name.startsWith(PREFIX) || !name.endsWith('.json'))
                            continue;
                        const userName = name.slice(PREFIX.length, -'.json'.length);
                        if (userName === 'gdm' || out.some(e => e.name === userName))
                            continue;   // GDM's own file is output, not input
                        out.push({
                            name: userName,
                            mtime: info.get_attribute_uint64('time::modified'),
                            file: dir.get_child(name),
                        });
                    }
                }
            } catch (e) {
                if (!this._cancellable.is_cancelled())
                    _logError(`[WACK/ThemeStore] list ${dPath}: ${e}`);
            } finally {
                if (enumerator !== null)
                    enumerator.close(null);
            }
        }
        out.sort((a, b) => b.mtime - a.mtime);
        return out;
    }

    async _readSlideXml(meta) {
        if (meta.slideshow_xml_text)
            return meta.slideshow_xml_text;
        const src = meta.source_uri;
        if (!src || !(src.endsWith('.xml') || src.endsWith('.xml.in')))
            return null;
        const f = src.startsWith('file://') ? Gio.File.new_for_uri(src) : Gio.File.new_for_path(src);
        const [bytes] = await loadContentsAsync(f, this._cancellable);
        return new TextDecoder().decode(bytes);
    }

    _pickDefaultUser(entries) {
        if (this._defaultUser === null && entries.length > 0)
            this._defaultUser = entries[0].name;   // newest mtime, chosen once
    }

    _buildFallbackTheme() {
        // Built once from org.gnome.desktop.background. Not on any hot path.
        const bg = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        const iface = this._interfaceSettings ?? new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const dark = iface.get_enum('color-scheme') === 1;
        const style = bg.get_enum('picture-options');
        const uri = bg.get_string(dark ? 'picture-uri-dark' : 'picture-uri');
        const clockFormatOverride = this._settings ? this._settings.get_string('clock-format') : 'system';
        const clockFormat = clockFormatOverride === 'system' ? iface.get_string('clock-format') : clockFormatOverride;
        const canonicalUser = this._defaultUser;
        const canonicalMeta = canonicalUser ? this._themes.get(canonicalUser)?.meta : null;
        const defaultActions = canonicalMeta?.systemActions ?? (
            (this._settings && this._settings.settings_schema.has_key('cupertino-system-actions'))
                ? this._settings.get_boolean('cupertino-system-actions')
                : true
        );
        const defaultDimmer = canonicalMeta?.backgroundDimmer ?? (
            (this._settings && this._settings.settings_schema.has_key('gdm-background-dimmer'))
                ? this._settings.get_boolean('gdm-background-dimmer')
                : false
        );
        const meta = {
            username: 'gdm',
            source_uri: uri, uri, style,
            primary_color: bg.get_string('primary-color'),
            secondary_color: bg.get_string('secondary-color'),
            shading_type: bg.get_enum('color-shading-type'),
            is_color: style === 0,
            clockFormat,
            clockWeight: this._settings ? this._settings.get_string('clock-weight') : 'semibold',
            clockTint: this._settings ? this._settings.get_boolean('clock-tint') : false,
            statusCorner: this._settings ? this._settings.get_boolean('status-corner') : true,
            passwordIndicators: this._settings ? this._settings.get_boolean('password-indicators') : true,
            systemActions: defaultActions,
            backgroundDimmer: defaultDimmer,
            dateStyle: this._settings ? (this._settings.get_string('date-style') || 'full') : 'full',
            clockAlpha: 0.6,
            lockscreenMode: this._settings ? this._settings.get_string('lockscreen-mode') : 'cupertino',
            active_color_scheme: dark ? 1 : 0,
        };
        return this._freeze({
            userName: 'gdm', meta, rawMeta: meta, xmlText: null, slide: null,
            image: uri, palette: null, clockAlpha: 0.6,
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._stopSlideClock();
        if (this._idleId !== 0) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._settings.disconnectObject(this);
        this._settings = null;
        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }
        if (this._stSettings) {
            this._stSettings.disconnectObject(this);
            this._stSettings = null;
        }
        this._themes.clear();
        this._paletteCache.clear();
        this._pending = [];
        this._fallback = null;
        this._onChanged = null;
    }
}

export class GdmWallpaperView {
    constructor(parent, sibling) {
        this._group = new Clutter.Actor();
        parent.add_child(this._group);
        parent.set_child_below_sibling(this._group, sibling);
        this._monitors = [];   // { container, stacks: Map(stackKey -> {root, base, overlay}), topKey, dimmer }
        this._presentedRevision = -1;
        this._presentedUser = null;
        this._dimmerEnabled = false;
    }

    rebuild() {
        for (const m of this._monitors)
            m.container.destroy();
        this._monitors = [];
        this._presentedRevision = -1;

        for (const monitor of Main.layoutManager.monitors) {
            const container = new St.Widget({
                x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
                effect: new Shell.BlurEffect({ name: 'blur' }),
            });
            container.get_effect('blur').set({ radius: 0, brightness: 1.0 });

            const dimmer = new St.Widget({
                width: monitor.width,
                height: monitor.height,
                style: 'background-color: rgba(0, 0, 0, 0.15);',
                opacity: this._dimmerEnabled ? 255 : 0,
                visible: this._dimmerEnabled,
            });
            container.add_child(dimmer);

            this._group.add_child(container);
            this._monitors.push({ container, monitor, stacks: new Map(), topKey: null, dimmer });
        }
    }

    /** Called at idle after the dialog fade-in: forces first paint of each texture early. */
    warm(theme) {
        for (const m of this._monitors) {
            const key = this._stackKey(theme);
            if (m.stacks.has(key))
                continue;
            const stack = this._createStack(m, theme);
            m.container.set_child_below_sibling(stack.root, null);
            if (m.dimmer)
                m.container.set_child_above_sibling(m.dimmer, null);
            m.stacks.set(key, stack);
            this._evict(m);
        }
    }

    /** Click path: property writes only. No I/O, no decode, no sampling. */
    present(theme, animate) {
        const dim = Boolean(theme.meta?.backgroundDimmer);
        this.setDimmer(dim, animate);

        if (theme.userName === this._presentedUser && theme.revision === this._presentedRevision)
            return;   // idempotent: return-to-picker + onReset both call this safely
        this._presentedUser = theme.userName;
        this._presentedRevision = theme.revision;

        for (const m of this._monitors) {
            const key = this._stackKey(theme);
            let stack = m.stacks.get(key);
            if (stack === undefined) {
                stack = this._createStack(m, theme);   // cold path; warm() should have run
                m.stacks.set(key, stack);
            }

            if (stack.overlay !== null && theme.slide !== null)
                stack.overlay.opacity = Math.round(theme.slide.progress * 255);   // step = one property write

            if (m.topKey === key)
                continue;   // same stack, only the overlay step changed

            stack.root.remove_all_transitions();
            m.container.set_child_above_sibling(stack.root, null);
            if (m.dimmer)
                m.container.set_child_above_sibling(m.dimmer, null);
            if (animate) {
                stack.root.opacity = 0;
                stack.root.ease({
                    opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                stack.root.opacity = 255;
            }
            m.topKey = key;
        }
    }

    setDimmer(enabled, animate = true) {
        const isEnabled = Boolean(enabled);
        if (this._dimmerEnabled === isEnabled && animate)
            return;
        this._dimmerEnabled = isEnabled;

        for (const m of this._monitors) {
            if (!m.dimmer)
                continue;
            m.dimmer.remove_all_transitions();
            if (this._dimmerEnabled)
                m.dimmer.visible = true;

            if (animate) {
                m.dimmer.ease({
                    opacity: this._dimmerEnabled ? 255 : 0,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (!this._dimmerEnabled && m.dimmer)
                            m.dimmer.visible = false;
                    },
                });
            } else {
                m.dimmer.opacity = this._dimmerEnabled ? 255 : 0;
                m.dimmer.visible = this._dimmerEnabled;
            }
        }
    }

    setPromptBlur(radius, brightness, animate, duration) {
        for (const m of this._monitors) {
            const effect = m.container.get_effect('blur');
            m.container.remove_transition('@effects.blur.radius');
            m.container.remove_transition('@effects.blur.brightness');
            if (animate) {
                m.container.ease_property('@effects.blur.radius', radius,
                    { duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                m.container.ease_property('@effects.blur.brightness', brightness,
                    { duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            } else {
                effect.set({ radius, brightness });
            }
        }
    }

    _stackKey(theme) {
        const s = theme.slide;
        if (s !== null && s.isTransition)
            return `${s.from}>${s.to}`;
        if (theme.meta?.is_color)
            return `color:${theme.meta.primary_color}:${theme.meta.secondary_color}:${theme.meta.shading_type}`;
        return theme.image;
    }

    _createStack(m, theme) {
        const s = theme.slide;
        const root = new St.Widget({ width: m.monitor.width, height: m.monitor.height, opacity: 255 });
        const mk = image => new St.Widget({
            width: m.monitor.width, height: m.monitor.height,
            style: this._backgroundStyle(theme.meta, image),
        });
        let base;
        let overlay = null;
        if (s !== null && s.isTransition) {
            base = mk(s.from);
            overlay = mk(s.to);
            overlay.opacity = Math.round((s.progress || 0) * 255);
        } else {
            base = mk(theme.image);
        }
        root.add_child(base);
        if (overlay !== null)
            root.add_child(overlay);
        m.container.add_child(root);
        return { root, base, overlay };
    }

    _evict(m) {
        while (m.stacks.size > MAX_WARM_STACKS) {
            for (const [key, stack] of m.stacks) {
                if (key === m.topKey)
                    continue;
                stack.root.destroy();
                m.stacks.delete(key);
                break;
            }
        }
    }

    _backgroundStyle(meta, image) {
        if (!meta) return '';
        if (meta.is_color) {
            if (meta.shading_type === 0)
                return `background-color: ${meta.primary_color};`;
            const dir = meta.shading_type === 1 ? 'vertical' : 'horizontal';
            return `background-gradient-direction: ${dir}; background-gradient-start: ${meta.primary_color}; background-gradient-end: ${meta.secondary_color};`;
        }
        let size = 'cover';
        let pos = 'center';
        let repeat = 'no-repeat';
        switch (meta.style) {
        case 0: case 2: size = 'auto'; break;
        case 3: size = 'contain'; break;
        case 4: size = '100% 100%'; break;
        case 1: size = 'auto'; repeat = 'repeat'; pos = 'top left'; break;
        }
        const uri = image ? (image.startsWith('file://') ? image : `file://${image}`) : '';
        return `background-image: url("${uri}"); background-size: ${size}; background-position: ${pos}; background-repeat: ${repeat};`;
    }

    destroy() {
        if (this._group) {
            this._group.destroy();   // destroys containers, stacks and effects with it
            this._group = null;
        }
        this._monitors = [];
    }
}
