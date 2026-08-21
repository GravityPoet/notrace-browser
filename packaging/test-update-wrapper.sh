#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

version="145.0.7632.109.2"
pristine_dir="$tmp/cache/chromium-$version"
app="$pristine_dir/Chromium.app"
bin="$app/Contents/MacOS/Chromium"
plist="$app/Contents/Info.plist"
mkdir -p "$(dirname "$bin")"
printf '#!/bin/sh\nprintf "Chromium 145.0.7632.109\\n"\n' > "$bin"
chmod +x "$bin"
/usr/bin/plutil -create xml1 "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string Chromium' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string org.chromium.Chromium' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$plist"
/usr/bin/codesign --force --deep --sign - "$app" >/dev/null

runtime_dir="$tmp/cache/chromium-$version-notrace"
runtime_app="$runtime_dir/Chromium.app"
mkdir -p "$runtime_dir"
/usr/bin/ditto "$app" "$runtime_app"
printf '%s\n' 'NoTrace local runtime v1' >"$runtime_dir/.notrace-local-runtime"
pristine_sha="$(shasum -a 256 "$bin" | awk '{print $1}')"
source_cdhash="$(/usr/bin/codesign -d --verbose=4 "$app" 2>&1 \
  | awk -F= '/^CDHash=/{value=$2} END{print value}')"
printf '%s  %s\n' "$source_cdhash" "$app" >"$runtime_dir/.notrace-source.cdhash"
CLOAKBROWSER_DIR="$tmp/cache" CLOAK_CODESIGN_IDENTITY=- \
  CLOAK_BROWSER_APP="$runtime_app" "$ROOT/packaging/patch-chromium.sh" >/dev/null
runtime_bin="$runtime_app/Contents/MacOS/Chromium"
runtime_sha="$(shasum -a 256 "$runtime_bin" | awk '{print $1}')"
gate_dir="$tmp/cache/update-gates/chromium-$version-notrace"
mkdir -p "$gate_dir"
printf '%s  %s\n' "$runtime_sha" "$runtime_bin" >"$gate_dir/local-contract.sha256"
ln -s "$runtime_dir" "$tmp/cache/current"

wrapper="$tmp/fake-cloakbrowser"
cat > "$wrapper" <<'WRAPPER'
#!/bin/bash
set -euo pipefail
[[ -z "${GITHUB_PAT_TOKEN:-}" ]] || exit 90
[[ -z "${GITHUB_TOKEN:-}" ]] || exit 91
[[ -z "${NPM_TOKEN:-}" ]] || exit 92
[[ -z "${CLOAKBROWSER_BINARY_PATH:-}" ]] || exit 93
[[ -z "${CLOAKBROWSER_DOWNLOAD_URL:-}" ]] || exit 94
[[ -z "${CLOAKBROWSER_SKIP_CHECKSUM:-}" ]] || exit 95
[[ "${CLOAKBROWSER_CACHE_DIR:-}" == "$FAKE_EXPECTED_CACHE" ]] || exit 96
printf '%s\n' "${1:-}" >> "$FAKE_WRAPPER_CALLS"
case "${1:-}" in
  info)
    printf '{"binary":{"version":"%s","latest_version":%s}}\n' \
      "$FAKE_CURRENT_VERSION" "${FAKE_LATEST_JSON:-null}"
    ;;
  install)
    printf '%s\n' "$FAKE_CURRENT_BIN"
    ;;
  *) exit 2 ;;
esac
WRAPPER
chmod +x "$wrapper"

calls="$tmp/calls"
expected_cache="$(cd "$tmp/cache" && pwd -P)"
before="$(readlink "$tmp/cache/current")"
FAKE_WRAPPER_CALLS="$calls" \
FAKE_EXPECTED_CACHE="$expected_cache" \
FAKE_CURRENT_VERSION="$version" \
FAKE_CURRENT_BIN="$bin" \
GITHUB_PAT_TOKEN="should-not-reach-wrapper" \
GITHUB_TOKEN="should-not-reach-wrapper" \
NPM_TOKEN="should-not-reach-wrapper" \
CLOAKBROWSER_BINARY_PATH="/tmp/should-not-be-used" \
CLOAKBROWSER_DOWNLOAD_URL="https://invalid.example.test" \
CLOAKBROWSER_SKIP_CHECKSUM="true" \
CLOAKBROWSER_DIR="$tmp/cache" \
CLOAK_WRAPPER_BIN="$wrapper" \
CLOAK_PICKER_AUTO_REBUILD="" \
CLOAK_CODESIGN_IDENTITY=- \
NOTRACE_UPDATE_LAUNCHD=1 \
  "$ROOT/packaging/update-chromium.sh" >>"$tmp/cache/update.log" 2>&1 || {
    printf '%s\n' 'error: wrapper environment-isolation check failed; updater log follows' >&2
    sed -n '1,220p' "$tmp/cache/update.log" >&2
    exit 1
  }
