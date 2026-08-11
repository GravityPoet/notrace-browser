#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/packaging/codesign-common.sh"
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
CLOAK_CODESIGN_IDENTITY=- CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
after_unchanged="$(cdhash "$APP")"
[[ "$before" == "$after_unchanged" ]] || {
  printf '%s\n' "error: unchanged Chromium signature identity was replaced" >&2
  exit 1
}

"$PLISTBUDDY" -c 'Delete :NSBluetoothAlwaysUsageDescription' "$PLIST"
CLOAK_CODESIGN_IDENTITY=- CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
/usr/bin/codesign --verify --deep --strict "$APP"
bluetooth_description="$("$PLISTBUDDY" -c 'Print :NSBluetoothAlwaysUsageDescription' "$PLIST")"
[[ "$bluetooth_description" == "Passkey sign-in uses Bluetooth to connect your phone or security key." ]] || {
  printf '%s\n' "error: Bluetooth usage description was not restored" >&2
  exit 1
}

after_repair="$(cdhash "$APP")"
CLOAK_CODESIGN_IDENTITY=- CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
after_repeat="$(cdhash "$APP")"
[[ "$after_repair" == "$after_repeat" ]] || {
  printf '%s\n' "error: repeated Chromium patch changed signature identity" >&2
  exit 1
}

OFFICIAL_ROOT="$TMP_ROOT/official-cache"
OFFICIAL_APP="$OFFICIAL_ROOT/chromium-145.0.7632.109.2/Chromium.app"
mkdir -p "$(dirname "$OFFICIAL_APP")"
cp -R "$APP" "$OFFICIAL_APP"
if CLOAKBROWSER_DIR="$OFFICIAL_ROOT" CLOAK_CODESIGN_IDENTITY=- \
  CLOAK_BROWSER_APP="$OFFICIAL_APP" "$PATCH_SCRIPT" >/dev/null 2>&1; then
  printf '%s\n' "error: official CloakBrowser distribution was modified" >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$OFFICIAL_APP"

LOCAL_RUNTIME_DIR="$OFFICIAL_ROOT/chromium-145.0.7632.109.2-notrace"
LOCAL_RUNTIME_APP="$LOCAL_RUNTIME_DIR/Chromium.app"
mkdir -p "$LOCAL_RUNTIME_DIR"
cp -R "$APP" "$LOCAL_RUNTIME_APP"
printf '%s\n' 'NoTrace local runtime v1' >"$LOCAL_RUNTIME_DIR/.notrace-local-runtime"
"$PLISTBUDDY" -c 'Delete :NSMicrophoneUsageDescription' \
  "$LOCAL_RUNTIME_APP/Contents/Info.plist"
CLOAKBROWSER_DIR="$OFFICIAL_ROOT" CLOAK_CODESIGN_IDENTITY=- \
  CLOAK_BROWSER_APP="$LOCAL_RUNTIME_APP" "$PATCH_SCRIPT" >/dev/null
[[ "$("$PLISTBUDDY" -c 'Print :NSMicrophoneUsageDescription' \
  "$LOCAL_RUNTIME_APP/Contents/Info.plist")" == "ChatGPT voice input uses the microphone." ]] || {
  printf '%s\n' "error: marked local runtime was not patched" >&2
  exit 1
}
/usr/bin/codesign --verify --deep --strict "$LOCAL_RUNTIME_APP"

if cloak_codesign_identity_exists "$CLOAK_DEFAULT_CODESIGN_IDENTITY"; then
  CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
  cloak_signature_matches_identity "$APP" "$CLOAK_DEFAULT_CODESIGN_IDENTITY" || {
    printf '%s\n' "error: Chromium was not migrated to the persistent signing identity" >&2
    exit 1
  }
  stable_requirement="$(/usr/bin/codesign -d -r- "$APP" 2>&1 | tail -1)"

  "$PLISTBUDDY" -c 'Delete :NSCameraUsageDescription' "$PLIST"
  CLOAK_BROWSER_APP="$APP" "$PATCH_SCRIPT" >/dev/null
  repaired_requirement="$(/usr/bin/codesign -d -r- "$APP" 2>&1 | tail -1)"
  [[ "$stable_requirement" == "$repaired_requirement" ]] || {
    printf '%s\n' "error: persistent designated requirement changed after repair" >&2
    exit 1
  }
fi

printf '%s\n' "PASS: Chromium TCC patch is idempotent"
