import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import Gettext from 'gettext';
import { getChromeAlpha, getUserLabelStyle } from '../main/colorUtils.js';

// Reuse gnome-shell's translated action names.
const shellDomain = Gettext.domain('gnome-shell');
const actionName = name => shellDomain.pgettext('search-result', name);

// Gap between the bottom of the user list and the buttons.
const CSA_TOP_GAP = 35;

/**
 * Reports no width to its parent and lays its child out centred. Inside the
 * user list this keeps the buttons from widening the list, so the list stays
 * horizontally dead centre, while the buttons still follow the list's
 * visibility, fades and movement. The real height is reported so the list
 * still makes room for the buttons above the bottom of the screen.
 */
const OverflowBin = GObject.registerClass(
    class WackCsaOverflowBin extends St.Bin {
        vfunc_get_preferred_width(_forHeight) {
            return [0, 0];
        }

        vfunc_get_preferred_height(_forWidth) {
            const [, height] = this.get_child()?.get_preferred_height(-1) ?? [0, 0];
            return [CSA_TOP_GAP + height, CSA_TOP_GAP + height];
        }

        vfunc_allocate(box) {
            this.set_allocation(box);
            const child = this.get_child();
            if (!child)
                return;
            const [, width] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(width);
            const x = Math.floor((box.get_width() - width) / 2);
            child.allocate(new Clutter.ActorBox({ x1: x, y1: CSA_TOP_GAP, x2: x + width, y2: CSA_TOP_GAP + height }));
        }
    });

/**
 * Cupertino System Actions (CSA): macOS-style Suspend / Restart / Power Off
 * buttons under the GDM user list. Each button follows SystemActions, which
 * already honours logind availability and org.gnome.login-screen
 * disable-restart-buttons. While enabled, the Quick Settings power menu is
 * hidden since CSA replaces it.
 */
export class GdmPowerButtons {
    constructor(gdmManager = null) {
        this._gdm = gdmManager;
        this.actor = null;
        this._shutdownItem = null;
        this._items = {};
        this._lastPromptColor = null;
        this._userEnabled = true;
    }

