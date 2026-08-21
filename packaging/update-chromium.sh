#!/bin/bash
set -euo pipefail

# Stage CloakBrowser releases through the pinned official wrapper, then promote
# only after NoTrace's local and headed challenge gates pass. The wrapper owns
# license routing, release selection, SHA256 verification and Ed25519 manifest
# verification for newly downloaded official archives. NoTrace leaves the
# wrapper-managed source directory unchanged and creates a separately named local-only
# `-notrace` runtime with the macOS TCC declarations and persistent local
# signature required by voice, camera, and phone Passkeys. Existing cache hits
# are structurally code-signature checked but cannot be retroactively proven to
# match the originally downloaded archive.
#
# Safe timer behaviour:
#   - current stays on the last approved build while a candidate is staged;
#   - a running NoTrace Chromium defers all update writes;
#   - DRY_RUN=1 is read-only;
#   - CLOAK_UPDATE_LIVE_GATE=1 is required for promotion;
#   - all installed builds remain available to rollback-chromium.sh.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# A GUI launchd domain can carry unrelated session credentials. The official
# wrapper needs its own CLOAKBROWSER_LICENSE_KEY when configured, but it does
# not need generic GitHub/npm tokens. Also clear upstream bypass/override knobs
# so this updater always uses its pinned wrapper, official source and gates.
unset GITHUB_PAT_TOKEN GITHUB_TOKEN GH_TOKEN NPM_TOKEN NODE_AUTH_TOKEN
unset CLOAKBROWSER_BINARY_PATH CLOAKBROWSER_DOWNLOAD_URL CLOAKBROWSER_SKIP_CHECKSUM
unset CLOAKBROWSER_AUTO_UPDATE CLOAKBROWSER_VERSION CLOAKBROWSER_RELEASE_CHANNEL
unset CLOAKBROWSER_LICENSE_STATUS_FILE

CB="${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}"
DEFAULT_CB="$HOME/.cloakbrowser"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$CB/update.log"
RUNTIME_SHA_FILE="$CB/current.sha256"
WRAPPER_DIR="$ROOT/packaging/cloakbrowser-wrapper"
WRAPPER_BIN="${CLOAK_WRAPPER_BIN:-$WRAPPER_DIR/node_modules/.bin/cloakbrowser}"
WRAPPER_LOCK="$WRAPPER_DIR/package-lock.json"
WRAPPER_MARKER="$WRAPPER_DIR/node_modules/.notrace-package-lock.sha256"
WRAPPER_VERSION="0.5.8"
COMPATIBILITY_AUDIT="$ROOT/packaging/audit-cloakbrowser-compatibility.mjs"
CHANNEL="${CLOAK_BROWSER_CHANNEL:-stable}"
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

mkdir -p "$CB"
if [[ -L "$LOG" ]]; then
  printf 'error: refusing to append through a symlinked update log: %s\n' "$LOG" >&2
  exit 1
fi
log() {
  local line
  line="$(printf '%s %s' "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
  if [[ "${NOTRACE_UPDATE_LAUNCHD:-}" == "1" ]]; then
    printf '%s\n' "$line" >> "$LOG"
  else
    printf '%s\n' "$line" | tee -a "$LOG" >&2
  fi
}
die() { log "ERROR: $*"; exit 1; }

case "$CHANNEL" in
  stable|preview) ;;
  *) die "CLOAK_BROWSER_CHANNEL 无效：$CHANNEL（仅支持 stable/preview）" ;;
esac

marker_hash() {
  if [[ -f "$1" ]]; then
    awk 'NR == 1 { print $1 }' "$1"
  fi
  return 0
}

write_hash_file() {
  local file="$1" hash="$2" path="$3" tmp_file
  mkdir -p "$(dirname "$file")"
  tmp_file="$file.tmp.$$"
  umask 077
  printf '%s  %s\n' "$hash" "$path" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "$file"
}

path_size_bytes() {
  local kib
  kib="$(/usr/bin/du -sk "$1" | awk 'NR == 1 { print $1 }')"
  [[ "$kib" =~ ^[0-9]+$ ]] || die "could not measure staging source: $1"
  printf '%s\n' "$((kib * 1024))"
}

