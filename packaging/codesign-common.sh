#!/bin/bash

# Shared macOS signing policy for the Picker and the patched Chromium runtime.
# A certificate-backed signature has a stable designated requirement across
# rebuilds; an ad-hoc signature is identified only by its changing CDHash.

CLOAK_DEFAULT_CODESIGN_IDENTITY="ChatGPT Cloak Local Code Signing"

# Prove access to the existing private key once before a large bundle is
# modified.  `codesign --deep` may otherwise ask macOS for the same key once per
# nested helper, leaving the user with a stream of password dialogs.  The
# marker records only the identity name and is invalidated when a different
# identity is selected; it never stores a key or password.
cloak_codesign_access_marker() {
  local identity="$1"
  local root="${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}"
  local digest
  digest="$(printf '%s' "$identity" | /usr/bin/shasum -a 256 | awk '{print $1}')"
  printf '%s/.codesign-access-%s\n' "$root" "$digest"
}

cloak_ensure_codesign_access() {
  local identity="$1"
  [[ "$identity" != "-" ]] || return 0

  local marker
  marker="$(cloak_codesign_access_marker "$identity")"
  if [[ -f "$marker" && ! -L "$marker" ]] && grep -Fqx -- "$identity" "$marker"; then
    return 0
  fi

  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local fixture
  fixture="$(mktemp -d "${TMPDIR:-/tmp}/notrace-codesign-preflight.XXXXXX")"
  cleanup_codesign_fixture() {
    bash "$root/packaging/recycle-paths.sh" "$fixture" >/dev/null 2>&1 || true
  }
  trap cleanup_codesign_fixture RETURN

  mkdir -p "$fixture/Probe.app/Contents/MacOS"
  printf '%s\n' '#!/bin/sh' 'exit 0' > "$fixture/Probe.app/Contents/MacOS/probe"
  chmod 755 "$fixture/Probe.app/Contents/MacOS/probe"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string probe' \
    -c 'Add :CFBundleIdentifier string local.notrace.codesign.preflight' \
    -c 'Add :CFBundlePackageType string APPL' \
    "$fixture/Probe.app/Contents/Info.plist" >/dev/null 2>&1 || {
      /usr/bin/plutil -create xml1 "$fixture/Probe.app/Contents/Info.plist"
      /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string probe' \
        -c 'Add :CFBundleIdentifier string local.notrace.codesign.preflight' \
        -c 'Add :CFBundlePackageType string APPL' \
        "$fixture/Probe.app/Contents/Info.plist"
    }
  /usr/bin/codesign --force --timestamp=none --sign "$identity" "$fixture/Probe.app" >/dev/null
  /usr/bin/codesign --verify --deep --strict "$fixture/Probe.app"

  mkdir -p "$(dirname "$marker")"
  umask 077
  printf '%s\n' "$identity" > "$marker.tmp.$$"
  chmod 600 "$marker.tmp.$$"
  mv -f "$marker.tmp.$$" "$marker"
  trap - RETURN
  cleanup_codesign_fixture
}

cloak_codesign_identity_exists() {
  local identity="$1"
  /usr/bin/security find-identity -v -p codesigning 2>/dev/null | \
    /usr/bin/grep -Fq "\"$identity\""
}

resolve_cloak_codesign_identity() {
  local requested="${CLOAK_CODESIGN_IDENTITY:-}"

  if [[ "$requested" == "-" ]]; then
    printf '%s\n' "-"
    return 0
  fi

  if [[ -n "$requested" ]]; then
    if ! cloak_codesign_identity_exists "$requested"; then
      printf 'error: requested code-signing identity is unavailable: %s\n' "$requested" >&2
      return 1
    fi
    printf '%s\n' "$requested"
    return 0
  fi

  if cloak_codesign_identity_exists "$CLOAK_DEFAULT_CODESIGN_IDENTITY"; then
    printf '%s\n' "$CLOAK_DEFAULT_CODESIGN_IDENTITY"
  else
    printf '%s\n' "-"
  fi
}

cloak_signature_matches_identity() {
  local app="$1"
  local identity="$2"
  local details

  details="$(/usr/bin/codesign -dvvv "$app" 2>&1)" || return 1
  if [[ "$identity" == "-" ]]; then
    printf '%s\n' "$details" | /usr/bin/grep -Fqx 'Signature=adhoc'
  else
    printf '%s\n' "$details" | /usr/bin/grep -Fqx "Authority=$identity"
  fi
}
