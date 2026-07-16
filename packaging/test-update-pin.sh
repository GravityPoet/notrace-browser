#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

version="145.0.7632.109.2"
bin="$tmp/chromium-$version/Chromium.app/Contents/MacOS/Chromium"
mkdir -p "$(dirname "$bin")"
printf '#!/bin/sh\nprintf "Chromium 145.0.7632.109\\n"\n' > "$bin"
chmod +x "$bin"
ln -s "$tmp/chromium-$version" "$tmp/current"

before="$(readlink "$tmp/current")"
output="$(
  CLOAKBROWSER_DIR="$tmp" \
  CLOAK_BROWSER_PIN="$version" \
  DRY_RUN=1 \
    "$ROOT/packaging/update-chromium.sh" 2>&1
)"
after="$(readlink "$tmp/current")"
test "$before" = "$after"
case "$output" in
  *"network lookup skipped"*"up to date; no-op"*) ;;
  *) printf 'pin did not take the offline no-op path:\n%s\n' "$output" >&2; exit 1;;
esac

if CLOAKBROWSER_DIR="$tmp" CLOAK_BROWSER_PIN="not-a-version" DRY_RUN=1 \
  "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1; then
  printf 'invalid pin was accepted\n' >&2
  exit 1
fi

if CLOAKBROWSER_DIR="$tmp" CLOAK_BROWSER_PIN="146.0.0.0" DRY_RUN=1 \
  "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1; then
  printf 'uninstalled pin was accepted\n' >&2
  exit 1
fi

printf 'update pin checks passed\n'
