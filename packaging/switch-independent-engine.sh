#!/bin/bash
set -euo pipefail
umask 077

# Preserve the complete profile tree before a Chromium major-version switch.
# A downgrade restores that snapshot, while retaining all post-switch data.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CB="${CLOAK_BROWSER_ROOT:-$HOME/.cloakbrowser}"
ACCOUNTS="${CLOAK_ACCOUNT_BASE:-$HOME/Library/Application Support/NoTrace Browser/Accounts}"
mode="${1:-activate}"
candidate="${2:-chromix}"
BACKUP_ROOT_INPUT="${CLOAK_BACKUP_ROOT:-}"
ARCHIVE_ROOT_INPUT="${CLOAK_BACKUP_ARCHIVE_ROOT:-}"
stage=""
cleanup() { if [[ -n "$stage" && -d "$stage" ]]; then /bin/rm -rf "$stage"; fi; }
trap cleanup EXIT
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || die '账号快照切换仅支持 macOS'
[[ -d "$ACCOUNTS" && ! -L "$ACCOUNTS" ]] || die '账号根目录无效或为符号链接'
[[ -d "$CB" && ! -L "$CB" && -L "$CB/current" ]] || die '内核根目录或 current 指针无效'
CB="$(cd "$CB" && pwd -P)"
ACCOUNTS="$(cd "$ACCOUNTS" && pwd -P)"

