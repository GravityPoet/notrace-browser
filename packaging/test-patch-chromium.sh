#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_SCRIPT="$ROOT/packaging/patch-chromium.sh"
PLISTBUDDY=/usr/libexec/PlistBuddy
TMP_ROOT="$(/usr/bin/mktemp -d /tmp/notrace-patch-test.XXXXXX)"
APP="$TMP_ROOT/Chromium.app"
PLIST="$APP/Contents/Info.plist"
EXECUTABLE="$APP/Contents/MacOS/Chromium"

cleanup() {
  /bin/rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$(dirname "$EXECUTABLE")"
printf '#!/bin/bash\nexit 0\n' >"$EXECUTABLE"
chmod +x "$EXECUTABLE"

/usr/bin/plutil -create xml1 "$PLIST"
"$PLISTBUDDY" -c 'Add :CFBundleExecutable string Chromium' "$PLIST"
"$PLISTBUDDY" -c 'Add :CFBundleIdentifier string org.chromium.Chromium' "$PLIST"
"$PLISTBUDDY" -c 'Add :CFBundlePackageType string APPL' "$PLIST"
"$PLISTBUDDY" -c 'Add :NSMicrophoneUsageDescription string ChatGPT voice input uses the microphone.' "$PLIST"
"$PLISTBUDDY" -c 'Add :NSCameraUsageDescription string ChatGPT video and vision features use the camera.' "$PLIST"
"$PLISTBUDDY" -c 'Add :NSBluetoothAlwaysUsageDescription string Passkey sign-in uses Bluetooth to connect your phone or security key.' "$PLIST"

/usr/bin/codesign --force --deep --sign - "$APP"

cdhash() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 | awk -F= '/^CDHash=/{print $2}'
}

before="$(cdhash "$APP")"
CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
after_unchanged="$(cdhash "$APP")"
[[ "$before" == "$after_unchanged" ]] || {
  printf '%s\n' "error: unchanged Chromium signature identity was replaced" >&2
  exit 1
}

"$PLISTBUDDY" -c 'Delete :NSBluetoothAlwaysUsageDescription' "$PLIST"
CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
/usr/bin/codesign --verify --deep --strict "$APP"
bluetooth_description="$("$PLISTBUDDY" -c 'Print :NSBluetoothAlwaysUsageDescription' "$PLIST")"
[[ "$bluetooth_description" == "Passkey sign-in uses Bluetooth to connect your phone or security key." ]] || {
  printf '%s\n' "error: Bluetooth usage description was not restored" >&2
  exit 1
}

after_repair="$(cdhash "$APP")"
CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
after_repeat="$(cdhash "$APP")"
[[ "$after_repair" == "$after_repeat" ]] || {
  printf '%s\n' "error: repeated Chromium patch changed signature identity" >&2
  exit 1
}

printf '%s\n' "PASS: Chromium TCC patch is idempotent"
