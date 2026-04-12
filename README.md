# WACK – Sonoma Lockscreen

macOS Sonoma‑style lock screen clock for GNOME Shell (unlock dialog session mode). Drops in a custom clock layout, typography, and prompt blur, inspired by macOS but kept lightweight and preference‑free.

## What it does
- Replaces the default lockscreen clock with a custom `WackClock` (date + large time + hint) and repositions it to the upper third of the screen.
- Separates the hint from the clock stack so it can sit lower on the screen and adjust when notifications are present.
- Smooth show/hide animations: the clock scales/fades during the transition; the hint stows when the prompt slides in.
- Prompt blur: when the password prompt appears, the lockscreen background is blurred (`PROMPT_BLUR_RADIUS/BRIGHTNESS`); blur is cleared when the clock returns.
- Uses bundled fonts for the time (Open Runde) and bundled Inter as the first fallback for date/hint; if the user has SF Pro installed, it will be picked up automatically via the font stack.
- All styling is controlled via CSS—no gsettings schemas or prefs UI.

## Files
- `extension.js` — logic, layout, blur/prompt hooks, and clock replacement.
- `stylesheet.css` — typography, spacing, and (optional) shadows. Uses `@font-face` pointing at `fonts/`.
- `fonts/` — bundled Open Runde (`OpenRunde-*.otf`) and `Inter-V.ttf` variable font.
- `metadata.json` — declares support for GNOME Shell 45–50, `unlock-dialog` only.

## Tweaking (edit and reload)
- Layout constants (top of `extension.js`):
  - `CLOCK_TOP_FRACTION` — vertical position of the clock.
  - `HINT_VERTICAL_FRACTION` and `HINT_NOTIF_MARGIN` — hint positioning relative to notifications.
  - `PROMPT_BLUR_RADIUS`, `PROMPT_BLUR_BRIGHTNESS`, `PROMPT_BLUR_DURATION` — prompt blur strength and animation.
  - `CROSSFADE_TIME`, `HINT_TIMEOUT` — hint fade timing.
- Fonts (`stylesheet.css`):
  - Time: `font-family: 'Open Runde';`
  - Date/Hint stack: `'SF Pro Text', 'SF Pro Display', 'Inter', system-ui, 'Cantarell', sans-serif;`
    - If you want pure system fonts, replace the stack; if you want SF, install it locally—nothing is bundled.
  - Uncomment the `text-shadow` in `.unlock-dialog-clock-hint` for a subtle glow; adjust blur/spread there.
- Colors, sizes, and letter‑spacing are all in `stylesheet.css`; no rebuild required.

## Install / update (one-step Makefile)
Prereqs: `make`, `rsync`, GNOME Shell 45–50.

```bash
git clone https://github.com/YOURUSER/wack-sonoma-lockscreen.git
cd wack-sonoma-lockscreen
make            # copies into ~/.local/share/gnome-shell/extensions/wack-lockscreen-clock@rinzler69-wastaken.github.com
```

Then reload GNOME Shell (`Alt+F2` → `r` on Xorg; logout/login on Wayland) and enable:

```bash
gnome-extensions enable wack-lockscreen-clock@rinzler69-wastaken.github.com
```

If you prefer one command after clone:

```bash
make enable
```

## Notes & limitations
- Runs only on the lock screen (`unlock-dialog` session mode); won’t affect the regular shell.
- No preferences dialog; edits are manual in `extension.js`/`stylesheet.css`.
- Notifications currently render over the wallpaper without their own blur—keeps text crisp. Prompt blur still applies when the password prompt shows.
- Date string comes from the `date` command; if it fails, falls back to JS locale formatting.

Happy Sonoma‑ing! 🎐