    setup(dialog) {
        const userSelectionBox = dialog?._userSelectionBox;
        if (!userSelectionBox || this.actor)
            return;

        const actions = SystemActions.getDefault();
        const row = new St.BoxLayout({ style_class: 'wack-gdm-power-buttons' });

        const buttons = [
            ['powerOff', 'can-power-off', 'system-shutdown-symbolic', actionName('Power Off'), () => actions.activatePowerOff()],
            ['restart', 'can-restart', 'system-reboot-symbolic', actionName('Restart'), () => actions.activateRestart()],
            ['suspend', 'can-suspend', 'media-playback-pause-symbolic', actionName('Suspend'), () => actions.activateSuspend()],
        ];

        this._items = {};

        for (const [key, property, iconName, label, activate] of buttons) {
            const icon = new St.Icon({
                icon_name: iconName,
                style_class: 'wack-gdm-power-icon',
                x_align: Clutter.ActorAlign.CENTER,
            });
            const labelWidget = new St.Label({
                text: label,
                style_class: 'wack-gdm-power-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            const content = new St.BoxLayout({ vertical: true });
            content.add_child(icon);
            content.add_child(labelWidget);

            const button = new St.Button({
                style_class: 'wack-gdm-power-button',
                can_focus: true,
                accessible_name: label,
                child: content,
            });
            button.connect('clicked', activate);
            actions.bind_property(property, button, 'visible', GObject.BindingFlags.SYNC_CREATE);
            row.add_child(button);

            this._items[key] = {
                button,
                icon,
                label: labelWidget,
                content,
                activate,
            };
        }

        this.actor = new OverflowBin({ child: row });
        userSelectionBox.add_child(this.actor);

        // The shell changes this actor asynchronously as it moves between the
        // picker and an authentication prompt. Observe the actor itself so the
        // Quick Settings action is never left in the previous state's mode.
        userSelectionBox.connectObject(
            'notify::visible', () => this.syncQuickSettingsVisibility(),
            'notify::opacity', () => this.syncQuickSettingsVisibility(),
            this
        );

        if (this._lastPromptColor) {
            this.updateVibrancy(this._lastPromptColor);
        }
        this.syncQuickSettingsVisibility();
    }

    getPowerIcons() {
        return {
            suspend: this._items.suspend?.icon ?? null,
            restart: this._items.restart?.icon ?? null,
            powerOff: this._items.powerOff?.icon ?? null,
        };
    }

    getPowerButtons() {
        return {
            suspend: this._items.suspend?.button ?? null,
            restart: this._items.restart?.button ?? null,
            powerOff: this._items.powerOff?.button ?? null,
        };
    }

    updateVibrancy(promptColor) {
        this._lastPromptColor = promptColor;
        for (const key of ['suspend', 'restart', 'powerOff']) {
            const item = this._items[key];
            if (!item)
                continue;
            const colorKey = `${key}Color`;
            const colorObj = promptColor
                ? (promptColor[colorKey] ?? (promptColor.r != null ? promptColor : null))
                : null;
            this._setupButtonItem(item, colorObj, promptColor);
        }
    }

    _setupButtonItem(item, colorObj, promptColor) {
        const { button, icon, label } = item;
        if (!button || !icon)
            return;

        if (!colorObj || colorObj.r == null || colorObj.g == null || colorObj.b == null) {
            button.disconnectObject(this);
            if (icon._wackOriginalStyle !== undefined) {
                icon.set_style(icon._wackOriginalStyle);
                delete icon._wackOriginalStyle;
            } else {
                icon.set_style(null);
            }
            if (label) {
                label.set_style(null);
            }
            delete button._wackColor;
            delete button._wackPromptColor;
            delete button._wackMousePressed;
            delete button._wackKeyPressed;
            delete button._wackListenersConnected;
            return;
        }

        button._wackColor = colorObj;
        button._wackPromptColor = promptColor;

        if (!button._wackListenersConnected) {
            button._wackListenersConnected = true;
            if (icon._wackOriginalStyle === undefined) {
                icon._wackOriginalStyle = icon.get_style() ?? '';
            }

            button.connectObject(
                'notify::hover', () => {
                    if (!button.hover)
                        button._wackMousePressed = false;
                    this._updateItemStyle(item);
                },
                'notify::has-focus', () => this._updateItemStyle(item),
                'notify::pseudo-class', () => this._updateItemStyle(item),
                'notify::checked', () => this._updateItemStyle(item),
                'clicked', () => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    this._updateItemStyle(item);
                },
                'button-press-event', () => {
                    button._wackMousePressed = true;
                    this._updateItemStyle(item);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackMousePressed = false;
                    this._updateItemStyle(item);
                    return Clutter.EVENT_PROPAGATE;
                },
                'leave-event', () => {
                    button._wackMousePressed = false;
                    this._updateItemStyle(item);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-press-event', (actor, event) => {
                    const keyval = event.get_key_symbol();
                    if (keyval === Clutter.KEY_space || keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter || keyval === Clutter.KEY_ISO_Enter) {
                        button._wackKeyPressed = true;
                        this._updateItemStyle(item);
                    }
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-release-event', (actor, event) => {
                    button._wackKeyPressed = false;
                    this._updateItemStyle(item);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-focus-out', () => {
                    button._wackKeyPressed = false;
                    button._wackMousePressed = false;
                    this._updateItemStyle(item);
                },
                this
            );
        }

        this._updateItemStyle(item);
    }

    _updateItemStyle(item) {
        const { button, icon, label } = item;
        if (!button || !icon)
            return;

        const colorObj = button._wackColor;
        if (!colorObj || colorObj.r == null || colorObj.g == null || colorObj.b == null)
            return;

        const isPressed = button._wackMousePressed ||
            button._wackKeyPressed ||
            button.has_style_pseudo_class('active') ||
            button.has_style_pseudo_class('checked') ||
            button.checked;
        const isHovered = button.hover && !isPressed;
        const isFocused = button.has_focus;

        const visualState = colorObj.visualState ?? button._wackPromptColor?.visualState ?? colorObj;
        const hoverAlpha = getChromeAlpha(visualState, 'hover');
        const activeAlpha = getChromeAlpha(visualState, 'active');

        let curR = colorObj.r;
        let curG = colorObj.g;
        let curB = colorObj.b;

        if (isPressed) {
            const invA = 1 - activeAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * activeAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * activeAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * activeAlpha)));
        } else if (isHovered) {
            const invA = 1 - hoverAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * hoverAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * hoverAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * hoverAlpha)));
        }

        let overlayStyle = '';
        if (isHovered) {
            overlayStyle += ` color: #ffffff !important;`;
        }
        if (isFocused) {
            overlayStyle += ` border: 1px solid rgba(255, 255, 255, 0.8) !important;`;
        }

        const bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${curR}, ${curG}, ${curB}) !important;${overlayStyle}`;

        icon.set_style(`${icon._wackOriginalStyle ?? ''}${bgStyle}`);

        if (label) {
            label.set_style(getUserLabelStyle(visualState));
        }
    }

    /**
     * Toggle CSA (per-user setting from the cross-session manifest).
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this._userEnabled = Boolean(enabled);
        if (!this.actor)
            return;
        this.actor.visible = this._userEnabled;
        this.syncQuickSettingsVisibility();
    }

    /**
     * Re-syncs Quick Settings power menu visibility based on whether CSA is currently
     * accessible (i.e. user selection picker is visible and CSA is enabled).
     * When at password prompts or where CSA is hidden, Quick Settings power options are restored.
     */
    syncQuickSettingsVisibility() {
        const dialog = this._gdm?._dialog;
        const isUserListShowing = Boolean(dialog?._userSelectionBox?.visible && dialog?._userSelectionBox?.opacity > 0);
        const shouldHideQuickSettings = this._userEnabled && Boolean(this.actor?.visible) && isUserListShowing;
        this._setQuickSettingsPowerMenuHidden(shouldHideQuickSettings);
    }

    // GNOME re-syncs ShutdownItem's visibility whenever an action's
    // availability changes; shadow it while CSA replaces the Quick Settings
    // power options. Quick Settings loads asynchronously, so an unsuccessful
    // lookup is deliberately retried by subsequent state changes.
    _setQuickSettingsPowerMenuHidden(hidden) {
        if (hidden && !this._shutdownItem) {
            const systemItem = Main.panel.statusArea.quickSettings?._system?._systemItem;
            const item = systemItem?.child?.get_children().find(child =>
                child?.constructor?.name === 'ShutdownItem');
            if (!item?._sync)
                return;
            this._shutdownItem = item;
            item._sync = () => (item.visible = false);
            item._sync();
            item.menu?.close();
        } else if (!hidden && this._shutdownItem) {
            delete this._shutdownItem._sync;
            this._shutdownItem._sync();
            this._shutdownItem = null;
        }
    }

    teardown() {
        this.updateVibrancy(null);
        this._setQuickSettingsPowerMenuHidden(false);
        this.actor?.destroy();
        this.actor = null;
        this._items = {};
    }
}
