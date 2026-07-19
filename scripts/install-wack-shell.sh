#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# Ensure script is NOT run as root
if [ "$EUID" -eq 0 ]; then
    echo "Error: This script installs the extension in user space and should NOT be run as root/sudo."
    exit 1
fi

# Ensure git is installed
if ! command -v git &> /dev/null; then
    echo "Error: 'git' command not found. Please install git and try again."
    exit 1
fi

UUID="wack-shell@rinzler69-wastaken.github.com"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
REPO_URL="https://github.com/rinzler69-wastaken/wack-shell.git"

# Function to perform update check
check_updates() {
    if [ ! -d "$EXT_DIR" ]; then
        echo "Error: WACK Shell is not installed at $EXT_DIR."
        exit 1
    fi
    if [ ! -d "$EXT_DIR/.git" ]; then
        echo "Error: WACK Shell is installed but was not set up via Git."
        echo "Please re-run the installation command to convert it to a Git repository."
        exit 1
    fi

    echo "-> Checking for updates..."
    cd "$EXT_DIR"
    
    # Temporarily disable git error checking for fetch
    git fetch -q origin main || { echo "Error: Failed to fetch remote repository updates."; exit 1; }

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    BASE=$(git merge-base HEAD origin/main)

    if [ "$LOCAL" = "$REMOTE" ]; then
        echo "=========================================="
        echo "  WACK Shell is up to date!               "
        echo "  Current commit: ${LOCAL:0:7}            "
        echo "=========================================="
    elif [ "$LOCAL" = "$BASE" ]; then
        echo "=========================================="
        echo "  Update available for WACK Shell!        "
        echo "  Current version: ${LOCAL:0:7}           "
        echo "  Latest version:  ${REMOTE:0:7}          "
        echo "=========================================="
        echo "To update, copy and run this command:      "
        echo "  curl -sSL https://raw.githubusercontent.com/rinzler69-wastaken/wack-sonoma-lockscreen/main/scripts/install-wack-shell.sh | bash"
        echo "=========================================="
    elif [ "$REMOTE" = "$BASE" ]; then
        echo "Local installation has unpushed commits."
    else
        echo "Local repository and remote main have diverged."
    fi
}

# Check if checking mode is requested
if [ "$1" = "--check" ]; then
    check_updates
    exit 0
fi

echo "=========================================="
echo "    Installing WACK Shell Integration     "
echo "=========================================="

# 1. Deploy/Clone repository
if [ -d "$EXT_DIR" ]; then
    if [ -d "$EXT_DIR/.git" ]; then
        echo "-> Existing Git repository detected. Pulling latest main..."
        cd "$EXT_DIR"
        git fetch origin main
        git reset --hard origin/main
    else
        echo "-> Existing directory found (non-Git). Reinstalling cleanly..."
        rm -rf "$EXT_DIR"
        git clone "$REPO_URL" "$EXT_DIR"
    fi
else
    echo "-> Cloning WACK Shell repository into extensions folder..."
    git clone "$REPO_URL" "$EXT_DIR"
fi

# 2. Compile schemas
if [ -d "$EXT_DIR/schemas" ]; then
    echo "-> Compiling settings schemas..."
    glib-compile-schemas "$EXT_DIR/schemas/"
fi

# 3. Enable the extension
echo "-> Enabling extension..."
if command -v gnome-extensions &> /dev/null; then
    # Enable extension (ignores if already enabled)
    gnome-extensions enable "$UUID" || true
    echo "Success: WACK Shell has been installed/updated and enabled!"
else
    echo "Warning: gnome-extensions tool not found. Please enable it manually."
fi

echo "------------------------------------------"
echo "Installation complete! Please reload GNOME Shell:"
echo "  - On X11: Press Alt+F2, type 'r', and press Enter."
echo "  - On Wayland: Log out and log back in."
echo "=========================================="
