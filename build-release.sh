#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Steam Deck users commonly install Node through nvm. Non-interactive shells
# do not always source nvm automatically, so load it here before looking for pnpm.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

# Resolve pnpm without requiring the user to run an install command every time.
PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"

if [ -z "$PNPM_BIN" ] && command -v corepack >/dev/null 2>&1; then
  echo "==> pnpm not on PATH; activating pnpm 9 with corepack"
  corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1 || true
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
fi

if [ -z "$PNPM_BIN" ] && command -v npm >/dev/null 2>&1; then
  echo "==> pnpm not found; installing pnpm 9 once in the current Node environment"
  npm install -g pnpm@9
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"

  if [ -z "$PNPM_BIN" ]; then
    NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/pnpm" ]; then
      PNPM_BIN="$NPM_PREFIX/bin/pnpm"
    fi
  fi
fi

if [ -z "$PNPM_BIN" ] || [ ! -x "$PNPM_BIN" ]; then
  echo "ERROR: pnpm could not be found or activated."
  echo "Node: $(command -v node 2>/dev/null || echo 'not found')"
  echo "npm:  $(command -v npm 2>/dev/null || echo 'not found')"
  exit 1
fi

echo "==> Using pnpm: $PNPM_BIN"

if [ ! -d node_modules ]; then
  echo "==> Installing project dependencies (first build only)"
  "$PNPM_BIN" install
else
  echo "==> Dependencies already present - skipping pnpm install"
fi

echo "==> Building frontend"
"$PNPM_BIN" run build

test -f dist/index.js

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
fi

OUT="$ROOT/out"
PLUGIN_DIR="$OUT/LibraryDoctor"
ZIP_FILE="$OUT/LibraryDoctor-v${VERSION}.zip"

rm -rf "$OUT"
mkdir -p "$PLUGIN_DIR/dist"
cp dist/index.js "$PLUGIN_DIR/dist/index.js"
cp package.json plugin.json main.py README.md LICENSE "$PLUGIN_DIR/"

cd "$OUT"
zip -qr "$(basename "$ZIP_FILE")" LibraryDoctor
cd "$ROOT"

echo
echo "Done: Library Doctor v${VERSION} built and packaged."
echo "ZIP: $ZIP_FILE"
echo "Decky was NOT modified or restarted."
