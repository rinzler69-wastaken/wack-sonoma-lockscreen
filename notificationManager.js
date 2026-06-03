import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let Blur = null;
try {
    Blur = (await import('gi://Blur')).default;
} catch (_) {
}

import {
    NOTIF_BLUR_NAME,
    NOTIF_BLUR_RADIUS,
    NOTIF_BLUR_BRIGHTNESS,
    NOTIF_CARD_RADIUS,
    MAX_VISIBLE_CARDS,
    HINT_VERTICAL_FRACTION,
    HINT_NOTIF_MARGIN
} from './constants.js';

const shellGettext = Gettext.domain('gnome-shell').gettext.bind(Gettext.domain('gnome-shell'));

export class NotificationManager {
    constructor(extension) {
        this._extension = extension;
        this._lastPlayingPlayer = null;
        this._playerSignalIds = new Map();
        this._playerActorIds = new Map();
        this._cardVisSignalIds = new Map();
        this._notifBox = null;
    }

    _makeCardBlur() {
        if (Blur) {
            return new Blur.BlurEffect({
                name: NOTIF_BLUR_NAME,
                mode: Blur.BlurMode.BACKGROUND,
                radius: NOTIF_BLUR_RADIUS,
                brightness: NOTIF_BLUR_BRIGHTNESS,
                corner_radius: NOTIF_CARD_RADIUS,
            });
        } else {
            return new Shell.BlurEffect({
                name: NOTIF_BLUR_NAME,
                mode: Shell.BlurMode.BACKGROUND,
                radius: NOTIF_BLUR_RADIUS,
                brightness: NOTIF_BLUR_BRIGHTNESS,
            });
        }
    }

    _addCardBlur(actor) {
        if (!actor.get_effect(NOTIF_BLUR_NAME)) {
            actor.add_effect(this._makeCardBlur());
            actor.set_style(`border-radius: ${NOTIF_CARD_RADIUS}px;`);
        }
    }

    _removeCardBlur(actor) {
        const effect = actor.get_effect(NOTIF_BLUR_NAME);
        if (effect) actor.remove_effect(effect);
        actor.set_style(null);
    }

    setNotifBlursEnabled(enabled) {
        const nb = this._extension._dialog?._notificationsBox;
        if (!nb) return;
        for (const child of nb._notificationBox.get_children()) {
            const effect = child.get_effect(NOTIF_BLUR_NAME);
            if (effect) effect.set_enabled(enabled);
        }
        for (const msg of nb._players.values()) {
            const effect = msg.get_effect(NOTIF_BLUR_NAME);
            if (effect) effect.set_enabled(enabled);
        }
    }

    _isMediaCard(nb, actor) {
        for (const msg of nb._players.values()) {
            if (msg === actor) return true;
        }
        return false;
    }

    _getMediaPlayer(nb, actor) {
        for (const [player, msg] of nb._players.entries()) {
            if (msg === actor) return player;
        }
        return null;
    }

    _trackMediaPlayer(nb, player, actor) {
        if (!player || !actor) return;

        this._playerActorIds.set(actor, player);

        if (this._playerSignalIds.has(player)) {
            if (player.status === 'Playing')
                this._lastPlayingPlayer = player;
            return;
        }

        let prevStatus = player.status;
        const id = player.connect('changed', () => {
            const newStatus = player.status;
            if (newStatus === 'Playing' && prevStatus !== 'Playing')
                this._lastPlayingPlayer = player;
            prevStatus = newStatus;
            if (this._notifBox === nb)
                this.enforceCardLimit(nb);
        });

        this._playerSignalIds.set(player, id);
        if (player.status === 'Playing')
            this._lastPlayingPlayer = player;
    }

