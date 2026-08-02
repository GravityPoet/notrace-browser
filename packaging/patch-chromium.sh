#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/packaging/codesign-common.sh"

# Patch the CloakBrowser Chromium so ChatGPT voice/camera/passkey do not crash macOS TCC.
#
# CloakBrowser ships an ad-hoc Chromium whose Info.plist has no NSMicrophoneUsageDescription.
# On macOS, the instant a process touches the microphone (ChatGPT getUserMedia) without that
# usage-description key, TCC terminates the process:
#   namespace=TCC ... "must contain an NSMicrophoneUsageDescription key"
# That termination is the "Chromium 意外退出" crash when granting the mic permission.
#
# The SAME rule applies to Bluetooth: phone-QR passkey sign-in (WebAuthn caBLE/hybrid transport)
# touches CoreBluetooth to set up the BLE proximity tunnel to the phone. Without
# NSBluetoothAlwaysUsageDescription, TCC kills the process, so the "use your phone" passkey
# option fails and the site falls back to demanding a physical security key. The caBLE code is
# present in the binary (webauthn.cablev2_pairings); only the usage-description key is missing.
#
# Fix: inject NSMicrophoneUsageDescription + NSCameraUsageDescription + NSBluetoothAlwaysUsageDescription
# into the main app and its helper bundles, then sign with the persistent local identity when
# available. Its designated requirement stays stable even when an upgrade changes the CDHash.
# Machines without that identity retain the ad-hoc fallback, and unchanged valid signatures are
# still left alone. CloakBrowser upgrades replace Chromium and drop the keys again, so re-run
# after every CloakBrowser upgrade.
#
# Note: Chromium is intentionally NOT rebranded. The green ChatGPT identity belongs to the
# NoTrace Browser launcher; the Chromium it drives stays a plain browser so the two are distinct.

PLISTBUDDY=/usr/libexec/PlistBuddy
MIC_DESC="ChatGPT voice input uses the microphone."
CAM_DESC="ChatGPT video and vision features use the camera."
BT_DESC="Passkey sign-in uses Bluetooth to connect your phone or security key."

CLOAK_DIR="${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}"
CODESIGN_IDENTITY="$(resolve_cloak_codesign_identity)"

shopt -s nullglob
if [[ -n "${CLOAK_BROWSER_APP:-}" ]]; then
  APPS=("$CLOAK_BROWSER_APP")
elif [[ -n "${CLOAK_BROWSER_VERSION_DIR:-}" ]]; then
  APPS=("$CLOAK_BROWSER_VERSION_DIR/Chromium.app")
else
  APPS=("$CLOAK_DIR"/chromium-*/Chromium.app)
fi
if [[ ${#APPS[@]} -eq 0 ]]; then
  printf 'error: no CloakBrowser Chromium found under %s\n' "$CLOAK_DIR" >&2
  exit 1
fi
for APP in "${APPS[@]}"; do
  if [[ ! -d "$APP" ]]; then
    printf 'error: Chromium.app not found: %s\n' "$APP" >&2
    exit 1
  fi
done

set_key() {
  local plist="$1" key="$2" val="$3"
  local current
  if current="$("$PLISTBUDDY" -c "Print :$key" "$plist" 2>/dev/null)"; then
    if [[ "$current" == "$val" ]]; then
      return
    fi
    "$PLISTBUDDY" -c "Set :$key $val" "$plist"
  else
    "$PLISTBUDDY" -c "Add :$key string $val" "$plist"
  fi
  plist_changed=1
}

for APP in "${APPS[@]}"; do
  plist_changed=0
  signature_needs_upgrade=0
  PLISTS=("$APP/Contents/Info.plist")
  HELPERS_DIR="$APP/Contents/Frameworks/Chromium Framework.framework/Versions/Current/Helpers"
  for HELPER in "$HELPERS_DIR"/*.app; do
    PLISTS+=("$HELPER/Contents/Info.plist")
  done

  for PLIST in "${PLISTS[@]}"; do
    [[ -f "$PLIST" ]] || continue
    set_key "$PLIST" NSMicrophoneUsageDescription "$MIC_DESC"
    set_key "$PLIST" NSCameraUsageDescription "$CAM_DESC"
    set_key "$PLIST" NSBluetoothAlwaysUsageDescription "$BT_DESC"
  done

  if [[ "$CODESIGN_IDENTITY" != "-" ]] && ! cloak_signature_matches_identity "$APP" "$CODESIGN_IDENTITY"; then
    signature_needs_upgrade=1
  fi

  if [[ "$plist_changed" == "1" ]] || [[ "$signature_needs_upgrade" == "1" ]] || \
     ! /usr/bin/codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    # Re-sign bottom-up so modified Info.plist hashes and nested seals match again.
    # Prefer the persistent local identity when present so TCC grants survive
    # Chromium upgrades; CI and machines without it retain the ad-hoc fallback.
    /usr/bin/codesign --force --deep --timestamp=none --sign "$CODESIGN_IDENTITY" "$APP"
    /usr/bin/codesign --verify --deep --strict "$APP"
    if ! cloak_signature_matches_identity "$APP" "$CODESIGN_IDENTITY"; then
      printf 'error: Chromium signature does not match requested identity: %s\n' "$CODESIGN_IDENTITY" >&2
      exit 1
    fi
    printf 'patched + resigned (%s): %s\n' "$CODESIGN_IDENTITY" "$APP"
  else
    printf 'already patched; signature preserved: %s\n' "$APP"
  fi
done

printf '\ndone. Quit any running Cloak Chromium and relaunch NoTrace Browser for the change to take effect.\n'
