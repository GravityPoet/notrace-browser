#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'native Picker E2E requires macOS' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node - "$ROOT/cloak-picker/src-tauri/src/native_e2e.rs" <<'JS'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const driver = source.match(/const NATIVE_E2E_DRIVER: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!driver) throw new Error('native E2E driver missing');
new Function(driver);
JS
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
broker_pid=""
cleanup() {
  if [[ -n "$broker_pid" ]]; then kill "$broker_pid" 2>/dev/null || true; wait "$broker_pid" 2>/dev/null || true; fi
  if [[ -n "$picker_pid" ]] && kill -0 "$picker_pid" 2>/dev/null; then
    kill -TERM "$picker_pid" 2>/dev/null || true
    wait "$picker_pid" 2>/dev/null || true
  fi
  if [[ "${CLOAK_PICKER_NATIVE_E2E_KEEP_TMP:-}" != "1" ]]; then rm -rf "$tmp"; else printf 'native-e2e-temp=%s\n' "$tmp" >&2; fi
}
trap cleanup EXIT INT TERM

browser_root="$tmp/browser"
version_dir="$browser_root/chromium-145.0.7632.109.2"
browser="$version_dir/Chromium.app/Contents/MacOS/Chromium"
account_base="$tmp/accounts/native-e2e-profile-root-with-a-deliberately-long-path-for-layout-verification/segment-one-for-real-webview-overflow/segment-two-for-real-webview-overflow/segment-three-for-real-webview-overflow"
account_dir="$account_base/native-e2e-account"
sync_account_dir="$account_base/native-e2e-sync-account"
report="$tmp/cloak-picker-native-e2e-report.json"
log="$tmp/picker.log"
mkdir -p "$(dirname "$browser")" "$account_dir" "$sync_account_dir"
printf '%s\n' '#!/bin/sh' 'if [ "${1:-}" = "--version" ]; then printf "Chromium 145.0.7632.109.2\n"; else exit 76; fi' > "$browser"
chmod 700 "$browser"
# Resolve current to a plain executable for the synthetic launch failure; real
# browsers still use their ordinary LaunchServices bundle path.
mv "$browser" "$version_dir/chromium-fixture"
ln -s "$version_dir/chromium-fixture" "$browser"
ln -s "$version_dir" "$browser_root/current"
sha="$(shasum -a 256 "$browser" | awk '{print $1}')"
printf '%s  %s\n' "$sha" "$browser_root/current/Chromium.app/Contents/MacOS/Chromium" > "$browser_root/current.sha256"
chmod 600 "$browser_root/current.sha256"
printf '%s\n' '48152' > "$account_dir/.cloak-seed"
printf '%s\n' '1700000000000000' > "$account_dir/.cloak-created-at"
chmod 600 "$account_dir/.cloak-seed" "$account_dir/.cloak-created-at"
printf '%s\n' '48153' > "$sync_account_dir/.cloak-seed"
printf '%s\n' '1690000000000000' > "$sync_account_dir/.cloak-created-at"
chmod 600 "$sync_account_dir/.cloak-seed" "$sync_account_dir/.cloak-created-at"
touch "$sync_account_dir/.cloak-trashed"