    hasVisibleNotifs() {
        const nb = this._notifBox;
        if (!nb) return false;

        if (!this._extension._notifShowInLockScreen) {
            return false;
        }

        let hasVisibleCard = false;
        const notifContainer = nb._notificationBox;
        if (notifContainer) {
            for (let child = notifContainer.get_first_child(); child !== null; child = child.get_next_sibling()) {
                if (child.visible) {
                    hasVisibleCard = true;
                    break;
                }
            }
        }

        let hasVisiblePlayer = false;
        if (nb._players) {
            for (const m of nb._players.values()) {
                if (m.visible) {
                    hasVisiblePlayer = true;
                    break;
                }
            }
        }

        const nativelyHasNotifs = hasVisibleCard || hasVisiblePlayer;

        if (this._extension._lockscreenMode === 'cupertino' && this._extension._cupertinoAlwaysShowUser) {
            if (!this._extension._cupertinoShowNotifsOverride) {
                return false;
            }
        }

        return nativelyHasNotifs;
    }

    getNativeNotifCount() {
        const nb = this._notifBox;
        if (!nb) return 0;

        let count = 0;

        for (const m of nb._players?.values() ?? []) {
            if (m.visible) count++;
        }

        const shellVisible = new Set();
        if (nb._sources) {
            for (const [source, obj] of nb._sources.entries()) {
                if (obj.sourceBox && source.unseenCount > 0 && obj.visible) {
                    shellVisible.add(obj.sourceBox);
                }
            }
        }

        const children = nb._notificationBox?.get_children() ?? [];
        children.forEach(child => {
            if (child && !this._isMediaCard(nb, child) && shellVisible.has(child)) {
                count++;
            }
        });

        return count;
    }

    _enforceMediaLimit(nb) {
        const players = [...nb._players.entries()];

        for (const [, msg] of players) msg.visible = false;

        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg && this._lastPlayingPlayer.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        for (const [player, msg] of players) {
            if (player.status === 'Playing') {
                msg.visible = true;
                return;
            }
        }

        if (this._lastPlayingPlayer) {
            const msg = nb._players.get(this._lastPlayingPlayer);
            if (msg) { msg.visible = true; return; }
        }

        const firstMsg = nb._players.values().next().value;
        if (firstMsg) firstMsg.visible = true;
    }

