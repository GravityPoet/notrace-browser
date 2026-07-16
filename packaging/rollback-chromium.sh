#!/bin/bash
set -euo pipefail

# Switch only between already-installed, verified CloakBrowser builds. This
# never downloads, rebuilds, patches, or changes fingerprint/privacy settings.
# The previous version remains on disk and `current` is swapped atomically.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CB="${CLOAKBROWSER_DIR:-$HOME/.cloakbrowser}"
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
target="${target#chromium-}"
[[ "$target" =~ ^[0-9]+([.][0-9]+){0,4}$ ]] || die "版本号无效：$target"

dest="$CB/chromium-$target"
case "$dest" in
  "$CB"/chromium-*) ;;
  *) die "目标不在 CloakBrowser 根目录内" ;;
esac
[[ -d "$dest" ]] || die "目标版本未安装：$dest"
app="$dest/Chromium.app"
bin="$app/Contents/MacOS/Chromium"
[[ -x "$bin" ]] || die "目标 Chromium 不可执行：$bin"

version_output="$($bin --version 2>/dev/null || true)"
actual_version="$(printf '%s\n' "$version_output" | sed -E -n 's/^Chromium ([0-9]+([.][0-9]+){1,3}).*/\1/p')"
[[ -n "$actual_version" ]] || die "无法读取目标二进制版本：$version_output"
[[ "$target" == "$actual_version" || "$target" == "$actual_version".* ]] \
  || die "目标目录版本 $target 与二进制版本 $actual_version 不一致"

current="$CB/current"
if [[ -L "$current" ]]; then
  current_target="$(readlink "$current")"
  log "current=$current_target target=$dest"
  if [[ "$current_target" == "$dest" || "$current_target" == "chromium-$target" ]]; then
    log "already active; no-op"
    exit 0
  fi
elif [[ -e "$current" ]]; then
  die "current 不是符号链接，为避免覆盖而停止：$current"
else
  log "current 不存在，将建立新的稳定指针"
fi

if pgrep -f "user-data-dir=.*NoTrace Browser" >/dev/null 2>&1 || \
   pgrep -f "$CB/.*/Chromium.app/Contents/MacOS/Chromium" >/dev/null 2>&1; then
  die "Cloak Chromium 正在运行；关闭浏览器后重试"
fi

sha="$(shasum -a 256 "$bin" | awk '{print $1}')"
[[ "$sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "无法计算目标 SHA256"

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

tmp_hash="$CB/current.sha256.tmp.$$"
umask 077
printf '%s  %s\n' "$sha" "$current/Chromium.app/Contents/MacOS/Chromium" > "$tmp_hash"
chmod 600 "$tmp_hash"
mv -f "$tmp_hash" "$CB/current.sha256"
log "rollback complete: current -> $dest (sha256=$sha); previous build retained"
