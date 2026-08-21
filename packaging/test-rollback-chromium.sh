#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_fake() {
  local directory_version="$1"
  local binary_version="${2:-$1}"
  local app="$tmp/chromium-$directory_version/Chromium.app"
  local bin="$app/Contents/MacOS/Chromium"
  local plist="$app/Contents/Info.plist"
  mkdir -p "$(dirname "$bin")"
  printf '#!/bin/sh\nprintf "Chromium %s\\n"\n' "$binary_version" > "$bin"
  chmod +x "$bin"
  /usr/bin/plutil -create xml1 "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string Chromium' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string org.chromium.Chromium' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$plist"
  if [[ "$directory_version" == *-notrace ]]; then
    printf '%s\n' 'NoTrace local runtime v1' \
      >"$tmp/chromium-$directory_version/.notrace-local-runtime"
    /usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string microphone' "$plist"
    /usr/libexec/PlistBuddy -c 'Add :NSCameraUsageDescription string camera' "$plist"
    /usr/libexec/PlistBuddy -c 'Add :NSBluetoothAlwaysUsageDescription string bluetooth' "$plist"
  fi
  /usr/bin/codesign --force --deep --sign - "$app" >/dev/null
}

make_fake "145.0.0.0"
make_fake "146.0.0.0"
make_fake "150.0.7871.114.4-pro" "150.0.7871.114"
make_fake "151.0.0.0-pro-notrace" "151.0.0.0"
make_fake "147.0.0.0" "146.0.0.0"
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

rm -f "$tmp/current.sha256"
DRY_RUN=1 CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 145.0.0.0
test ! -e "$tmp/current.sha256"
CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 145.0.0.0
test "$(awk '{print $1}' "$tmp/current.sha256")" = "$(shasum -a 256 "$tmp/chromium-145.0.0.0/Chromium.app/Contents/MacOS/Chromium" | awk '{print $1}')"
printf '%064d\n' 0 > "$tmp/current.sha256"
CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 145.0.0.0
test "$(awk '{print $1}' "$tmp/current.sha256")" = "$(shasum -a 256 "$tmp/chromium-145.0.0.0/Chromium.app/Contents/MacOS/Chromium" | awk '{print $1}')"

CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 150.0.7871.114.4-pro
test "$(readlink "$tmp/current")" = "$tmp/chromium-150.0.7871.114.4-pro"
test "$(awk '{print $1}' "$tmp/current.sha256")" = "$(shasum -a 256 "$tmp/chromium-150.0.7871.114.4-pro/Chromium.app/Contents/MacOS/Chromium" | awk '{print $1}')"

CLOAKBROWSER_DIR="$tmp" "$ROOT/packaging/rollback-chromium.sh" 151.0.0.0-pro-notrace
test "$(readlink "$tmp/current")" = "$tmp/chromium-151.0.0.0-pro-notrace"
test "$(awk '{print $1}' "$tmp/current.sha256")" = "$(shasum -a 256 "$tmp/chromium-151.0.0.0-pro-notrace/Chromium.app/Contents/MacOS/Chromium" | awk '{print $1}')"

printf 'rollback script checks passed\n'