    setupNotifBlur(nb) {
        nb._players ??= new Map();

        for (const [player, actor] of nb._players.entries())
            this._trackMediaPlayer(nb, player, actor);

        for (const child of nb._notificationBox.get_children())
            this._addCardBlur(child);
        this.enforceCardLimit(nb);

        nb._notificationBox.connectObject(
            'child-added', (container, actor) => {
                this._extension?._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!this._extension) return GLib.SOURCE_REMOVE;
                    if (!actor.get_parent()) return GLib.SOURCE_REMOVE;

                    this._addCardBlur(actor);

                    const player = this._getMediaPlayer(nb, actor);
                    if (player) {
                        this._trackMediaPlayer(nb, player, actor);
                    } else {
                        const visId = actor.connect('notify::visible', () => {
                            this._extension?._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                if (!this._extension) return GLib.SOURCE_REMOVE;
                                this.enforceCardLimit(nb);
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                        this._cardVisSignalIds.set(actor, visId);
                    }
                    this.enforceCardLimit(nb);
                    this._extension._updateCupertinoRestState();
                    return GLib.SOURCE_REMOVE;
                });
            },
            'child-removed', (container, actor) => {
                if (this._cardVisSignalIds.has(actor)) {
                    try { actor.disconnect(this._cardVisSignalIds.get(actor)); } catch (_) { }
                    this._cardVisSignalIds.delete(actor);
                }
                const player = this._playerActorIds.get(actor) ?? this._getMediaPlayer(nb, actor);
                if (player && this._playerSignalIds.has(player)) {
                    try { player.disconnect(this._playerSignalIds.get(player)); } catch (_) { }
                    this._playerSignalIds.delete(player);
                }
                this._playerActorIds.delete(actor);

                this._extension?._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!this._extension) return GLib.SOURCE_REMOVE;
                    this.enforceCardLimit(nb);
                    this._extension._updateCupertinoRestState();
                    return GLib.SOURCE_REMOVE;
                });
            }, this._extension);

        this._notifBox = nb;
    }

    enforceCardLimit(nb) {
        if (nb._players.size > 0)
            this._enforceMediaLimit(nb);

        const children = nb._notificationBox.get_children();
        let notifCount = 0;
        let hiddenCount = 0;

        const shellVisible = new Set();
        for (const [source, obj] of nb._sources.entries()) {
            if (obj.sourceBox && source.unseenCount > 0 && obj.visible) {
                shellVisible.add(obj.sourceBox);
            }
        }

        children.forEach(child => {
            if (!child || this._isMediaCard(nb, child)) return;

            if (!shellVisible.has(child)) {
                child.visible = false;
                return;
            }

            if (notifCount < MAX_VISIBLE_CARDS) {
                child.visible = true;
            } else {
                child.visible = false;
                hiddenCount++;
            }
            notifCount++;
        });

        this.updateOverflow(hiddenCount);
    }

    updateOverflow(hiddenCount) {
        if (!this._extension._overflowLabel) return;

        if (hiddenCount <= 0) {
            this._extension._overflowActive = false;
            this._extension._overflowLabel.visible = false;
            if (this._extension._hint) this._extension._hint.visible = true;
            return;
        }

        this._extension._overflowActive = true;
        if (this._extension._hint) {
            this._extension._hint.visible = false;
            this._extension._hint.set_opacity(0);
        }

        let moreText = this._extension.gettext('more');
        if (moreText === 'more') {
            moreText = Gettext.pgettext('calendar', 'More').toLowerCase();
            if (moreText === 'more')
                moreText = shellGettext('More').toLowerCase();
        }

        const overflowText = `${hiddenCount}+ ${moreText}`;
        this._extension._overflowLabel.text = `${overflowText}  ·  ${this._extension._hintText}`;
        this._extension._overflowLabel.visible = true;
        this._extension._overflowLabel.set_opacity(255);
        this.positionOverflow();
    }

    positionOverflow() {
        if (!this._extension._overflowLabel) return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorX = monitor.x / scaleFactor;
        const monitorY = monitor.y / scaleFactor;
        const monitorWidth = monitor.width / scaleFactor;
        const monitorHeight = monitor.height / scaleFactor;

        const [, natWidth] = this._extension._overflowLabel.get_preferred_width(-1);
        const [, natHeight] = this._extension._overflowLabel.get_preferred_height(-1);

        const notifBox = this._extension._dialog?._notificationsBox;
        const notifHeight = notifBox?.visible ? notifBox.height : 0;

        const idealY = monitorY + Math.floor(monitorHeight * HINT_VERTICAL_FRACTION);
        const notifTop = monitorY + monitorHeight - notifHeight - HINT_NOTIF_MARGIN - natHeight;
        const y = Math.min(idealY, notifTop);
        const x = monitorX + Math.floor((monitorWidth - natWidth) / 2);

        this._extension._overflowLabel.set_position(x, y);
    }

    teardownNotifBlur() {
        const nb = this._notifBox;
        if (!nb) return;

        nb.opacity = 255;

        nb._notificationBox.disconnectObject(this._extension);

        if (this._playerSignalIds) {
            for (const [player, id] of this._playerSignalIds.entries()) {
                try { player.disconnect(id); } catch (_) { }
            }
            this._playerSignalIds.clear();
        }
        this._playerActorIds.clear();

        if (this._cardVisSignalIds) {
            for (const [actor, id] of this._cardVisSignalIds.entries()) {
                try { actor.disconnect(id); } catch (_) { }
            }
            this._cardVisSignalIds.clear();
        }

        for (const child of nb._notificationBox.get_children()) {
            child.visible = true;
            this._removeCardBlur(child);
        }
        for (const msg of nb._players.values())
            msg.visible = true;

        this._notifBox = null;
        this._lastPlayingPlayer = null;
        // Break the back-reference to the extension to avoid a reference cycle.
        this._extension = null;
    }
}
