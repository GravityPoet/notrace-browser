#!/bin/bash

# Shared macOS signing policy for the Picker and the patched Chromium runtime.
# A certificate-backed signature has a stable designated requirement across
# rebuilds; an ad-hoc signature is identified only by its changing CDHash.

CLOAK_DEFAULT_CODESIGN_IDENTITY="ChatGPT Cloak Local Code Signing"

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