available_space_bytes() {
  local path="$1" available test_cap
  available="$(/bin/df -Pk "$path" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')"
  [[ "$available" =~ ^[0-9]+$ ]] || die "could not measure free space for: $path"
  # Tests may only reduce the observed value; this cannot be used to bypass the
  # production guard by claiming more space than the filesystem reports.
  test_cap="${CLOAK_UPDATE_TEST_AVAILABLE_BYTES:-}"
  if [[ "$test_cap" =~ ^[0-9]+$ ]] && (( test_cap < available )); then
    available="$test_cap"
  fi
  printf '%s\n' "$available"
}

ensure_staging_capacity() {
  local source="$1" destination="$2" payload reserve required available
  payload="$(path_size_bytes "$source")"
  reserve="$((payload / 20))"
  if (( reserve < 268435456 )); then
    reserve=268435456
  fi
  required="$((payload + reserve))"
  available="$(available_space_bytes "$destination")"
  log "staging capacity required=$required available=$available payload=$payload reserve=$reserve"
  (( available >= required )) \
    || die "insufficient free space for runtime staging: need=$required available=$available; current unchanged"
}

resolve_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

CB_REAL="$(resolve_dir "$CB")"
export CLOAKBROWSER_CACHE_DIR="$CB_REAL"

ensure_cache_directory() {
  local dir="$1" resolved
  [[ ! -L "$dir" ]] || die "cache directory must not be a symlink: $dir"
  mkdir -p "$dir"
  resolved="$(resolve_dir "$dir")"
  case "$resolved" in
    "$CB_REAL"|"$CB_REAL"/*) ;;
    *) die "cache directory escapes configured root: $dir -> $resolved" ;;
  esac
}

browser_running() {
  local listing
  listing="$(ps axww -o command= 2>/dev/null || true)"
  if printf '%s\n' "$listing" | awk -v root="$CB/" -v real_root="$CB_REAL/" '
    (index($0, root) || index($0, real_root)) && \
      index($0, "/Chromium.app/Contents/MacOS/Chromium") { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    return 0
  fi
  if [[ "$CB" == "$DEFAULT_CB" ]] && printf '%s\n' "$listing" | awk '
    index($0, "--user-data-dir=") && index($0, "NoTrace Browser") { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    return 0
  fi
  return 1
}

binary_for_dir() {
  printf '%s/Chromium.app/Contents/MacOS/Chromium\n' "$1"
}

parse_distribution_name() {
  local name="$1"
  if [[ ! "$name" =~ ^chromium-([0-9]+([.][0-9]+){3,4})(-pro)?(-notrace)?$ ]]; then
    return 1
  fi
  DIST_VERSION="${BASH_REMATCH[1]}"
  if [[ -n "${BASH_REMATCH[3]:-}" ]]; then
    DIST_TIER="pro"
  else
    DIST_TIER="free"
  fi
  if [[ -n "${BASH_REMATCH[4]:-}" ]]; then
    DIST_RUNTIME="local"
  else
    DIST_RUNTIME="source-cache"
  fi
}

version_newer() {
  local candidate="$1" stable="$2" newest
  newest="$(printf '%s\n%s\n' "$stable" "$candidate" | sort -V | tail -1)"
  [[ "$newest" == "$candidate" && "$candidate" != "$stable" ]]
}

current_dir=""
if [[ -L "$CB/current" ]]; then
  current_target="$(readlink "$CB/current")"
  case "$current_target" in
    /*) current_dir="$(resolve_dir "$current_target" || true)" ;;
    *) current_dir="$(resolve_dir "$CB/$current_target" || true)" ;;
  esac
elif [[ -e "$CB/current" ]]; then
  die "current 不是符号链接，为避免覆盖而停止：$CB/current"
fi
if [[ -z "$current_dir" ]]; then
  fallback_dir="$(/bin/ls -d "$CB"/chromium-* 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$fallback_dir" ]] || die "no installed Chromium found under $CB"
  current_dir="$(resolve_dir "$fallback_dir")"
fi

installed_name="$(basename "$current_dir")"
parse_distribution_name "$installed_name" || die "current 指向无法识别的发行目录：$current_dir"
installed_version="$DIST_VERSION"
installed_tier="$DIST_TIER"
installed_runtime="$DIST_RUNTIME"
installed_bin="$(binary_for_dir "$current_dir")"
[[ -x "$installed_bin" ]] || die "current Chromium 不可执行：$installed_bin"
log "current=$installed_name version=$installed_version tier=$installed_tier runtime=$installed_runtime channel=$CHANNEL wrapper=$WRAPPER_VERSION"

# Picker statically links cloak-core. Check its freshness even on no-op runs, but
# never let DRY_RUN rebuild it.
if [[ -n "${DRY_RUN:-}" ]]; then
  CLOAK_PICKER_AUTO_REBUILD="" "$ROOT/packaging/check-picker-fresh.sh" >>"$LOG" 2>&1 || true
else
  "$ROOT/packaging/check-picker-fresh.sh" >>"$LOG" 2>&1 || log "warn: picker freshness check failed"
fi

pin="${CLOAK_BROWSER_PIN:-}"
if [[ -n "$pin" ]]; then
  pin="${pin#chromium-v}"
  pin="${pin#chromium-}"
  pin="${pin%-notrace}"
  pin="${pin%-pro}"
  [[ "$pin" =~ ^[0-9]+([.][0-9]+){3,4}$ ]] || die "CLOAK_BROWSER_PIN 无效：$pin"
fi

if [[ "$pin" == "150.0.7871.114.3" ]]; then
  log "candidate $pin is blocked on macOS (confirmed browserTampering regression); current unchanged"
  exit 0
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  if [[ -n "$pin" ]]; then
    log "DRY-RUN: official wrapper would resolve signed candidate version $pin; current unchanged"
  else
    log "DRY-RUN: official wrapper would resolve latest signed $CHANNEL candidate; current unchanged"
  fi
  exit 0
fi

if browser_running; then
  log "Cloak Chromium running; defer update to next run"
  exit 0
fi

ensure_wrapper() {
  local lock_hash installed_hash
  command -v node >/dev/null 2>&1 || die "Node.js 20+ not found"
  if [[ -n "${CLOAK_WRAPPER_BIN:-}" ]]; then
    [[ -x "$WRAPPER_BIN" ]] || die "CLOAK_WRAPPER_BIN is not executable: $WRAPPER_BIN"
    log "using explicit CloakBrowser wrapper executable: $WRAPPER_BIN"
    return
  fi
  command -v npm >/dev/null 2>&1 || die "npm not found"
  [[ -f "$WRAPPER_LOCK" ]] || die "official wrapper lockfile missing: $WRAPPER_LOCK"
  lock_hash="$(shasum -a 256 "$WRAPPER_LOCK" | awk '{print $1}')"
  installed_hash="$(marker_hash "$WRAPPER_MARKER")"
  if [[ ! -x "$WRAPPER_BIN" || "$installed_hash" != "$lock_hash" ]]; then
    log "installing pinned official CloakBrowser wrapper $WRAPPER_VERSION"
    (cd "$WRAPPER_DIR" && npm ci --omit=optional --ignore-scripts) >>"$LOG" 2>&1 \
      || die "npm ci failed for pinned CloakBrowser wrapper"
    [[ -x "$WRAPPER_BIN" ]] || die "official wrapper executable missing after npm ci"
    write_hash_file "$WRAPPER_MARKER" "$lock_hash" "$WRAPPER_LOCK"
  fi
  actual_wrapper_version="$(node -p 'require(process.argv[1]).version' \
    "$WRAPPER_DIR/node_modules/cloakbrowser/package.json" 2>/dev/null || true)"
  [[ "$actual_wrapper_version" == "$WRAPPER_VERSION" ]] \
    || die "official wrapper version mismatch: got=${actual_wrapper_version:-unknown} expected=$WRAPPER_VERSION"
}

ensure_wrapper
node "$COMPATIBILITY_AUDIT" >>"$LOG" 2>&1 \
  || die "wrapper compatibility audit failed; current unchanged"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-cloak-update.XXXXXX")"
stage_work=""
stage_container=""
cleanup() {
  rm -rf "$tmp"
  if [[ -n "$stage_container" && -d "$stage_container" ]]; then
    case "$stage_container" in
      "$CB_REAL"/update-staging/.stage."$$") rm -rf "$stage_container" ;;
      *) log "warn: refusing to clean unexpected staging path: $stage_container" ;;
    esac
  fi
}
trap cleanup EXIT

if [[ -n "$pin" ]]; then
  node "$COMPATIBILITY_AUDIT" --candidate "$pin" >>"$LOG" 2>&1 \
    || die "pinned candidate $pin is not approved; wrapper install was not started"
fi

if [[ -z "$pin" ]] && CLOAKBROWSER_RELEASE_CHANNEL="$CHANNEL" \
  "$WRAPPER_BIN" info --json >"$tmp/wrapper-info.json" 2>"$tmp/wrapper-info.err"; then
  candidate_hint="$(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(data?.binary?.latest_version || data?.binary?.version || ""));
  ' "$tmp/wrapper-info.json" 2>/dev/null || true)"
  if [[ "$candidate_hint" == "150.0.7871.114.3" ]]; then
    log "latest macOS candidate $candidate_hint is blocked (confirmed browserTampering regression); current unchanged"
    exit 0
  fi
  if [[ -n "$candidate_hint" ]]; then
    node "$COMPATIBILITY_AUDIT" --candidate "$candidate_hint" >>"$LOG" 2>&1 \
      || die "latest candidate $candidate_hint is not approved; wrapper install was not started"
  fi
fi

log "resolving candidate through official wrapper (license-aware, signed manifest required)"
if [[ -n "$pin" ]]; then
  if ! CLOAKBROWSER_VERSION="$pin" CLOAKBROWSER_RELEASE_CHANNEL="$CHANNEL" \
    "$WRAPPER_BIN" install >"$tmp/wrapper.out" 2>"$tmp/wrapper.err"; then
    log "official wrapper reported an install failure; stderr omitted from persistent logs"
    die "official wrapper could not install pinned candidate $pin"
  fi
else
  if ! CLOAKBROWSER_RELEASE_CHANNEL="$CHANNEL" \
    "$WRAPPER_BIN" install >"$tmp/wrapper.out" 2>"$tmp/wrapper.err"; then
    log "official wrapper reported an install failure; stderr omitted from persistent logs"
    die "official wrapper could not resolve/install a candidate"
  fi
fi

candidate_bin="$(awk '/\/Chromium[.]app\/Contents\/MacOS\/Chromium$/ { path = $0 } END { print path }' "$tmp/wrapper.out")"
[[ -n "$candidate_bin" ]] || die "official wrapper did not return a Chromium binary path"
case "$candidate_bin" in
  "$CB"/chromium-*/Chromium.app/Contents/MacOS/Chromium) ;;
  *) die "official wrapper returned a path outside the configured cache: $candidate_bin" ;;