# An isolated metadata-only Broker and synthetic OAuth provider exercise the
# real native click path without using a real account or OpenAI credentials.
cat > "$tmp/broker-fixture.py" <<'PYFIX'
import json, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
class Handler(BaseHTTPRequestHandler):
    attempts = 0
    metadata = {"key": "", "email": "native-e2e-sync-account", "account_id": "synthetic-account", "plan_type": "plus", "expires_at": 1900000000, "last_refresh_at": 1899000000, "generation": 2, "refresh_count": 0, "automatic_refresh_count": 0, "next_refresh_at": 1899900000, "next_retry_at": None, "error": None, "cpa_enabled": False, "cpa_synced_generation": 1, "cpa_sync_error": None, "cockpit_synced_generation": None}
    def do_GET(self) -> None:
        profile = Path(sys.argv[2]) / ".cloak-profile.json"
        rows = []
        if profile.exists():
            Handler.metadata["key"] = json.loads(profile.read_text())["profile_id"]
            rows = [Handler.metadata]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(rows).encode())
    def do_POST(self) -> None:
        settings = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if not self.path.endswith("/cpa") or settings.get("enabled") is not True:
            self.send_error(400)
            return
        Handler.attempts += 1
        Handler.metadata["cpa_enabled"] = True
        Handler.metadata["cpa_sync_error"] = "storage" if Handler.attempts == 1 else None
        if Handler.attempts > 1:
            Handler.metadata["cpa_synced_generation"] = Handler.metadata["generation"]
        time.sleep(0.2)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(Handler.metadata).encode())
    def log_message(self, *args) -> None: pass
server = HTTPServer(("127.0.0.1", 0), Handler)
Path(sys.argv[1]).write_text(json.dumps({"endpoint": f"http://127.0.0.1:{server.server_port}", "admin_key": "synthetic-native-e2e-key-000000000000"}))
server.serve_forever()
PYFIX
connection="$(dirname "$account_base")/.notrace-broker-client.json"
python3 "$tmp/broker-fixture.py" "$connection" "$sync_account_dir" >"$tmp/broker.log" 2>&1 &
broker_pid="$!"
for attempt in $(seq 1 50); do [[ -s "$connection" ]] && break; sleep 0.1; done
[[ -s "$connection" ]] || { printf '%s\n' 'fixture broker failed to start' >&2; exit 1; }
cat > "$tmp/codex-fixture" <<'PYFIX'
#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        result = {}
    elif message.get("method") == "account/login/start":
        result = {"loginId": "native-e2e", "authUrl": "https://auth.openai.com/oauth/authorize?state=synthetic"}
    else:
        continue
    print(json.dumps({"id": message["id"], "result": result}), flush=True)
PYFIX
chmod 700 "$tmp/codex-fixture"
CLOAK_SKIP_GEO=1 \
CLOAK_CODEX_BINARY="$tmp/codex-fixture" \
CLOAK_ACCOUNT_BASE="$account_base" \
CLOAK_BROWSER_ROOT="$browser_root" \
CLOAK_EXTENSION_SOURCE="$ROOT/extension/cloak-companion" \
CLOAK_PICKER_LOCK="$tmp/picker.lock" \
CLOAK_PICKER_NATIVE_E2E_REPORT="$report" \
CLOAK_REPO_ROOT="$ROOT" \
  "$executable" >"$log" 2>&1 &
picker_pid="$!"

if ! xcrun swift "$ROOT/packaging/picker-native-window-check.swift" "$picker_pid"; then
  if kill -0 "$picker_pid" 2>/dev/null; then
    printf '%s\n' 'Picker is running but has no visible native window.' >&2
  else
    printf '%s\n' 'Picker exited before its native window became visible.' >&2
  fi
  sed -n '1,100p' "$log" >&2
  exit 1
fi

attempt=0
while [[ ! -s "$report" ]] && [[ "$attempt" -lt 300 ]]; do
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
    "renewal-pane-visible-search",
    "renewal-search-authorize-seat-error",
    "renewal-header-active-and-trash-launch",
    "cpa-sync-pending-retry-success",
    "searched-account-context-preserves-selection",
    "account-context-submenu-and-restore",
    "bulk-workspace-large-actions",
    "account-tab-aria-controls",
    "account-tab-keyboard-focus",
    "path-ellipsis-copy-source",
    "path-copy-action",
    "runtime-source-provenance",
    "close-all-native-command",
    "migration-tab-keyboard-aria-controls",
    "account-delete-native-confirmation",
  ];
  const missing = required.filter((check) => !report.checks.includes(check));
  if (!report.passed || report.error || missing.length) {
    throw new Error(JSON.stringify({ report, missing }));
  }
' "$report"

printf '%s\n' 'native Picker E2E checks passed'
