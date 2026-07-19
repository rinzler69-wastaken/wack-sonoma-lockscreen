#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# Ensure script is NOT run as root
if [ "$EUID" -eq 0 ]; then
    echo "Error: This script installs the extension in user space and should NOT be run as root/sudo."
    exit 1
fi

UUID="wack-shell@rinzler69-wastaken.github.com"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
REPO_ZIP_URL="https://github.com/rinzler69-wastaken/wack-shell/archive/refs/heads/main.zip"
TMP_DIR=$(mktemp -d /tmp/wackinstall.XXXXXX)

# Clean up temporary directory on exit
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=========================================="
echo "    Installing WACK Shell Integration     "
echo "=========================================="

# 1. Download repository ZIP
echo "-> Downloading latest release from GitHub..."
curl -sSL "$REPO_ZIP_URL" -o "$TMP_DIR/repo.zip"

# 2. Extract ZIP
echo "-> Extracting files..."
unzip -q "$TMP_DIR/repo.zip" -d "$TMP_DIR"
SRC_DIR=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d -name "wack-shell-*" | head -n 1)

if [ -z "$SRC_DIR" ]; then
    echo "Error: Failed to locate extracted source directory."
    exit 1
fi

# 3. Create extension target folder
echo "-> Deploying extension files..."
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

# 4. Copy files (excluding git/development files if any)
rsync -a --exclude=".git*" --exclude="Makefile" "$SRC_DIR/" "$EXT_DIR/" || cp -rT "$SRC_DIR" "$EXT_DIR"

# 5. Compile schemas
if [ -d "$EXT_DIR/schemas" ]; then
    echo "-> Compiling settings schemas..."
    glib-compile-schemas "$EXT_DIR/schemas/"
fi

# 6. Enable the extension
echo "-> Enabling extension..."
if command -v gnome-extensions &> /dev/null; then
    # Enable extension (ignores if already enabled)
    gnome-extensions enable "$UUID" || true
    echo "Success: WACK Shell has been installed and enabled!"
else
    echo "Warning: gnome-extensions tool not found. Please enable it manually."
fi

echo "------------------------------------------"
echo "Installation complete! Please reload GNOME Shell:"
echo "  - On X11: Press Alt+F2, type 'r', and press Enter."
echo "  - On Wayland: Log out and log back in."
echo "=========================================="
