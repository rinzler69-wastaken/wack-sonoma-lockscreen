import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { _setActorVisible } from './mainUtils.js';

export class LockscreenMessageManager {
    constructor(extension) {
        this._extension = extension;
        this.scrollView = null;
        this.content = null;
        this.label = null;
        this.hasOverflow = false;
        this.height = 0;
        this.width = 0;
    }

    setup(mainBox) {
        this.label = new St.Label({
            style_class: 'wack-lockscreen-message',
            text: '',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: false,
        });
        this.label.clutter_text.set_line_wrap(true);
        this.label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        this.content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this.content.add_child(this.label);

        this.scrollView = new St.ScrollView({
            style_class: 'wack-cupertino-lockscreen-message-scroll',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            overlay_scrollbars: true,
            enable_mouse_scrolling: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            visible: false,
        });
        this.scrollView.set_child(this.content);

        const messageScrollbar = this.scrollView.get_vscroll_bar?.();
        if (messageScrollbar) {
            messageScrollbar.opacity = 0;
            messageScrollbar.visible = false;
            messageScrollbar.reactive = false;
        }

        this.scrollView.vadjustment?.connectObject('notify::value', () => {
            this.syncFade();
        }, this);

        if (mainBox) {
            mainBox.add_child(this.scrollView);
        }
    }

    teardown(mainBox) {
        if (this.scrollView?.vadjustment) {
            this.scrollView.vadjustment.disconnectObject(this);
        }
        if (this.scrollView && mainBox) {
            mainBox.remove_child(this.scrollView);
            this.scrollView.destroy();
            this.scrollView = null;
        }
        if (this.content) {
            this.content.destroy();
            this.content = null;
        }
        if (this.label) {
            this.label.destroy();
            this.label = null;
        }
    }

    getMessageActor() {
        return this.scrollView ?? this.label ?? null;
    }

    getWidth() {
        const mainBox = this._extension._mainBox;
        if (mainBox?.allocation) {
            const box = mainBox.allocation;
            const width = box.x2 - box.x1;
            if (width > 0)
                return Math.floor(width / 3);
        }

        const monitor = Main.layoutManager?.primaryMonitor;
        return monitor ? Math.floor(monitor.width / 3) : 0;
    }

    getLineHeight() {
        const clutterText = this.label?.clutter_text;
        const layout = clutterText?.get_layout?.();
        const context = layout?.get_context?.();
        const fontDescription = layout?.get_font_description?.();

        if (context && fontDescription) {
            const metrics = context.get_metrics(fontDescription, Pango.Language.get_default());
            const metricsHeight = metrics.get_height();
            if (metricsHeight > 0)
                return Math.ceil(metricsHeight / Pango.SCALE);

            const ascent = metrics.get_ascent();
            const descent = metrics.get_descent();
            if (ascent + descent > 0)
                return Math.ceil((ascent + descent) / Pango.SCALE);
        }

        const [, naturalHeight] = this.label?.get_preferred_height?.(-1) ?? [0, 0];
        return Math.ceil(naturalHeight);
    }

    getLineCount() {
        const layout = this.label?.clutter_text?.get_layout?.();
        return layout?.get_line_count?.() ?? 0;
    }

    syncFade() {
        if (!this.scrollView)
            return;

        if (this.hasOverflow)
            this.scrollView.add_style_class_name('vfade');
        else
            this.scrollView.remove_style_class_name('vfade');
    }

    syncLayout() {
        if (!this.label || !this.scrollView || !this.content)
            return;

        const messageWidth = this.getWidth();
        if (messageWidth <= 0)
            return;

        this.width = messageWidth;
        this.content.width = messageWidth;
        this.label.x_expand = true;
        this.label.x_align = Clutter.ActorAlign.CENTER;

        const lineHeight = this.getLineHeight();
        const maxVisibleHeight = Math.ceil(lineHeight * 4);
        const [, naturalHeight] = this.label.get_preferred_height(messageWidth);
        const clampedHeight = Math.min(naturalHeight, maxVisibleHeight);
        const lineCount = this.getLineCount();

        this.hasOverflow = lineCount > 4 || (lineCount === 0 && naturalHeight > maxVisibleHeight);
        this.height = clampedHeight;

        if (!this.hasOverflow)
            this.scrollView.vadjustment?.set_value(0);

        this.syncFade();
        this._extension._mainBox?.queue_relayout();
    }

    update() {
        if (!this.label) return;
        const settings = this._extension._settings;
        if (!settings) return;
        const enabled = settings.get_boolean('cupertino-lockscreen-message-enable');
        const text = settings.get_string('cupertino-lockscreen-message-text');
        const cleanText = (text || '').trim();
        const messageActor = this.getMessageActor();
        if (enabled && cleanText) {
            this.label.text = cleanText;
            this.syncLayout();
            if (this._extension._lockscreenMode === 'cupertino') {
                const notifManager = this._extension._notifManager;
                const hasNotifs = notifManager ? notifManager.hasVisibleNotifs() : false;
                const shouldBeVisible = this._extension._promptActive || !hasNotifs;
                _setActorVisible(messageActor, shouldBeVisible, shouldBeVisible ? 255 : 0);
            } else {
                _setActorVisible(messageActor, this._extension._promptActive, this._extension._promptActive ? 255 : 0);
            }
        } else {
            this.label.text = '';
            this.hasOverflow = false;
            this.height = 0;
            this.syncFade();
            _setActorVisible(messageActor, false, 0);
        }
        if (this._extension._mainBox) {
            this._extension._mainBox.queue_relayout();
        }
    }
}
