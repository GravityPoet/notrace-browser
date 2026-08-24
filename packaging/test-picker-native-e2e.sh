#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'native Picker E2E requires macOS' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${CLOAK_PICKER_INSTALL_APP:-/Applications/Cloak Picker.app}"
[[ -d "$APP" ]] || { printf 'Picker app not found: %s\n' "$APP" >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$APP"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
[[ "$bundle_id" == "local.cloak.picker" ]] || { printf 'unexpected bundle id: %s\n' "$bundle_id" >&2; exit 1; }
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
executable="$APP/Contents/MacOS/$executable_name"
[[ -x "$executable" ]] || { printf 'Picker executable not found: %s\n' "$executable" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cloak-picker-native-e2e.XXXXXX")"
picker_pid=""
cleanup() {
  if [[ -n "$picker_pid" ]] && kill -0 "$picker_pid" 2>/dev/null; then
    kill -TERM "$picker_pid" 2>/dev/null || true
    wait "$picker_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

browser_root="$tmp/browser"
version_dir="$browser_root/chromium-145.0.7632.109.2"
browser="$version_dir/Chromium.app/Contents/MacOS/Chromium"
account_base="$tmp/accounts/native-e2e-profile-root-with-a-deliberately-long-path-for-layout-verification/segment-one-for-real-webview-overflow/segment-two-for-real-webview-overflow/segment-three-for-real-webview-overflow"
account_dir="$account_base/native-e2e-account"
report="$tmp/cloak-picker-native-e2e-report.json"
log="$tmp/picker.log"
mkdir -p "$(dirname "$browser")" "$account_dir"
printf '%s\n' '#!/bin/sh' 'printf "Chromium 145.0.7632.109.2\\n"' > "$browser"
chmod 700 "$browser"
ln -s "$version_dir" "$browser_root/current"
sha="$(shasum -a 256 "$browser" | awk '{print $1}')"
printf '%s  %s\n' "$sha" "$browser_root/current/Chromium.app/Contents/MacOS/Chromium" > "$browser_root/current.sha256"
chmod 600 "$browser_root/current.sha256"
printf '%s\n' '48152' > "$account_dir/.cloak-seed"
printf '%s\n' '1700000000000000' > "$account_dir/.cloak-created-at"
chmod 600 "$account_dir/.cloak-seed" "$account_dir/.cloak-created-at"

CLOAK_ACCOUNT_BASE="$account_base" \
CLOAK_BROWSER_ROOT="$browser_root" \
CLOAK_EXTENSION_SOURCE="$ROOT/extension/cloak-companion" \
CLOAK_PICKER_LOCK="$tmp/picker.lock" \
CLOAK_PICKER_NATIVE_E2E_REPORT="$report" \
CLOAK_REPO_ROOT="$ROOT" \
  "$executable" >"$log" 2>&1 &
picker_pid="$!"

xcrun swift "$ROOT/packaging/picker-native-window-check.swift" "$picker_pid"

attempt=0
while [[ ! -s "$report" ]] && [[ "$attempt" -lt 150 ]]; do
  if ! kill -0 "$picker_pid" 2>/dev/null; then
    printf '%s\n' 'Picker exited before producing the native E2E report:' >&2
    sed -n '1,160p' "$log" >&2
    exit 1
  fi
  sleep 0.2
  attempt=$((attempt + 1))
done
[[ -s "$report" ]] || { printf '%s\n' 'native Picker E2E report timed out' >&2; sed -n '1,160p' "$log" >&2; exit 1; }

node -e '
  const fs = require("fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const required = [
    "account-tab-aria-controls",
    "account-tab-keyboard-focus",
    "path-ellipsis-copy-source",
    "path-copy-action",
    "runtime-source-provenance",
    "migration-tab-keyboard-aria-controls",
  ];
  const missing = required.filter((check) => !report.checks.includes(check));
  if (!report.passed || report.error || missing.length) {
    throw new Error(JSON.stringify({ report, missing }));
  }
' "$report"

printf '%s\n' 'native Picker E2E checks passed'
