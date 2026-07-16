#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_fake() {
  local version="$1"
  local bin="$tmp/chromium-$version/Chromium.app/Contents/MacOS/Chromium"
  mkdir -p "$(dirname "$bin")"
  printf '#!/bin/sh\nprintf "Chromium %s\\n"\n' "$version" > "$bin"
  chmod +x "$bin"
}

make_fake "145.0.0.0"
make_fake "146.0.0.0"
mkdir -p "$tmp/chromium-147.0.0.0/Chromium.app/Contents/MacOS"
printf '#!/bin/sh\nprintf "Chromium 146.0.0.0\\n"\n' \
  > "$tmp/chromium-147.0.0.0/Chromium.app/Contents/MacOS/Chromium"
chmod +x "$tmp/chromium-147.0.0.0/Chromium.app/Contents/MacOS/Chromium"
ln -s "$tmp/chromium-146.0.0.0" "$tmp/current"

if CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 147.0.0.0; then
  printf 'mismatched directory/binary version was accepted\n' >&2
  exit 1
fi

DRY_RUN=1 CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 145.0.0.0
test "$(readlink "$tmp/current")" = "$tmp/chromium-146.0.0.0"

CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 145.0.0.0
test "$(readlink "$tmp/current")" = "$tmp/chromium-145.0.0.0"
test -s "$tmp/current.sha256"
test "$(awk '{print $1}' "$tmp/current.sha256")" = "$(shasum -a 256 "$tmp/chromium-145.0.0.0/Chromium.app/Contents/MacOS/Chromium" | awk '{print $1}')"

printf 'rollback script checks passed\n'
