#!/bin/bash
set -euo pipefail

# Switch only between already-installed, verified CloakBrowser builds or marked
# local `-notrace` runtime copies. This never downloads, rebuilds, patches, or
# changes fingerprint/privacy settings. The previous version remains on disk
# and `current` is swapped atomically.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CB="${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}"
DEFAULT_CB="$HOME/.cloakbrowser"
LOG="$CB/update.log"
DRY_RUN="${DRY_RUN:-}"

log() {
  mkdir -p "$CB"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

list_versions() {
  local dir version bin output
  for dir in "$CB"/chromium-*; do
    [[ -d "$dir" ]] || continue
    version="${dir##*/chromium-}"
    bin="$dir/Chromium.app/Contents/MacOS/Chromium"
    output="unknown"
    if [[ -x "$bin" ]]; then
      output="$($bin --version 2>/dev/null || printf 'unreadable')"
    fi
    printf '%s\t%s\n' "$version" "$output"
  done | sort -V
}

if [[ "${1:-}" == "--list" ]]; then
  list_versions
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

target="${1:-${CLOAK_BROWSER_ROLLBACK_VERSION:-}}"
[[ -n "$target" ]] || die "用法：$0 [--dry-run] <已安装版本号>；可用 --list 查看"
target="${target#chromium-v}"
target="${target#chromium-}"
[[ "$target" =~ ^[0-9]+([.][0-9]+){0,4}(-pro)?(-notrace)?$ ]] || die "版本号无效：$target"
target_distribution="${target%-notrace}"
target_version="${target_distribution%-pro}"

dest="$CB/chromium-$target"
case "$dest" in
  "$CB"/chromium-*) ;;
  *) die "目标不在 CloakBrowser 根目录内" ;;
esac
[[ -d "$dest" ]] || die "目标版本未安装：$dest"
[[ ! -L "$dest" ]] || die "目标版本目录不能是符号链接：$dest"
app="$dest/Chromium.app"
bin="$app/Contents/MacOS/Chromium"
[[ -x "$bin" ]] || die "目标 Chromium 不可执行：$bin"
/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 \
  || die "目标 Chromium 签名校验失败：$app"

if [[ "$target" == *-notrace ]]; then
  [[ -f "$dest/.notrace-local-runtime" ]] \
    || die "本机运行副本缺少来源标记：$dest"
  for usage_key in NSMicrophoneUsageDescription NSCameraUsageDescription NSBluetoothAlwaysUsageDescription; do
    usage_value="$(/usr/libexec/PlistBuddy -c "Print :$usage_key" "$app/Contents/Info.plist" 2>/dev/null || true)"
    [[ -n "$usage_value" ]] || die "本机运行副本缺少 $usage_key：$app"
  done
fi

version_output="$($bin --version 2>/dev/null || true)"
actual_version="$(printf '%s\n' "$version_output" | sed -E -n 's/^Chromium ([0-9]+([.][0-9]+){1,3}).*/\1/p')"
[[ -n "$actual_version" ]] || die "无法读取目标二进制版本：$version_output"
[[ "$target_version" == "$actual_version" || "$target_version" == "$actual_version".* ]] \
  || die "目标目录版本 $target_version 与二进制版本 $actual_version 不一致"
sha="$(shasum -a 256 "$bin" | awk '{print $1}')"
[[ "$sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "无法计算目标 SHA256"

write_hash_marker() {
  local tmp_hash="$CB/current.sha256.tmp.$$"
  umask 077
  printf '%s  %s\n' "$sha" "$current/Chromium.app/Contents/MacOS/Chromium" > "$tmp_hash"
  chmod 600 "$tmp_hash"
  if ! mv -f "$tmp_hash" "$CB/current.sha256"; then
    rm -f "$tmp_hash"
    die "写入 current.sha256 失败"
  fi
}

current="$CB/current"
if [[ -L "$current" ]]; then
  current_target="$(readlink "$current")"
  log "current=$current_target target=$dest"
  if [[ "$current_target" == "$dest" || "$current_target" == "chromium-$target" ]]; then
    marker_sha=""
    if [[ -f "$CB/current.sha256" && ! -L "$CB/current.sha256" ]]; then
      marker_sha="$(awk 'NR == 1 { print $1; exit }' "$CB/current.sha256")"
    fi
    if [[ "$marker_sha" == "$sha" ]]; then
      log "already active; current.sha256 verified; no-op"
      exit 0
    fi
    if [[ -n "$DRY_RUN" ]]; then
      log "DRY-RUN: would repair current.sha256 for already-active $dest (sha256=$sha)"
      exit 0
    fi
    write_hash_marker
    log "already active; repaired current.sha256 after signature, version, and binary hash validation"
    exit 0
  fi
elif [[ -e "$current" ]]; then
  die "current 不是符号链接，为避免覆盖而停止：$current"
else
  log "current 不存在，将建立新的稳定指针"
fi

browser_running() {
  local listing
  listing="$(ps axww -o command= 2>/dev/null || true)"
  if printf '%s\n' "$listing" | awk -v root="$CB/" '
    index($0, root) && index($0, "/Chromium.app/Contents/MacOS/Chromium") { found = 1 }
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

if browser_running; then
  die "Cloak Chromium 正在运行；关闭浏览器后重试"
fi

if [[ -n "$DRY_RUN" ]]; then
  log "DRY-RUN: would switch current -> $dest (sha256=$sha)"
  exit 0
fi

tmp_link="$CB/.current.rollback.$$"
rm -f "$tmp_link"
ln -s "$dest" "$tmp_link"
if ! /bin/mv -f -h "$tmp_link" "$current"; then
  rm -f "$tmp_link"
  die "原子切换 current 失败；原版本未改动"
fi

write_hash_marker
log "rollback complete: current -> $dest (sha256=$sha); previous build retained"