esac
[[ -x "$candidate_bin" ]] || die "candidate Chromium 不可执行：$candidate_bin"
candidate_dir="${candidate_bin%/Chromium.app/Contents/MacOS/Chromium}"
candidate_dir="$(resolve_dir "$candidate_dir")"
case "$candidate_dir" in
  "$CB_REAL"/chromium-*) ;;
  *) die "official wrapper candidate escapes the configured cache after path resolution: $candidate_dir" ;;
esac
candidate_name="$(basename "$candidate_dir")"
parse_distribution_name "$candidate_name" || die "official wrapper returned an unknown distribution directory: $candidate_name"
candidate_version="$DIST_VERSION"
candidate_tier="$DIST_TIER"
[[ "$DIST_RUNTIME" == "source-cache" ]] \
  || die "official wrapper returned a local runtime instead of its source cache: $candidate_name"
if [[ -n "$pin" && "$candidate_version" != "$pin" ]]; then
  die "official wrapper resolved $candidate_version instead of requested pin $pin"
fi
log "candidate=$candidate_name version=$candidate_version tier=$candidate_tier"

if [[ "$candidate_version" == "$installed_version" ]]; then
  if [[ "$installed_tier" == "pro" && "$candidate_tier" != "pro" ]]; then
    log "official wrapper resolved a lower distribution tier; current unchanged"
    exit 0
  fi
