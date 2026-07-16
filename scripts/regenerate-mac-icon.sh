#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ICON_DIR="$PROJECT_ROOT/build/icons"
PNG_DIR="$ICON_DIR/png"
MAC_DIR="$ICON_DIR/mac"
ICONSET_DIR="$MAC_DIR/icon.iconset"

echo "[LfClaw] Regenerating macOS icon..."

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required. Please run this script on macOS."
  exit 1
fi

if [ ! -f "$PNG_DIR/1024x1024.png" ]; then
  echo "PNG icons are missing. Generating icons from public/logo.png first..."
  node "$PROJECT_ROOT/scripts/generate-app-icon.js"
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

copy_icon() {
  local source_size="$1"
  local target_name="$2"
  local source_file="$PNG_DIR/${source_size}x${source_size}.png"
  if [ ! -f "$source_file" ]; then
    echo "Missing source PNG: $source_file"
    exit 1
  fi
  cp "$source_file" "$ICONSET_DIR/$target_name"
}

copy_icon 16 "icon_16x16.png"
copy_icon 32 "icon_16x16@2x.png"
copy_icon 32 "icon_32x32.png"
copy_icon 64 "icon_32x32@2x.png"
copy_icon 128 "icon_128x128.png"
copy_icon 256 "icon_128x128@2x.png"
copy_icon 256 "icon_256x256.png"
copy_icon 512 "icon_256x256@2x.png"
copy_icon 512 "icon_512x512.png"
copy_icon 1024 "icon_512x512@2x.png"

mkdir -p "$MAC_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$MAC_DIR/icon.icns"
rm -rf "$ICONSET_DIR"

echo "[LfClaw] macOS icon generated: $MAC_DIR/icon.icns"
