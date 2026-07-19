#!/usr/bin/env bash

# WACK - Sonoma Lockscreen GDM DLC Installer
# This script automates system-wide installation and GDM configuration.

set -euo pipefail

UUID="wack-lockscreen-clock@rinzler69-wastaken.github.com"
TARGET_DIR="/usr/share/gnome-shell/extensions/$UUID"
DCONF_GDM_DIR="/etc/dconf/db/gdm.d"
DCONF_FILE="$DCONF_GDM_DIR/99-wack-lockscreen"

# Determine user home and local extension directories globally
REAL_HOME="${SUDO_USER_HOME:-${HOME}}"
if [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
fi
LOCAL_USER_DIR="$REAL_HOME/.local/share/gnome-shell/extensions/$UUID"

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
    if [ -f "$LOCAL_USER_DIR/metadata.json" ]; then
        SRC_DIR="$LOCAL_USER_DIR"
    elif [ -f "$TARGET_DIR/metadata.json" ]; then
        SRC_DIR="$TARGET_DIR"
    else
        echo "Error: Could not locate Sonoma Lockscreen installation directory."
        echo "Please install the extension first (e.g. from Extensions.gnome.org)."
        exit 1
    fi
fi

echo "=== WACK Lockscreen GDM DLC Installer ==="
echo "Source Directory: $SRC_DIR"
echo "Target Directory: $TARGET_DIR"
echo "User Directory:   $LOCAL_USER_DIR"

FORCE=false
if [ "${1:-}" = "--force" ]; then
    FORCE=true
fi

if [ "$FORCE" = false ] && [ -f "$TARGET_DIR/pro.js" ] && [ -f "$TARGET_DIR/crossSessionManager.js" ] && [ -f "$DCONF_FILE" ]; then
    echo ""
    echo "✨ GDM Expansion is already fully installed on this system!"
    echo "To force a re-installation or re-configuration, run with --force."
    exit 0
fi

# 1. Sync extension system-wide
echo "-> Deploying extension system-wide..."
mkdir -p "$TARGET_DIR"
if [ "$SRC_DIR" != "$TARGET_DIR" ]; then
    # Dynamically handle git repository metadata
    EXCLUDE_GIT=""
    if [ ! -d "$SRC_DIR/.git" ]; then
        EXCLUDE_GIT="--exclude=.git*"
    fi

    if command -v rsync &> /dev/null; then
        rsync -a --delete \
            $EXCLUDE_GIT \
            --exclude="*.zip" \
            --exclude="*.bak" \
            --exclude="checkthisthingblyat" \
            --exclude="pro.js" \
            --exclude="crossSessionManager.js" \
            "$SRC_DIR/" "$TARGET_DIR/"
    else
        echo "rsync not found, falling back to cp..."
        if [ -d "$SRC_DIR/.git" ]; then
            cp -rT "$SRC_DIR" "$TARGET_DIR"
        else
            mkdir -p "$TARGET_DIR"
            find "$SRC_DIR" -maxdepth 1 -not -name ".git" -not -name "." -not -name ".." -exec cp -r -t "$TARGET_DIR" {} +
        fi
    fi
else
    echo "   Source and Target are the same directory. Skipping extension files sync."
fi

# 2. Deploy DLC modules and restore unstripped hook files if needed
echo "-> Deploying DLC modules and restoring hook files..."
REPO_RAW_URL="https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main"
for file in "pro.js" "crossSessionManager.js" "extension.js" "prefs.js"; do
    USE_LOCAL=false
    if [ -f "$SRC_DIR/$file" ]; then
        if [ "$file" = "pro.js" ] || [ "$file" = "crossSessionManager.js" ]; then
            USE_LOCAL=true
        else
            if grep -q "GDM_EXCLUDE" "$SRC_DIR/$file"; then
                USE_LOCAL=true
            fi
        fi
    fi

    if [ "$USE_LOCAL" = true ]; then
        if [ "$SRC_DIR" != "$TARGET_DIR" ]; then
            echo "   Copying local $file..."
            cp "$SRC_DIR/$file" "$TARGET_DIR/"
        else
            echo "   Local $file already in target directory."
        fi
    else
        echo "   Downloading unstripped $file from repository..."
        curl -sSL "$REPO_RAW_URL/$file" -o "$TARGET_DIR/$file"
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

# 7. Remove user-level extension copy to prevent session conflicts
if [ -d "$LOCAL_USER_DIR" ]; then
    echo "-> Removing user-level extension copy to prevent conflicts..."
    if [ -d "$LOCAL_USER_DIR/.git" ]; then
        # Preserve git directory/files if this is a development clone
        find "$LOCAL_USER_DIR" -maxdepth 1 -not -name ".git" -not -name "." -not -name ".." -not -name ".gitignore" -exec rm -rf {} +
    else
        rm -rf "$LOCAL_USER_DIR"
    fi
fi

echo "========================================="
echo "GDM DLC installation complete!"
echo "To fully apply changes, you can restart GDM (WARNING: this terminates your current session)."
echo "Alternatively, lock your screen and click 'Switch User' to preview the new GDM look!"
echo ""
read -rp "Would you like to restart GDM now? (y/N): " choice
case "$choice" in
    [yY][eE][sS]|[yY])
        echo "Restarting GDM..."
        systemctl restart gdm || service gdm restart
        ;;
    *)
        echo "Please run 'sudo systemctl restart gdm' later when you are ready to fully apply the changes,"
        echo "or lock your screen and click 'Switch User' to see your new GDM lockscreen."
        ;;
esac