elif ! version_newer "$candidate_version" "$installed_version"; then
  log "candidate is not newer than current; current unchanged"
  exit 0
fi

# Upstream confirmed this exact macOS 150 build has a browserTampering regression
# and announced a replacement Mac build. Refuse it before creating a local runtime.
case "$candidate_version" in
  150.0.7871.114.3)
    log "candidate $candidate_version is blocked on macOS (confirmed browserTampering regression); current unchanged"
    exit 0
    ;;
esac

node "$COMPATIBILITY_AUDIT" --candidate "$candidate_version" >>"$LOG" 2>&1 \
  || die "candidate $candidate_version is not approved by the macOS compatibility matrix; current unchanged"

candidate_app="$candidate_dir/Chromium.app"
[[ -d "$candidate_app" ]] || die "candidate Chromium.app missing: $candidate_app"
[[ ! -L "$candidate_app" ]] || die "candidate Chromium.app must not be a symlink: $candidate_app"
[[ ! -L "$candidate_app/Contents" && ! -L "$candidate_app/Contents/MacOS" ]] \
  || die "candidate Chromium executable path must not contain symlinked directories"
candidate_bin="$candidate_app/Contents/MacOS/Chromium"
[[ -x "$candidate_bin" && ! -L "$candidate_bin" ]] \
  || die "candidate Chromium binary must be an executable regular path: $candidate_bin"
