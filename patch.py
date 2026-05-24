with open('extension.js', 'r') as f:
    content = f.read()

old = """        // ── Kill native CapsLockWarning and _message via CSS ─────────────
        // remove_child doesn't stick — authPrompt re-adds them on state changes.
        // Adding a class to authPrompt and targeting them in stylesheet.css with
        // !important overrides all inline opacity/height set by ease() calls.
        authPrompt.add_style_class_name('wack-cupertino-no-status');"""

new = """        // ── Suppress native CapsLockWarning and _message ─────────────────
        // St CSS !important loses to programmatic writes. The only reliable
        // approach: connect to every signal that changes their visual state
        // and synchronously zero them out before the next frame renders.
        const capsWarn = authPrompt._capsLockWarningLabel;
        const nativeMsg = authPrompt._message;

        if (capsWarn) {
            // _sync() fires on notify::mapped and keymap state-changed.
            // Override it at instance level — ours reads keymap directly.
            capsWarn._sync = () => {
                capsWarn.remove_all_transitions();
                capsWarn.set({ opacity: 0, height: 0 });
            };
            // Also fire immediately and on every map
            capsWarn._sync();
            this._cupertinoCapMappedId = capsWarn.connect('notify::mapped', () => capsWarn._sync());
        }

        if (nativeMsg) {
            const zeroMsg = () => {
                nativeMsg.remove_all_transitions();
                nativeMsg.set({ opacity: 0, visible: false });
            };
            zeroMsg();
            this._cupertinoNativeMsgOpacityId = nativeMsg.connect('notify::opacity', () => {
                if (nativeMsg.opacity !== 0) zeroMsg();
            });
            this._cupertinoNativeMsgVisibleId = nativeMsg.connect('notify::visible', () => {
                if (nativeMsg.visible) zeroMsg();
            });
            this._cupertinoNativeMsgTextId = nativeMsg.connect('notify::text', () => zeroMsg());
        }"""

assert old in content, "CSS kill block not found"
content = content.replace(old, new, 1)

# Fix teardown to disconnect the new signals and not remove class
old = """        authPrompt?.remove_style_class_name('wack-cupertino-no-status');"""
new = """        const capsWarn = authPrompt?._capsLockWarningLabel;
        if (capsWarn) {
            if (this._cupertinoCapMappedId) {
                capsWarn.disconnect(this._cupertinoCapMappedId);
                this._cupertinoCapMappedId = null;
            }
            // Restore _sync to prototype
            delete capsWarn._sync;
        }
        const nativeMsg = authPrompt?._message;
        if (nativeMsg) {
            if (this._cupertinoNativeMsgOpacityId) {
                nativeMsg.disconnect(this._cupertinoNativeMsgOpacityId);
                this._cupertinoNativeMsgOpacityId = null;
            }
            if (this._cupertinoNativeMsgVisibleId) {
                nativeMsg.disconnect(this._cupertinoNativeMsgVisibleId);
                this._cupertinoNativeMsgVisibleId = null;
            }
            if (this._cupertinoNativeMsgTextId) {
                nativeMsg.disconnect(this._cupertinoNativeMsgTextId);
                this._cupertinoNativeMsgTextId = null;
            }
        }"""

assert old in content, "class removal not found"
content = content.replace(old, new, 1)

with open('extension.js', 'w') as f:
    f.write(content)
print("Done")


