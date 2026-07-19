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
        sudo bash -c "$(curl -sSL 'https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/gdm-windowfade2/scripts/uninstall-gdm-dlc.sh')"
        exit $?
    fi
fi

echo "=== WACK Lockscreen GDM DLC Uninstaller ==="
echo "Target Directory: $TARGET_DIR"

# 1. Check if already uninstalled
if [ ! -f "$TARGET_DIR/gdm.js" ] && [ ! -f "$TARGET_DIR/crossSessionManager.js" ] && [ ! -f "$DCONF_FILE" ]; then
    echo ""
    echo "✨ GDM Expansion is already uninstalled from this system."
    exit 0
fi

# 2. Revert metadata.json session-modes
echo "-> Removing 'gdm' session-mode from metadata.json..."
if [ -f "$TARGET_DIR/metadata.json" ]; then
    python3 -c "
import json, sys
metadata_path = '$TARGET_DIR/metadata.json'
try:
    with open(metadata_path, 'r') as f:
        data = json.load(f)
    modes = data.get('session-modes', [])
    if 'gdm' in modes:
        modes.remove('gdm')
        data['session-modes'] = modes
        with open(metadata_path, 'w') as f:
            json.dump(data, f, indent=2)
        print('Successfully removed GDM mode.')
    else:
        print('GDM mode was not present.')
except Exception as e:
    print(f'Error patching metadata.json: {e}', file=sys.stderr)
    sys.exit(1)
"
else
    echo "metadata.json not found, skipping..."
fi

# 3. Remove GDM DLC modules
echo "-> Removing GDM DLC modules..."
rm -f "$TARGET_DIR/gdm.js"
rm -f "$TARGET_DIR/crossSessionManager.js"

# 4. Remove GDM dconf override
echo "-> Removing GDM dconf overrides..."
rm -f "$DCONF_FILE"

# 5. Compile the GDM dconf binary database
echo "-> Recompiling dconf database..."
dconf update

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
