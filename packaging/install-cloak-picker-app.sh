#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/packaging/codesign-common.sh"
PICKER_DIR="$ROOT/cloak-picker"
APP_NAME="Cloak Picker"
BUILT_APP="$ROOT/target/release/bundle/macos/$APP_NAME.app"
INSTALL_APP="${CLOAK_PICKER_INSTALL_APP:-/Applications/$APP_NAME.app}"
INSTALL_PARENT="$(dirname "$INSTALL_APP")"
INSTALL_TMP="$INSTALL_PARENT/.$APP_NAME.app.tmp.$$"
EXPECTED_BUNDLE_ID="local.cloak.picker"
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
CODESIGN_IDENTITY="$(resolve_cloak_codesign_identity)"
AUTH_REFRESH_LABEL="com.notrace-browser.auth-refresh"
AUTH_REFRESH_PLIST="$HOME/Library/LaunchAgents/$AUTH_REFRESH_LABEL.plist"
AUTH_REFRESH_WAS_INSTALLED=0
if [[ "$INSTALL_APP" == "/Applications/$APP_NAME.app" && -f "$AUTH_REFRESH_PLIST" ]]; then
  AUTH_REFRESH_WAS_INSTALLED=1
fi
AUTH_REFRESH_LAUNCHER="$ROOT/packaging/授权续期后台任务.sh"

printf '%s\n' "backup: skipped; Cloak Picker.app is a generated Tauri bundle and is reinstallable from this script."

command -v npm >/dev/null 2>&1 || {
  printf '%s\n' "error: npm not found; install Node.js before building Cloak Picker" >&2
  exit 1
}
command -v cargo >/dev/null 2>&1 || {
  printf '%s\n' "error: cargo not found; install the Rust toolchain before building Cloak Picker" >&2
  exit 1
}

if [[ ! -d "$PICKER_DIR/node_modules" ]] || ! npm --prefix "$PICKER_DIR" ls --depth=0 >/dev/null 2>&1; then
  printf '%s\n' "frontend dependencies missing or stale; running npm ci"
  npm --prefix "$PICKER_DIR" ci
fi

cd "$ROOT"
npm --prefix "$PICKER_DIR" run tauri -- build --bundles app
cargo build --release -p cloak-cli >/dev/null

if [[ ! -d "$BUILT_APP" ]]; then
  printf 'error: built app not found: %s\n' "$BUILT_APP" >&2
  exit 1
fi

# Keep the background authority check inside the canonical app bundle so it
# does not depend on a source checkout or a mutable target directory.
cp "$ROOT/target/release/cloak" "$BUILT_APP/Contents/MacOS/cloak"
chmod 755 "$BUILT_APP/Contents/MacOS/cloak"
[[ -f "$AUTH_REFRESH_LAUNCHER" && ! -L "$AUTH_REFRESH_LAUNCHER" ]] || {
  printf 'error: auth refresh launcher source missing: %s\n' "$AUTH_REFRESH_LAUNCHER" >&2
  exit 1
}
cp "$AUTH_REFRESH_LAUNCHER" "$BUILT_APP/Contents/Resources/授权续期后台任务.sh"
chmod 755 "$BUILT_APP/Contents/Resources/授权续期后台任务.sh"
# Tauri may leave a CodeResources file from an earlier bundle shape. Remove
# only that generated signature metadata before signing the final file set.
# Do not strip arbitrary extended attributes from the installed app.
/bin/rm -rf "$BUILT_APP/Contents/_CodeSignature"

if [[ -e "$INSTALL_APP/Contents/Info.plist" ]]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INSTALL_APP/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_id" != "$EXPECTED_BUNDLE_ID" ]]; then
    printf 'error: refusing to replace %s; bundle id is %s, expected %s\n' \
      "$INSTALL_APP" "${existing_id:-unknown}" "$EXPECTED_BUNDLE_ID" >&2
    exit 1
  fi
fi

/usr/bin/osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
/bin/sleep 1

