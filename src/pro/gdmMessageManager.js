import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { _setActorVisible } from './gdmUtils.js';

export class GdmMessageManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.label = null;
        this.content = null;
        this.scrollView = null;
        this.width = 0;
        this.height = 0;
        this.hasOverflow = false;
    }

    setup(dialogParent) {
        this.label = new St.Label({
            style_class: 'wack-cupertino-lockscreen-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.label.clutter_text.line_wrap = true;
        this.label.clutter_text.line_alignment = Pango.Alignment.CENTER;
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

        dialogParent.add_child(this.scrollView);
        dialogParent.set_child_above_sibling(this.scrollView, null);

        this.scrollView.visible = false;
        this.scrollView.opacity = 0;
    }

    teardown() {
        if (this.scrollView) {
            this.scrollView.disconnectObject(this);
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

    getMessageWidth() {
        const dialog = this._gdm._dialog;
        if (dialog) {
            const alloc = dialog.get_allocation_box();
            const width = alloc.x2 - alloc.x1;
            if (width > 0)
                return Math.floor(width / 3);
        }

        const monitor = Main.layoutManager?.primaryMonitor;
        return monitor ? Math.floor(monitor.width / 3) : 0;
    }

    getMessageLineHeight() {
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

    getMessageLineCount() {
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

        const messageWidth = this.getMessageWidth();
        if (messageWidth <= 0)
            return;

        this.width = messageWidth;
        this.content.width = messageWidth;
        this.label.width = messageWidth;

        const lineHeight = this.getMessageLineHeight();
        const maxVisibleHeight = Math.ceil(lineHeight * 4);

        const [, naturalHeight] = this.label.get_preferred_height(messageWidth);
        const lineCount = this.getMessageLineCount();

        this.hasOverflow = naturalHeight > maxVisibleHeight || lineCount > 4;

        const visibleHeight = this.hasOverflow
            ? maxVisibleHeight
            : naturalHeight;

        this.height = visibleHeight;
        this.scrollView.set_size(messageWidth, visibleHeight);

        const vadj = this.scrollView.vadjustment;
        if (vadj)
            vadj.set_value(0);

        this.scrollView.enable_mouse_scrolling = this.hasOverflow;
        this.scrollView.reactive = this.hasOverflow;
        this.scrollView.can_focus = this.hasOverflow;

        this.syncFade();
    }

    update(metadata = null) {
        if (!this.label) return;
        const messageActor = this.getMessageActor();

        const effectiveMetadata = metadata ?? this._gdm._currentWallpaperMetadata;
        const isLegacy = this._gdm._selectedPromptMode === 'wack' || effectiveMetadata?.lockscreenMode === 'wack';

        if (this._gdm._isNotListed || isLegacy) {
            this.hasOverflow = false;
            this.height = 0;
            this.syncFade();
            _setActorVisible(messageActor, false, 0);
            return;
        }

        const userSelected = !!(this._gdm._dialog?._user);
        const userListVisible = !!(this._gdm._dialog?._userSelectionBox?.visible);
        const authPromptActive = !!(this._gdm._dialog?._authPrompt?.visible);

        const showMessage = authPromptActive && userSelected && !userListVisible;

        if (showMessage && effectiveMetadata) {
            const enabled = effectiveMetadata.lockscreenMessageEnable ?? false;
            const text = effectiveMetadata.lockscreenMessageText ?? '';
            const cleanText = (text || '').trim();
            if (enabled && cleanText) {
                this.label.text = cleanText;
                this.syncLayout();
                if (messageActor && !messageActor.visible) {
                    messageActor.opacity = 0;
                    messageActor.visible = true;
                    messageActor.ease({
                        opacity: 255,
                        duration: 250,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            } else {
                this.hasOverflow = false;
                this.height = 0;
                this.syncFade();
                _setActorVisible(messageActor, false, 0);
            }
        } else {
            this.hasOverflow = false;
            this.height = 0;
            this.syncFade();
            _setActorVisible(messageActor, false, 0);
        }

        if (showMessage) {
            this._gdm._positionAuthPrompt();
        }
    }
}
