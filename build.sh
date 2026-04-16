#!/bin/bash
# Build script for Langsly Vocab Pass extension
# Creates browser-specific builds in dist/chrome and dist/firefox

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$SCRIPT_DIR/dist"

# Clean previous builds
rm -rf "$DIST"
mkdir -p "$DIST/chrome" "$DIST/firefox"

# Shared files to copy
SHARED_FILES=(
  "vendor/browser-polyfill.min.js"
  "background/service-worker.js"
  "content/grammar-rules.js"
  "content/matcher.js"
  "content/popup.js"
  "content/content.js"
  "content/content.css"
  "popup/popup.html"
  "popup/popup.js"
  "popup/popup.css"
  "popup/options.html"
  "popup/options.js"
  "popup/options.css"
  "popup/onboarding.html"
  "popup/onboarding.js"
  "popup/onboarding.css"
  "icons/icon16.png"
  "icons/icon48.png"
  "icons/icon128.png"
)

copy_shared() {
  local target="$1"
  for file in "${SHARED_FILES[@]}"; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$SCRIPT_DIR/$file" "$target/$file"
  done
}

# ─── Chrome Build ─────────────────────────────
copy_shared "$DIST/chrome"
cp "$SCRIPT_DIR/manifest.json" "$DIST/chrome/manifest.json"
echo "✓ Chrome build: $DIST/chrome"

# ─── Firefox Build ────────────────────────────
copy_shared "$DIST/firefox"

# Generate Firefox manifest (background.scripts instead of service_worker)
node -e "
const m = require('$SCRIPT_DIR/manifest.json');
delete m.background.service_worker;
m.background = {
  scripts: ['vendor/browser-polyfill.min.js', 'background/service-worker.js']
};
m.browser_specific_settings = {
  gecko: {
    id: 'vocabpass@languageplanet.app',
    strict_min_version: '109.0'
  }
};
console.log(JSON.stringify(m, null, 2));
" > "$DIST/firefox/manifest.json"
echo "✓ Firefox build: $DIST/firefox"

echo ""
echo "Load instructions:"
echo "  Chrome:  chrome://extensions → Load unpacked → $DIST/chrome"
echo "  Firefox: about:debugging → Load Temporary Add-on → $DIST/firefox/manifest.json"