resolve_backup_root() {
  local raw parent
  if [[ -n "$BACKUP_ROOT_INPUT" ]]; then
    raw="$BACKUP_ROOT_INPUT"
  else
    raw="$CB/backups"
  fi
  [[ "$raw" == /* ]] || die 'CLOAK_BACKUP_ROOT 必须是绝对路径'
  [[ ! -L "$raw" ]] || die '备份根目录不能是符号链接'
  if [[ -e "$raw" ]]; then
    [[ -d "$raw" ]] || die '备份根目录不是目录'
  else
    [[ "$mode" == backup || "$mode" == activate ]] || die '恢复所需的备份根目录不存在'
    parent="$(dirname "$raw")"
    mkdir -p "$parent"
    mkdir "$raw"
  fi
  BACKUP_ROOT="$(cd "$raw" && pwd -P)"
  [[ "$BACKUP_ROOT" != "$ACCOUNTS" && "$BACKUP_ROOT" != "$ACCOUNTS"/* ]] \
    || die '备份根目录不能位于账号工作区内'
}

assert_idle() {
  # Examine commands only in memory; never log account names or credentials.
  ps axww -o command= | awk -v root="$CB/" -v accounts="$ACCOUNTS" '
    index($0, root) && index($0, "/Chromium.app/Contents/MacOS/Chromium") { busy = 1 }
    index($0, "--user-data-dir=" accounts) { busy = 1 }
    END { exit(busy ? 1 : 0) }
  ' || die '浏览器正在运行；未修改账号或 current，请关闭后重试'
  if pgrep -x cloak-picker >/dev/null 2>&1; then
    die '请先退出 Cloak Picker；未修改账号或 current'
  fi
}
compare_snapshot() {
  local changes
  changes="$(/usr/bin/rsync -acni --delete "$1/" "$2/")" || die '账号快照校验执行失败'
  [[ -z "$changes" ]] || die '账号快照内容不一致；停止切换并保留现有数据'
}
archive_snapshot_if_configured() {
  local archive_root="$ARCHIVE_ROOT_INPUT"
  if [[ -z "$archive_root" && "$CB" == "$HOME/.cloakbrowser" ]]; then archive_root="$HOME/Library/Mobile Documents/com~apple~CloudDocs/电脑文件/隐私浏览器自编译源码"; fi
  [[ -z "$archive_root" ]] || CLOAK_BACKUP_ARCHIVE_ROOT="$archive_root" bash "$ROOT/packaging/archive-independent-snapshot.sh" "$1"
}
resolve_backup_root
assert_idle
current_dir="$(cd "$CB/current" && pwd -P)"
current_version="${current_dir##*/chromium-}"
[[ "$current_dir" == "$CB"/chromium-* ]] || die 'current 不在受管内核目录内'

case "$mode" in
  backup|activate)
    if [[ "$mode" == activate ]]; then
      if [[ "$candidate" == native ]]; then
        target_version='152.0.7977.82-native-notrace'
      elif [[ "$candidate" == chromix ]]; then
        target_version='152.0.7977.82-notrace'
      else
        die '候选类型仅支持 chromix 或 native'
      fi
      node "$ROOT/packaging/verify-independent-runtime.mjs" "$CB/chromium-$target_version"
      if [[ "$current_version" == "$target_version" ]]; then
        printf '%s\n' '独立内核已启用；不重复切换或创建快照'
        exit 0
      fi
      freshness="$("$ROOT/packaging/check-picker-fresh.sh" --print)"
      source_hash="$(printf '%s\n' "$freshness" | awk '$1 == "source" {print $2}')"
      installed_hash="$(printf '%s\n' "$freshness" | awk '$1 == "stamp" {print $2}')"
      [[ -n "$source_hash" && "$source_hash" == "$installed_hash" && "$freshness" == *'app     present'* ]] \
        || die '请先安装当前源码构建的 Cloak Picker'
    fi
    [[ -f "$CB/current.sha256" && ! -L "$CB/current.sha256" ]] || die 'current.sha256 无效'
    [[ ! -L "$BACKUP_ROOT" ]] || die '备份根目录不能是符号链接'
    chmod 700 "$BACKUP_ROOT"
    snapshot="$(mktemp -d "$BACKUP_ROOT/independent-engine-$(date '+%Y%m%d-%H%M%S').XXXXXX")"
    /bin/mv "$snapshot" "${snapshot}.noindex"
    snapshot="${snapshot}.noindex"
    printf '%s\n' '正在创建完整账号快照并逐文件校验；不修改原账号'
    /bin/cp -cRp "$ACCOUNTS" "$snapshot/Accounts"
    compare_snapshot "$ACCOUNTS" "$snapshot/Accounts"
    account_hash="$(node "$ROOT/packaging/hash-profile-snapshot.mjs" "$snapshot/Accounts")"
    /bin/cp -p "$CB/current.sha256" "$snapshot/current.sha256"
    node - "$snapshot" "$ACCOUNTS" "$current_version" "$account_hash" <<'JS'
const fs=require('node:fs'), path=require('node:path');
fs.writeFileSync(path.join(process.argv[2], 'snapshot.json'), JSON.stringify({schema:1,account_base:process.argv[3],previous_version:process.argv[4],accounts_sha256:process.argv[5]},null,2)+'\n',{mode:0o600});
JS
    assert_idle
    archive_snapshot_if_configured "$snapshot"
    if [[ "$mode" == activate ]]; then
      CLOAKBROWSER_DIR="$CB" bash "$ROOT/packaging/rollback-chromium.sh" "$target_version"
    fi
    printf '账号快照：%s\n' "$snapshot"
    ;;
  restore)
    [[ $# == 2 && -d "$2" && ! -L "$2" ]] || die '用法：switch-independent-engine.sh restore <账号快照目录>'
    snapshot="$(cd "$2" && pwd -P)"
    [[ "$snapshot" == "$BACKUP_ROOT"/independent-engine-*.noindex ]] || die '快照不在配置的独立内核备份目录内'
    previous="$(node - "$snapshot/snapshot.json" "$ACCOUNTS" <<'JS'
const fs=require('node:fs');
const file=process.argv[2],stat=fs.lstatSync(file);
if(!stat.isFile()||stat.size>4096)throw Error('Invalid snapshot metadata');
const data=JSON.parse(fs.readFileSync(file,'utf8'));
if(data.schema!==1||data.account_base!==process.argv[3]||!/^\d+(\.\d+){3,4}(-pro)?(-native)?(-notrace)?$/.test(data.previous_version)||! /^[a-f0-9]{64}$/.test(data.accounts_sha256))throw Error('Snapshot belongs to another workspace or has no integrity digest');
console.log(data.previous_version);
JS
)"
    [[ -d "$snapshot/Accounts" && ! -L "$snapshot/Accounts" ]] || die '快照账号目录无效'
    expected_hash="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).accounts_sha256)' "$snapshot/snapshot.json")"
    [[ "$(node "$ROOT/packaging/hash-profile-snapshot.mjs" "$snapshot/Accounts")" == "$expected_hash" ]] || die '账号快照完整性验证失败；未修改当前数据'
    # Verify the old runtime before moving any account data.
    CLOAKBROWSER_DIR="$CB" bash "$ROOT/packaging/rollback-chromium.sh" --dry-run "$previous"
    parent="$(dirname "$ACCOUNTS")"
    stage="$(mktemp -d "$parent/.notrace-engine-restore.XXXXXX")"
    /bin/cp -cRp "$snapshot/Accounts" "$stage/Accounts"
    compare_snapshot "$snapshot/Accounts" "$stage/Accounts"
    preserved="$parent/Accounts.after-independent-$(date '+%Y%m%d-%H%M%S').$$.noindex"
    [[ ! -e "$preserved" ]] || die '恢复保存目录已存在'
    assert_idle
    /bin/mv "$ACCOUNTS" "$preserved"
    if ! /bin/mv "$stage/Accounts" "$ACCOUNTS"; then
      /bin/mv "$preserved" "$ACCOUNTS"
      die '账号恢复失败；已恢复切换前的当前账号目录'
    fi
    if ! CLOAKBROWSER_DIR="$CB" bash "$ROOT/packaging/rollback-chromium.sh" "$previous"; then
      /bin/mv "$ACCOUNTS" "$stage/Accounts"
      /bin/mv "$preserved" "$ACCOUNTS"
      CLOAKBROWSER_DIR="$CB" bash "$ROOT/packaging/rollback-chromium.sh" "$current_version"
      die '内核回滚失败；已恢复独立内核与当前账号数据'
    fi
    printf '旧内核与账号快照已恢复；切换后数据另存于：%s\n' "$preserved"
    ;;
  *) die '用法：switch-independent-engine.sh [activate [chromix|native]|backup|restore <快照目录>' ;;
esac
