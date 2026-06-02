<h1 align="center">WACK – Sonoma Lockscreen</h1>

<p align="center">
  <a href="https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen/stargazers"><img src="https://img.shields.io/github/stars/rinzler69-wastaken/wack-sonoma-lockscreen?style=flat&color=yellow" alt="Stars"/></a>
  <a href="https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License"/></a>
  <a href="https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen/releases"><img src="https://img.shields.io/github/v/release/rinzler69-wastaken/wack-sonoma-lockscreen" alt="Release"/></a>
  <img src="https://img.shields.io/badge/GNOME-46--50-77767B?logo=gnome&logoColor=white" alt="GNOME Version"/>
</p>

<p align="center">
A simple GNOME Extension that brings macOS Sonoma-inspired lockscreen to your GNOME Desktop.
</p>

<p align="center">
  <img src="screenshots/screenshot1.png" width="48%" />
  <img src="screenshots/screenshot2.png" width="48%" />
</p>

This is a part of the WACK project (WACK Ain't Cupertino, Kid), a collection of tweaks aimed at bringing a refined, macOS-inspired aesthetic to the GNOME desktop.

This specific extension focuses on the lock screen (unlockDialog), replacing the standard clock with a clean, Sonoma-inspired layout.

## Features, and What it does
- **Custom Clock Layout** <br>
Repositions the date and time to the upper third of the screen. <br><br>

- **Focused Interaction** <br>
The background stays sharp and clear in its resting state. Blur only fades in when you're ready to enter your password, keeping the focus on the prompt. <br><br>

- **Enhanced Readability** <br>
Notification cards feature an adaptive blur (which crossfades with the prompt blur), ensuring text remains crisp and legible regardless of your wallpaper. <br><br>

- **Clean Notification Management** <br>
Limits the number of visible cards to prevent lockscreen clutter, capping them with a subtle "N+ more" notice. <br><br>

- **NEW: Cupertino Mode** <br>
Brings a macOS Sonoma-inspired lockscreen layout — clock stays persistent, a compact user widget sits at the bottom when notifications are empty, and the password prompt crossfades in on demand. Notification cards fade out gracefully when the prompt appears. You can make user widget **persistent** regardless of notification presence via `Lockscreen Mode > Always Show User Widget`. Need to see notifications? Hit `Shift + N`. <br><br>

- **NEW: Custom Clock/Prompt Animations** <br>
Choose how the clock exits and the prompt enters from a selection of animations — Scale Down, Zoom Up, Slide Up, and Fade for the clock; Rise, Zoom, Fade, and GNOME Default for the prompt. Disabled in Cupertino Mode. <br><br>

## Best Used With
This extension is designed to complement the default Adwaita theme (Adwaita Sans default font in mind),and various other GNOME desktop configurations, but works standalone. 
For the closest Sonoma feel:

- **[Open Runde](https://github.com/lauridskern/open-runde)** — Recommended font for the clock numerals. Install and set `font-family: 'Open Runde'` in `stylesheet.css` under `.wack-time`. Approximates SF Pro Rounded's warmth at large sizes.

- **[Inter](https://rsms.me/inter/)** — Recommended for date and hint text.

> Neither font is bundled. Install system-wide (`~/.local/share/fonts/`) or per-user and run `fc-cache -fv` after.

Pairs well with:

- **[Live Lock Screen](https://github.com/nick-redwill/LiveLockScreen)** — Play any video as your lock screen background. Pairs seamlessly with Sonoma Lockscreen — the blur and prompt transitions layer on top of the live wallpaper with full compatibility (may need tweaks on blur characteristics on this extension's settings, or turning off "Change Blur", for Cupertino Mode.). May require GStreamer plugins.


## Technical Details
- State-Aware: Uses ```set_enabled``` logic for blur effects (the notif blur-prompt blur crossfade) to keep your GPU happy.
- Vanilla Compatibility: Built primarily for GNOME 45–50 (GNOME ESModule era) (IMPORTANT: See Compatibility Below).
- Cupertino Mode:Achieves the macOS-style layout through a combination of actor reparenting into the lock dialog stack, a custom WackLayout allocator that pins the prompt to the lower screen, runtime method patching to suppress the native avatar and blur, and opacity-driven crossfades that smoothly swap between the rest widget, floating avatar, notification cards, and auth prompt across all transition states.
- LiveLockScreen Compatible: Swipe-to-unlock gestures correctly trigger blur transitions when used alongside Live Lock Screen, with no extra configuration needed.


## Install / update (one-step Makefile)
Prereqs: `make`, `rsync`, `python3`, `gettext` (for locale compilation), GNOME Shell 46–50.

```bash
git clone https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen.git
cd wack-sonoma-lockscreen
make            # compiles .mo locale files, copies everything into ~/.local/share/gnome-shell/extensions/
```

Then reload GNOME Shell (`Alt+F2` → `r` on Xorg; logout/login on Wayland) and enable:

```bash
gnome-extensions enable wack-lockscreen-clock@rinzler69-wastaken.github.com
```

If you prefer one command after clone:

```bash
make enable
```

> **Locale files** (`locale/*.mo`) are build artifacts — they are generated automatically by `make` and excluded from the git repository. The source translations live in `po/`.

Manual Tweak: If you want to change the blur strength or clock position, you can find the constants right at the top of ```extension.js.```

## Usage Tips
- **Best at 100% scaling** — The lockscreen layout is tuned for 100% (1×) display scaling. At fractional scaling (125%, 150%, etc.) the clock and prompt positions may appear slightly off. If you're on a HiDPI display, 100% + font scaling via GNOME Tweaks gives the cleanest result.
- **Cupertino Mode** — Enable it in the extension preferences. Hit `Shift + N` on the lockscreen to toggle notification visibility when the user widget is always shown.

## Compatibility
Developed and tested on GNOME 50 (Fedora). Backward compatibility tested down to GNOME 46 via GNOME Boxes VMs. Reported issues on GNOME 49 + NVIDIA (works fine on GNOME 49 without NVIDIA). Feel free to open an issue if bugs are found, or clone and contribute!

## About the WACK Project
WACK (WACK Ain't Cupertino, Kid) brings the best design patterns and details from macOS to the GNOME Desktop — dock magnification, traffic-light window controls, lockscreen layout, quick settings layouts, and many more to come — built entirely within what GNOME already gives you.
