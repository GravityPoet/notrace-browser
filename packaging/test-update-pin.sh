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
  *"official wrapper would resolve signed candidate version $version"*"current unchanged"*) ;;
  *) printf 'pin did not take the read-only official-wrapper path:\n%s\n' "$output" >&2; exit 1;;
esac

if CLOAKBROWSER_DIR="$tmp" CLOAK_BROWSER_PIN="not-a-version" DRY_RUN=1 \
  "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1; then
  printf 'invalid pin was accepted\n' >&2
  exit 1
fi

output="$(CLOAKBROWSER_DIR="$tmp" CLOAK_BROWSER_PIN="146.0.0.0" DRY_RUN=1 \
  "$ROOT/packaging/update-chromium.sh" 2>&1)"
case "$output" in
  *"would resolve signed candidate version 146.0.0.0"*) ;;
  *) printf 'installable pin was not delegated to the official wrapper:\n%s\n' "$output" >&2; exit 1;;
esac

blocked="$(CLOAKBROWSER_DIR="$tmp" CLOAK_BROWSER_PIN="150.0.7871.114.3" DRY_RUN=1 \
  "$ROOT/packaging/update-chromium.sh" 2>&1)"
case "$blocked" in
  *"is blocked on macOS"*"current unchanged"*) ;;
  *) printf 'dry-run did not block the known-bad candidate:\n%s\n' "$blocked" >&2; exit 1;;
esac

printf 'update pin checks passed\n'
