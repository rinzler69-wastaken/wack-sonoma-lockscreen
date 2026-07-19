#!/usr/bin/env bash

# WACK - Sonoma Lockscreen GDM DLC Uninstaller
# This script automates system-wide uninstallation and reverts GDM configuration.

set -euo pipefail

UUID="wack-lockscreen-clock@rinzler69-wastaken.github.com"
TARGET_DIR="/usr/share/gnome-shell/extensions/$UUID"
DCONF_GDM_DIR="/etc/dconf/db/gdm.d"
DCONF_FILE="$DCONF_GDM_DIR/99-wack-lockscreen"

# Ensure script is run with root privileges
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root. Elevating privileges..."
    if [[ "$0" == *"uninstall-gdm-dlc.sh" ]]; then
        exec sudo bash "$0" "$@"
    else
        sudo bash -c "$(curl -sSL 'https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/uninstall-gdm-dlc.sh')"
        exit $?
    fi
fi

# Determine the user extension directory
REAL_HOME="${SUDO_USER_HOME:-${HOME}}"
if [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
fi
USER_DIR="$REAL_HOME/.local/share/gnome-shell/extensions/$UUID"

echo "=== WACK Lockscreen GDM DLC Uninstaller ==="
echo "System Directory: $TARGET_DIR"
echo "User Directory: $USER_DIR"

# 1. Check if already uninstalled
if [ ! -d "$TARGET_DIR" ] && [ ! -f "$DCONF_FILE" ]; then
    echo ""
    echo "✨ GDM Expansion is already uninstalled from GDM."
    exit 0
fi

# 2. Restore/Ensure user directory exists and clean it up
if [ ! -d "$USER_DIR" ]; then
    echo "-> Restoring extension back to user directory ($USER_DIR)..."
    mkdir -p "$USER_DIR"
    if command -v rsync &> /dev/null; then
        rsync -a \
            --exclude="pro.js" \
            --exclude="crossSessionManager.js" \
            "$TARGET_DIR/" "$USER_DIR/"
    else
        cp -r "$TARGET_DIR"/* "$USER_DIR/"
        rm -f "$USER_DIR/pro.js" "$USER_DIR/crossSessionManager.js"
    fi
    
    # Ensure correct ownership for user directory
    if [ -n "${SUDO_USER:-}" ]; then
        chown -R "$SUDO_USER:$(id -gn "$SUDO_USER")" "$USER_DIR"
    fi
fi

# 3. Clean up GDM/PRO hooks and modules from user-level extension
echo "-> Cleaning up GDM hooks from user-level extension..."
rm -f "$USER_DIR/pro.js"
rm -f "$USER_DIR/crossSessionManager.js"
for file in "extension.js" "prefs.js"; do
    if [ -f "$USER_DIR/$file" ]; then
        python3 -c "import re; c=open('$USER_DIR/$file').read(); c=re.sub(r'//\s*<GDM_EXCLUDE>.*?//\s*</GDM_EXCLUDE>', '', c, flags=re.DOTALL); open('$USER_DIR/$file','w').write(c)"
    fi
done

# Remove 'gdm' from user-level metadata.json session-modes
if [ -f "$USER_DIR/metadata.json" ]; then
    python3 -c "
import json
metadata_path = '$USER_DIR/metadata.json'
try:
    with open(metadata_path, 'r') as f:
        data = json.load(f)
    modes = data.get('session-modes', [])
    if 'gdm' in modes:
        modes.remove('gdm')
        data['session-modes'] = modes
        with open(metadata_path, 'w') as f:
            json.dump(data, f, indent=2)
except Exception:
    pass
"
fi

# 4. Remove GDM dconf override
echo "-> Removing GDM dconf overrides..."
rm -f "$DCONF_FILE"

# 5. Compile the GDM dconf binary database
echo "-> Recompiling dconf database..."
dconf update

# 6. Delete the system-wide extension directory
echo "-> Removing system-wide extension files..."
rm -rf "$TARGET_DIR"

echo "========================================="
echo "GDM DLC uninstallation complete!"
echo "To apply changes, please restart GDM."
echo "WARNING: Restarting GDM will terminate your current graphical session!"
echo ""
read -rp "Would you like to restart GDM now? (y/N): " choice
case "$choice" in
    [yY][eE][sS]|[yY])
        echo "Restarting GDM..."
        systemctl restart gdm || service gdm restart
        ;;
    *)
        echo "Please run 'sudo systemctl restart gdm' later when you are ready to apply the changes."
        ;;
esac
