#!/usr/bin/env bash

# WACK - Sonoma Lockscreen GDM DLC Installer
# This script automates system-wide installation and GDM configuration.

set -euo pipefail

UUID="wack-lockscreen-clock@rinzler69-wastaken.github.com"
TARGET_DIR="/usr/share/gnome-shell/extensions/$UUID"
DCONF_GDM_DIR="/etc/dconf/db/gdm.d"
DCONF_FILE="$DCONF_GDM_DIR/99-wack-lockscreen"

# Ensure script is run with root privileges
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root. Elevating privileges..."
    if [[ "$0" == *"install-gdm-dlc.sh" ]]; then
        exec sudo bash "$0" "$@"
    else
        sudo bash -c "$(curl -sSL 'https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-gdm-dlc.sh')"
        exit $?
    fi
fi

# Try to find the source directory
SRC_DIR=""
# 1. Check if running from a local clone (scripts/ folder)
if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
    if [ -d "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../metadata.json" ]; then
        SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    fi
fi

if [ -z "$SRC_DIR" ]; then
    # Fallback to known extension directories
    REAL_HOME="${SUDO_USER_HOME:-${HOME}}"
    if [ -n "${SUDO_USER:-}" ]; then
        REAL_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    fi
    LOCAL_USER_DIR="$REAL_HOME/.local/share/gnome-shell/extensions/$UUID"
    SYSTEM_DIR="/usr/share/gnome-shell/extensions/$UUID"
    
    if [ -f "$LOCAL_USER_DIR/metadata.json" ]; then
        SRC_DIR="$LOCAL_USER_DIR"
    elif [ -f "$SYSTEM_DIR/metadata.json" ]; then
        SRC_DIR="$SYSTEM_DIR"
    else
        echo "Error: Could not locate Sonoma Lockscreen installation directory."
        echo "Please install the extension first (e.g. from Extensions.gnome.org)."
        exit 1
    fi
fi

echo "=== WACK Lockscreen GDM DLC Installer ==="
echo "Source Directory: $SRC_DIR"
echo "Target Directory: $TARGET_DIR"

if [ -f "$TARGET_DIR/gdm.js" ] && [ -f "$TARGET_DIR/crossSessionManager.js" ] && [ -f "$DCONF_FILE" ]; then
    echo ""
    echo "✨ GDM Expansion is already fully installed on this system!"
    echo "You don't need to run this script again."
    exit 0
fi

# 1. Sync extension system-wide
echo "-> Deploying extension system-wide..."
mkdir -p "$TARGET_DIR"
if command -v rsync &> /dev/null; then
    rsync -a --delete \
        --exclude=".git*" \
        --exclude="*.zip" \
        --exclude="*.bak" \
        --exclude="checkthisthingblyat" \
        --exclude="gdm.js" \
        --exclude="crossSessionManager.js" \
        "$SRC_DIR/" "$TARGET_DIR/"
else
    echo "rsync not found, falling back to cp..."
    cp -rT "$SRC_DIR" "$TARGET_DIR"
fi

# 2. Deploy DLC modules (gdm.js and crossSessionManager.js)
echo "-> Deploying DLC modules..."
REPO_RAW_URL="https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main"
for module in "gdm.js" "crossSessionManager.js"; do
    if [ -f "$SRC_DIR/$module" ]; then
        echo "   Copying local $module..."
        cp "$SRC_DIR/$module" "$TARGET_DIR/"
    else
        echo "   Downloading $module from repository..."
        curl -sSL "$REPO_RAW_URL/$module" -o "$TARGET_DIR/$module"
    fi
done

# 3. Patch metadata.json to include 'gdm' in session-modes
echo "-> Adding 'gdm' session-mode in metadata.json..."
python3 -c "
import json, sys
metadata_path = '$TARGET_DIR/metadata.json'
try:
    with open(metadata_path, 'r') as f:
        data = json.load(f)
    modes = data.get('session-modes', [])
    if 'gdm' not in modes:
        modes.append('gdm')
        data['session-modes'] = modes
        with open(metadata_path, 'w') as f:
            json.dump(data, f, indent=2)
        print('Successfully added GDM mode.')
    else:
        print('GDM mode already present.')
except Exception as e:
    print(f'Error patching metadata.json: {e}', file=sys.stderr)
    sys.exit(1)
"

# 4. Compile schemas system-wide
echo "-> Compiling GSettings schemas..."
if [ -d "$TARGET_DIR/schemas" ]; then
    glib-compile-schemas "$TARGET_DIR/schemas/"
else
    echo "Warning: No schemas directory found in target!"
fi

# 5. Configure GDM dconf system-db overrides
echo "-> Configuring GDM dconf system-db overrides..."
mkdir -p "$DCONF_GDM_DIR"
cat <<EOF > "$DCONF_FILE"
[org/gnome/shell]
enabled-extensions=['$UUID']
disable-user-extensions=false
EOF
chmod 644 "$DCONF_FILE"

# 6. Compile the GDM dconf binary database
echo "-> Compiling dconf database..."
dconf update

echo "========================================="
echo "GDM DLC installation complete!"
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