if /usr/bin/pgrep -f "$INSTALL_APP/Contents/MacOS/cloak-picker" >/dev/null 2>&1; then
  printf 'error: %s is still running; quit it and retry\n' "$INSTALL_APP" >&2
  exit 1
fi

/usr/bin/codesign --force --deep --timestamp=none --sign "$CODESIGN_IDENTITY" "$BUILT_APP"
/usr/bin/codesign --verify --deep --strict "$BUILT_APP"
if ! cloak_signature_matches_identity "$BUILT_APP" "$CODESIGN_IDENTITY"; then
  printf 'error: Picker signature does not match requested identity: %s\n' "$CODESIGN_IDENTITY" >&2
  exit 1
fi

/bin/rm -rf "$INSTALL_TMP"
/usr/bin/ditto "$BUILT_APP" "$INSTALL_TMP"
/usr/bin/codesign --verify --deep --strict "$INSTALL_TMP"

/bin/rm -rf "$INSTALL_APP"
/bin/mv "$INSTALL_TMP" "$INSTALL_APP"
/usr/bin/codesign --verify --deep --strict "$INSTALL_APP"
if ! cloak_signature_matches_identity "$INSTALL_APP" "$CODESIGN_IDENTITY"; then
  printf 'error: installed Picker signature does not match requested identity: %s\n' "$CODESIGN_IDENTITY" >&2
  exit 1
fi
/usr/bin/touch "$INSTALL_APP"
if [[ -x "$LSREG" ]]; then
  "$LSREG" -f "$INSTALL_APP" >/dev/null 2>&1 || true
  if [[ "$BUILT_APP" != "$INSTALL_APP" ]]; then
    "$LSREG" -u "$BUILT_APP" >/dev/null 2>&1 || true
  fi
  # Retained candidates and build products must not win the system's
  # org.chromium.Chromium lookup over NoTrace's selected official runtime.
  runtime_root="${CLOAK_BROWSER_ROOT:-${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}}"
  if [[ -L "$runtime_root/current" && -d "$runtime_root/current/Chromium.app" ]]; then
    current_app="$(cd "$runtime_root/current/Chromium.app" && pwd -P)"
    for other_app in "$runtime_root"/chromium-*/Chromium.app \
      "$ROOT/.build/native-engine/work/src/out/Default/Chromium.app"; do
      [[ -d "$other_app" ]] || continue
      if [[ "$(cd "$other_app" && pwd -P)" != "$current_app" ]]; then
        "$LSREG" -u "$other_app" >/dev/null 2>&1 || true
      fi
    done
    "$LSREG" -f "$current_app" >/dev/null 2>&1 || true
  fi
fi

# Record which cloak-core source this build embeds so check-picker-fresh.sh can later
# detect when a code edit has outdated the installed Picker.
"$ROOT/packaging/check-picker-fresh.sh" --stamp >/dev/null 2>&1 || true

# The generated bundle is only a staging artifact. Keeping it creates a second
# LaunchServices candidate with the same bundle identifier as the canonical app.
if [[ "$BUILT_APP" != "$INSTALL_APP" ]]; then
  /bin/rm -rf "$BUILT_APP"
fi

# Re-register an existing auth-refresh job after replacing the signed bundle.
# launchd caches a code requirement for the previous CDHash; without a
# bootstrap cycle it can reject the new, otherwise valid local signature with
# OS_REASON_CODESIGNING. Do not create the job here when the user has not
# enabled it previously.
if [[ "$AUTH_REFRESH_WAS_INSTALLED" == 1 ]]; then
  CLOAK_PICKER_INSTALL_APP="$INSTALL_APP" bash "$ROOT/packaging/install-auth-refresh.sh"
fi

printf 'signing : %s\n' "$CODESIGN_IDENTITY"
if [[ "$CODESIGN_IDENTITY" == "-" ]]; then
  printf '%s\n' "warning: no persistent code-signing identity found; macOS privacy grants can be requested again after a rebuild" >&2
fi
printf '%s\n' "$INSTALL_APP"
