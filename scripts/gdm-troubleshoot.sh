#!/usr/bin/env bash
#
# gdm-troubleshoot.sh
#
# Remedy for: GNOME Shell extensions (e.g. gdm-mode extensions like
# WACK Sonoma Lockscreen) silently failing to load on the GDM greeter,
# even though metadata.json is valid, the extension is correctly
# listed in /etc/dconf/db/gdm.d/*, and `dconf read` against system-db:gdm
# shows the right enabled-extensions value.
#
# ROOT CAUSE (as diagnosed):
#   dconf's profile stack for the gdm greeter is:
#       user-db:user
#       system-db:gdm
#       file-db:/usr/share/gdm/greeter-dconf-defaults
#   The FIRST line (user-db:user) is a writable per-seat database and
#   takes priority over system-db:gdm. On some systems this resolves to
#   a file like /var/lib/gdm/seat0/config/dconf/user, owned by a
#   long-dead dynamically-allocated greeter UID from a previous boot.
#   If that stale file has org/gnome/shell/disable-user-extensions=true
#   left over from old testing, it silently overrides the correct
#   system-db:gdm config on every subsequent boot -- with NO error
#   logged anywhere, because it's not a crash, it's just... true.
#
# WHAT THIS SCRIPT DOES:
#   1. Locates the gdm per-seat dconf write-database.
#   2. Reads disable-user-extensions using the *exact* environment the
#      real greeter session uses (HOME, XDG_CONFIG_HOME, DCONF_PROFILE),
#      captured live from a running gdm-greeter gnome-shell process if
#      one is currently up, or falling back to the standard seat0 path.
#   3. If it's true, backs up (renames, never deletes) the stale file
#      and clears it so system-db:gdm takes over cleanly.
#   4. Optionally restarts gdm.service to apply immediately.
#
# This is read-only / non-destructive unless you pass --fix (and
# --restart-gdm additionally restarts the display manager, which will
# immediately kill your current graphical session).
#
# Usage:
#   sudo ./gdm-troubleshoot.sh                  # diagnose only
#   sudo ./gdm-troubleshoot.sh --fix            # diagnose + repair
#   sudo ./gdm-troubleshoot.sh --fix --restart-gdm   # + restart gdm
#
set -euo pipefail

FIX=false
RESTART_GDM=false
for arg in "$@"; do
    case "$arg" in
        --fix) FIX=true ;;
        --restart-gdm) RESTART_GDM=true ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^#//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "This script needs root (it reads/writes GDM's dconf state). Re-run with sudo." >&2
    exit 1
fi

echo "==> Looking for a live gdm-greeter gnome-shell process to capture its real environment..."

LIVE_PID=""
for i in $(seq 1 10); do
    LIVE_PID=$(ps -eo pid,uid,cmd | awk '$2!=1000 && $3=="/usr/bin/gnome-shell"{print $1; exit}' || true)
    [[ -n "$LIVE_PID" ]] && break
    sleep 0.3
done

GREETER_HOME=""
GREETER_XDG_CONFIG_HOME=""
GREETER_DCONF_PROFILE="gdm"

if [[ -n "$LIVE_PID" ]] && [[ -r "/proc/$LIVE_PID/environ" ]]; then
    echo "    Found live greeter gnome-shell PID $LIVE_PID -- reading its environment."
    while IFS='=' read -r -d '' key val; do
        case "$key" in
            HOME) GREETER_HOME="$val" ;;
            XDG_CONFIG_HOME) GREETER_XDG_CONFIG_HOME="$val" ;;
            DCONF_PROFILE) GREETER_DCONF_PROFILE="$val" ;;
        esac
    done < "/proc/$LIVE_PID/environ"
else
    echo "    No live greeter process caught (it may not be running right now)."
    echo "    Falling back to the standard seat0 path."
fi

# Fallbacks matching the standard GDM layout if we couldn't catch a live process
GREETER_HOME="${GREETER_HOME:-/run/gdm/home/gdm-greeter}"
GREETER_XDG_CONFIG_HOME="${GREETER_XDG_CONFIG_HOME:-/var/lib/gdm/seat0/config}"

STALE_DB="$GREETER_XDG_CONFIG_HOME/dconf/user"

