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
            style_class: 'wack-cupertino-lockscreen-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.label.clutter_text.set_line_wrap(true);
        this.label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        this.label.x_expand = true;

        this.content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'wack-cupertino-lockscreen-message-content',
        });
        this.content.add_child(this.label);

        this.scrollView = new St.ScrollView({
            style_class: 'wack-cupertino-lockscreen-message-scroll',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            enable_mouse_scrolling: false,
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,
            opacity: 0,
        });
        this.scrollView.set_child(this.content);
        this.scrollView.connectObject('scroll-event', (_actor, _event) => {
            return this.hasOverflow
                ? Clutter.EVENT_PROPAGATE
                : Clutter.EVENT_STOP;
        }, this);

        const messageScrollbar = this.scrollView.get_vscroll_bar?.();
        if (messageScrollbar) {
            messageScrollbar.reactive = false;
            messageScrollbar.can_focus = false;
            messageScrollbar.track_hover = false;
        }

        this.scrollView.vadjustment?.connectObject('notify::value', () => {
            this.syncFade();
        }, this);

        if (mainBox) {
            mainBox.add_child(this.scrollView);
            mainBox.set_child_above_sibling?.(this.scrollView, null);
        }
    }

    teardown(mainBox) {
        if (this.scrollView) {
            this.scrollView.disconnectObject(this);
            if (this.scrollView.vadjustment) {
                this.scrollView.vadjustment.disconnectObject(this);
            }
            if (mainBox) {
                mainBox.remove_child(this.scrollView);
            }
            this.scrollView.destroy();
            this.scrollView = null;
        }
        this.content = null;
        this.label = null;
        this.width = 0;
        this.height = 0;
        this.hasOverflow = false;
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
        return Math.max(Math.ceil(naturalHeight), 24);
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
        this.label.width = messageWidth;
        this.label.x_expand = true;
        this.label.x_align = Clutter.ActorAlign.CENTER;

        const lineHeight = this.getLineHeight();
        const maxVisibleHeight = Math.ceil(lineHeight * 4);
        const [, naturalHeight] = this.label.get_preferred_height(messageWidth);
        const lineCount = this.getLineCount();

        this.hasOverflow = naturalHeight > maxVisibleHeight || lineCount > 4;
        const visibleHeight = this.hasOverflow
            ? maxVisibleHeight
            : naturalHeight;

        this.height = visibleHeight;
        this.scrollView.set_size(messageWidth, visibleHeight);

        const vadj = this.scrollView.vadjustment;
        if (vadj && !this.hasOverflow)
            vadj.set_value(0);

        this.scrollView.enable_mouse_scrolling = this.hasOverflow;
        this.scrollView.reactive = this.hasOverflow;
        this.scrollView.can_focus = this.hasOverflow;

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