/usr/bin/codesign --verify --deep --strict "$candidate_app" >>"$LOG" 2>&1 \
  || die "candidate code signature verification failed; current unchanged"

source_binary_sha="$(shasum -a 256 "$candidate_bin" | awk '{print $1}')"
[[ "$source_binary_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "could not hash wrapper cache binary"
source_cdhash="$(/usr/bin/codesign -d --verbose=4 "$candidate_app" 2>&1 \
  | awk -F= '/^CDHash=/{value=$2} END{print value}')"
[[ "$source_cdhash" =~ ^[0-9a-fA-F]+$ && ${#source_cdhash} -ge 40 ]] \
  || die "could not read wrapper cache bundle CDHash"
log "source cache binary sha256=$source_binary_sha bundle_cdhash=$source_cdhash (this updater leaves $candidate_dir unchanged)"

runtime_name="$candidate_name-notrace"
runtime_dir="$CB_REAL/$runtime_name"
runtime_stage_root="$CB_REAL/update-staging"
runtime_stage_dir="$runtime_stage_root/$runtime_name"
runtime_marker_name=".notrace-local-runtime"
runtime_source_name=".notrace-source.cdhash"
[[ ! -L "$runtime_dir" ]] || die "local runtime path must not be a symlink: $runtime_dir"
[[ ! -L "$runtime_stage_root" ]] || die "runtime staging root must not be a symlink: $runtime_stage_root"
[[ ! -L "$runtime_stage_dir" ]] || die "staged runtime path must not be a symlink: $runtime_stage_dir"
ensure_cache_directory "$runtime_stage_root"

runtime_matches_source() {
  local dir="$1"
  [[ -d "$dir/Chromium.app" ]] \
    && [[ -f "$dir/$runtime_marker_name" ]] \
    && [[ "$(marker_hash "$dir/$runtime_source_name")" == "$source_cdhash" ]]
}

verify_runtime_bundle() {
  local app="$1" plist key value helpers helper
  local runtime_plists
  /usr/bin/codesign --verify --deep --strict "$app" >>"$LOG" 2>&1 \
    || die "local runtime signature verification failed: $app"
  runtime_plists=("$app/Contents/Info.plist")
  helpers="$app/Contents/Frameworks/Chromium Framework.framework/Versions/Current/Helpers"
  for helper in "$helpers"/*.app; do
    [[ -d "$helper" ]] || continue
    runtime_plists+=("$helper/Contents/Info.plist")
  done
  for plist in "${runtime_plists[@]}"; do
    [[ -f "$plist" ]] || die "local runtime plist missing: $plist"
    for key in NSMicrophoneUsageDescription NSCameraUsageDescription NSBluetoothAlwaysUsageDescription; do
      value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true)"
      [[ -n "$value" ]] || die "local runtime lacks $key in $plist"
    done
  done
}

if runtime_matches_source "$runtime_dir"; then
  gate_runtime_dir="$runtime_dir"
  log "reusing local runtime with matching source-cache CDHash: $runtime_dir"
elif runtime_matches_source "$runtime_stage_dir"; then
  gate_runtime_dir="$runtime_stage_dir"
  log "reusing staged local runtime with matching source-cache CDHash: $runtime_stage_dir"
else
  stage_container="$runtime_stage_root/.stage.$$"
  stage_work="$stage_container/$runtime_name"
  [[ ! -e "$stage_container" ]] || die "staging path already exists: $stage_container"
  ensure_staging_capacity "$candidate_app" "$runtime_stage_root"
  mkdir -p "$stage_work"
  log "copying wrapper cache source to local-only runtime staging"
  /usr/bin/ditto "$candidate_app" "$stage_work/Chromium.app" \
    || die "could not copy wrapper cache source into local runtime staging"
  umask 077
  printf '%s\n' 'NoTrace local runtime v1; do not redistribute' \
    >"$stage_work/$runtime_marker_name"
  chmod 600 "$stage_work/$runtime_marker_name"
  write_hash_file "$stage_work/$runtime_source_name" "$source_cdhash" "$candidate_app"
  CLOAKBROWSER_DIR="$CB_REAL" \
  CLOAK_BROWSER_APP="$stage_work/Chromium.app" \
  CLOAK_LOCAL_RUNTIME_PATCH=1 \
    "$ROOT/packaging/patch-chromium.sh" >>"$LOG" 2>&1 \
    || die "could not create signed TCC-ready local runtime"
  verify_runtime_bundle "$stage_work/Chromium.app"

  if [[ -d "$runtime_stage_dir" ]]; then
    staging_backup_root="$CB_REAL/backups/update-staging"
    ensure_cache_directory "$CB_REAL/backups"
    ensure_cache_directory "$staging_backup_root"
    staging_backup="$staging_backup_root/$runtime_name.$(date '+%Y%m%d-%H%M%S').$$"
    mv "$runtime_stage_dir" "$staging_backup" \
      || die "could not preserve previous updater staging runtime"
    log "previous staging runtime preserved at $staging_backup"
  fi
  mv "$stage_work" "$runtime_stage_dir" \
    || die "could not finalize local runtime staging"
  rmdir "$stage_container" \
    || die "could not remove empty runtime staging container"
  stage_work=""
  stage_container=""
  gate_runtime_dir="$runtime_stage_dir"
fi

gate_runtime_app="$gate_runtime_dir/Chromium.app"
gate_runtime_bin="$gate_runtime_app/Contents/MacOS/Chromium"
[[ -x "$gate_runtime_bin" ]] || die "local runtime Chromium is not executable: $gate_runtime_bin"
CLOAKBROWSER_DIR="$CB_REAL" \
CLOAK_BROWSER_APP="$gate_runtime_app" \
CLOAK_LOCAL_RUNTIME_PATCH=1 \
  "$ROOT/packaging/patch-chromium.sh" >>"$LOG" 2>&1 \
  || die "could not verify/refresh the local runtime TCC signature"
verify_runtime_bundle "$gate_runtime_app"

runtime_sha="$(shasum -a 256 "$gate_runtime_bin" | awk '{print $1}')"
[[ "$runtime_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "could not hash local runtime"
log "local runtime=$runtime_name sha256=$runtime_sha source_binary_sha256=$source_binary_sha source_bundle_cdhash=$source_cdhash"

ensure_cache_directory "$CB_REAL/update-gates"
gate_dir="$CB_REAL/update-gates/$runtime_name"
ensure_cache_directory "$gate_dir"
local_pass_file="$gate_dir/local-contract.sha256"
live_pass_file="$gate_dir/live-challenge.sha256"
if [[ "$(marker_hash "$local_pass_file")" == "$runtime_sha" ]]; then
  log "local contract gate already passed for $runtime_name"
else
  log "running local contract gate for $runtime_name"
  CLOAK_BROWSER_BIN="$gate_runtime_bin" \
  CLOAK_BROWSER_EXPECTED_SHA256="$runtime_sha" \
    "$ROOT/packaging/verify-challenge-contract.sh" >>"$LOG" 2>&1 \
    || die "local runtime failed contract; current unchanged (source cache kept at $candidate_dir)"
  write_hash_file "$local_pass_file" "$runtime_sha" "$gate_runtime_bin"
  log "local contract gate PASS for $runtime_name"
fi

if [[ "$(marker_hash "$live_pass_file")" == "$runtime_sha" ]]; then
  log "live challenge gate already passed for $runtime_name"
elif [[ "${CLOAK_UPDATE_LIVE_GATE:-}" == "1" ]]; then
  live_report_dir="$gate_dir/live-$(date '+%Y%m%d-%H%M%S')"
  ensure_cache_directory "$live_report_dir"
  log "running live challenge gate for $runtime_name -> $live_report_dir"
  CLOAK_BROWSER_BIN="$gate_runtime_bin" \
  CLOAK_BROWSER_EXPECTED_SHA256="$runtime_sha" \
    node "$ROOT/selftest/run-live-challenge-audit.mjs" \
      --headed \
      --site version-consistency \
      --site cloudflare-turnstile-test \
      --site browserscan \
      --site sannysoft \
      --site browserleaks-webrtc \
      --site creepjs \
      --site fingerprint-pro \
      --timeout-ms 120000 \
      --no-screenshots \
      --account-name "update-candidate-$(date '+%s')" \
      --result-dir "$live_report_dir" >>"$LOG" 2>&1 \
    || die "local runtime failed live challenge gate; current unchanged (report: $live_report_dir/report.json)"
  write_hash_file "$live_pass_file" "$runtime_sha" "$gate_runtime_bin"
  log "live challenge gate PASS for $runtime_name"
else
  log "local runtime passed contract but live challenge gate was not run; current unchanged"
  log "to verify and promote: CLOAK_UPDATE_LIVE_GATE=1 $ROOT/packaging/update-chromium.sh"
  exit 0
fi

if [[ "$gate_runtime_dir" != "$runtime_dir" ]]; then
  runtime_backup=""
  if [[ -e "$runtime_dir" ]]; then
    [[ -d "$runtime_dir" && ! -L "$runtime_dir" ]] \
      || die "existing local runtime is not a safe directory: $runtime_dir"
    runtime_backup_root="$CB_REAL/backups/runtimes"
    [[ ! -L "$runtime_backup_root" ]] || die "runtime backup root must not be a symlink: $runtime_backup_root"
    ensure_cache_directory "$CB_REAL/backups"
    ensure_cache_directory "$runtime_backup_root"
    runtime_backup="$runtime_backup_root/$runtime_name.$(date '+%Y%m%d-%H%M%S').$$"
    mv "$runtime_dir" "$runtime_backup" \
      || die "could not preserve previous local runtime"
    log "previous local runtime preserved at $runtime_backup"
  fi
  if ! mv "$gate_runtime_dir" "$runtime_dir"; then
    if [[ -n "$runtime_backup" && ! -e "$runtime_dir" ]]; then
      mv "$runtime_backup" "$runtime_dir" \
        || log "ERROR: automatic runtime restore failed; backup remains at $runtime_backup"
    fi
    die "could not install gated local runtime; current pointer unchanged"
  fi
  gate_runtime_dir="$runtime_dir"
  gate_runtime_app="$runtime_dir/Chromium.app"
  gate_runtime_bin="$gate_runtime_app/Contents/MacOS/Chromium"
fi

candidate_link="$CB_REAL/.current.promote.$$"
rm -f "$candidate_link"
ln -s "$runtime_dir" "$candidate_link"
if ! /bin/mv -f -h "$candidate_link" "$CB_REAL/current"; then
  rm -f "$candidate_link"
  die "atomic current promotion failed; stable build unchanged"
fi
write_hash_file "$RUNTIME_SHA_FILE" "$runtime_sha" "$CB_REAL/current/Chromium.app/Contents/MacOS/Chromium"
log "current -> $runtime_dir"

if [[ "${CLOAK_UPDATE_SKIP_UI_REFRESH:-}" != "1" ]]; then
  [[ -x "$LSREG" ]] && { "$LSREG" -f "$gate_runtime_app" >>"$LOG" 2>&1 || log "warn: lsregister failed"; }
  "$ROOT/packaging/set-pwa-icon.sh" >>"$LOG" 2>&1 || log "warn: set-pwa-icon failed"
else
  log "UI refresh skipped by CLOAK_UPDATE_SKIP_UI_REFRESH=1"
fi

log "updated $installed_name -> $runtime_name OK (source cache and previous builds retained for rollback)"