echo
echo "==> Effective greeter environment:"
echo "    HOME=$GREETER_HOME"
echo "    XDG_CONFIG_HOME=$GREETER_XDG_CONFIG_HOME"
echo "    DCONF_PROFILE=$GREETER_DCONF_PROFILE"
echo "    -> per-seat write-db: $STALE_DB"
echo

if ! command -v dconf >/dev/null 2>&1; then
    echo "ERROR: dconf CLI not found. Cannot continue." >&2
    exit 1
fi

read_greeter_key() {
    local key="$1"
    env HOME="$GREETER_HOME" \
        XDG_CONFIG_HOME="$GREETER_XDG_CONFIG_HOME" \
        DCONF_PROFILE="$GREETER_DCONF_PROFILE" \
        dconf read "$key" 2>/dev/null || echo "(unreadable)"
}

DISABLE_VAL=$(read_greeter_key /org/gnome/shell/disable-user-extensions)
ENABLED_VAL=$(read_greeter_key /org/gnome/shell/enabled-extensions)

echo "==> Current resolved values (as the real greeter session sees them):"
echo "    disable-user-extensions = ${DISABLE_VAL:-<unset>}"
echo "    enabled-extensions      = ${ENABLED_VAL:-<unset>}"
echo

PROBLEM_FOUND=false
if [[ "$DISABLE_VAL" == "true" ]]; then
    PROBLEM_FOUND=true
    echo "!! FOUND THE PROBLEM: disable-user-extensions resolves to 'true'."
    echo "   This silently blocks ALL extensions in the GDM greeter session,"
    echo "   regardless of what enabled-extensions says."
else
    echo "-- disable-user-extensions does not currently resolve to true."
    echo "   If your extension still isn't showing up, the cause is something"
    echo "   else this time -- this script only targets this specific issue."
fi
echo

if [[ -e "$STALE_DB" ]]; then
    echo "==> Stale per-seat write-database details:"
    ls -la "$STALE_DB"
    echo "    Keys it defines:"
    strings "$STALE_DB" 2>/dev/null | grep -E '^[a-z-]+$' | sed 's/^/      - /' || true
    echo
fi

if [[ "$PROBLEM_FOUND" == false ]]; then
    echo "Nothing to fix. Exiting."
    exit 0
fi

if [[ "$FIX" == false ]]; then
    echo "Run again with --fix to back up and clear the stale database:"
    echo "    sudo $0 --fix"
    echo "Add --restart-gdm to also restart gdm.service immediately afterward"
    echo "(this WILL kill your current graphical session)."
    exit 0
fi

if [[ ! -e "$STALE_DB" ]]; then
    echo "ERROR: disable-user-extensions is true, but the expected stale db" >&2
    echo "       ($STALE_DB) doesn't exist. Not safe to auto-fix -- investigate manually." >&2
    exit 1
fi

BACKUP="${STALE_DB}.bak.$(date +%Y%m%d%H%M%S)"
echo "==> Backing up stale db to: $BACKUP"
mv "$STALE_DB" "$BACKUP"

echo "==> Re-checking resolved value now that the stale db is out of the way..."
DISABLE_VAL_AFTER=$(read_greeter_key /org/gnome/shell/disable-user-extensions)
echo "    disable-user-extensions = ${DISABLE_VAL_AFTER:-<unset, i.e. fixed>}"

if [[ "$DISABLE_VAL_AFTER" == "true" ]]; then
    echo
    echo "!! Still true after removing $STALE_DB. There may be a second stale"
    echo "   write-db (check $GREETER_HOME and any other dconf/user files found via:"
    echo "     find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -ipath '*dconf/user' -print"
    echo "   Restoring the backup is NOT necessary -- it's harmless to leave removed --"
    echo "   but the actual override is coming from somewhere else. Investigate further"
    echo "   before restarting gdm."
    exit 1
fi

echo
echo "Fixed. (Backup kept at $BACKUP -- delete it once you've confirmed the greeter works.)"

if [[ "$RESTART_GDM" == true ]]; then
    echo
    echo "==> Restarting gdm.service now. This will end your current graphical session."
    sleep 2
    systemctl restart gdm
else
    echo
    echo "Run 'sudo systemctl restart gdm' when you're ready to apply this"
    echo "(it will immediately end your current graphical session)."
fi