after="$(readlink "$tmp/cache/current")"
test "$before" = "$after"
test "$(sed -n '1p' "$calls")" = "info"
test "$(sed -n '2p' "$calls")" = "install"
resolve_count="$(grep -c 'resolving candidate through official wrapper' "$tmp/cache/update.log")"
if [[ "$resolve_count" != "1" ]]; then
  printf 'error: launchd logging wrote the resolution line %s times\n' "$resolve_count" >&2
  sed -n '1,220p' "$tmp/cache/update.log" >&2
  exit 1
fi

: > "$calls"
FAKE_WRAPPER_CALLS="$calls" \
FAKE_EXPECTED_CACHE="$expected_cache" \
FAKE_CURRENT_VERSION="$version" \
FAKE_LATEST_JSON='"150.0.7871.114.3"' \
FAKE_CURRENT_BIN="$bin" \
CLOAKBROWSER_DIR="$tmp/cache" \
CLOAK_WRAPPER_BIN="$wrapper" \
CLOAK_PICKER_AUTO_REBUILD="" \
CLOAK_CODESIGN_IDENTITY=- \
  "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1
test "$(readlink "$tmp/cache/current")" = "$before"
test "$(sed -n '1p' "$calls")" = "info"
test "$(wc -l < "$calls" | tr -d ' ')" = "1"

# An unknown candidate reported by `info` must be rejected before the wrapper
# receives an install command or creates any staging copy.
: > "$calls"
if FAKE_WRAPPER_CALLS="$calls" \
  FAKE_EXPECTED_CACHE="$expected_cache" \
  FAKE_CURRENT_VERSION="$version" \
  FAKE_LATEST_JSON='"151.0.0.0"' \
  FAKE_CURRENT_BIN="$bin" \
  CLOAKBROWSER_DIR="$tmp/cache" \
  CLOAK_WRAPPER_BIN="$wrapper" \
  CLOAK_PICKER_AUTO_REBUILD="" \
  CLOAK_CODESIGN_IDENTITY=- \
    "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1; then
  printf '%s\n' 'error: unknown candidate bypassed the pre-install compatibility matrix' >&2
  exit 1
fi
test "$(sed -n '1p' "$calls")" = "info"
test "$(wc -l < "$calls" | tr -d ' ')" = "1"

# A pristine bundle is copied, TCC-patched, locally signed, gated, and promoted
# without changing the pristine source hash.
rm -rf "$runtime_dir"
rm -f "$tmp/cache/current"
ln -s "$pristine_dir" "$tmp/cache/current"
printf '%s  %s\n' "$runtime_sha" "$runtime_bin" >"$gate_dir/live-challenge.sha256"

# Staging must fail before copying when the real filesystem has less than one
# bundle plus the safety reserve. The test cap can only lower the measured free
# space, so production callers cannot use it to bypass the guard.
: > "$calls"
if FAKE_WRAPPER_CALLS="$calls" \
  FAKE_EXPECTED_CACHE="$expected_cache" \
  FAKE_CURRENT_VERSION="$version" \
  FAKE_CURRENT_BIN="$bin" \
  CLOAKBROWSER_DIR="$tmp/cache" \
  CLOAK_WRAPPER_BIN="$wrapper" \
  CLOAK_PICKER_AUTO_REBUILD="" \
  CLOAK_CODESIGN_IDENTITY=- \
  CLOAK_UPDATE_TEST_AVAILABLE_BYTES=1 \
    "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1; then
  printf '%s\n' 'error: low-space runtime staging unexpectedly succeeded' >&2
  exit 1
fi
test "$(readlink "$tmp/cache/current")" = "$pristine_dir"
grep -q 'insufficient free space for runtime staging' "$tmp/cache/update.log"
test -z "$(find "$tmp/cache/update-staging" -maxdepth 1 -name '.stage.*' -print -quit)"

: > "$calls"
FAKE_WRAPPER_CALLS="$calls" \
FAKE_EXPECTED_CACHE="$expected_cache" \
FAKE_CURRENT_VERSION="$version" \
FAKE_CURRENT_BIN="$bin" \
CLOAKBROWSER_DIR="$tmp/cache" \
CLOAK_WRAPPER_BIN="$wrapper" \
CLOAK_PICKER_AUTO_REBUILD="" \
CLOAK_CODESIGN_IDENTITY=- \
CLOAK_UPDATE_SKIP_UI_REFRESH=1 \
  "$ROOT/packaging/update-chromium.sh" >/dev/null 2>&1 || {
    printf '%s\n' 'error: staged local runtime promotion failed; updater log follows' >&2
    sed -n '1,260p' "$tmp/cache/update.log" >&2
    exit 1
  }
test -d "$runtime_app"
test "$(readlink "$tmp/cache/current")" = "$(cd "$runtime_dir" && pwd -P)"
test -f "$runtime_dir/.notrace-local-runtime"
test "$(shasum -a 256 "$bin" | awk '{print $1}')" = "$pristine_sha"
test "$(/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' \
  "$runtime_app/Contents/Info.plist")" = "ChatGPT voice input uses the microphone."
/usr/bin/codesign --verify --deep --strict "$runtime_app"
test ! -d "$tmp/cache/update-staging/chromium-$version-notrace"

printf 'official wrapper routing checks passed\n'
