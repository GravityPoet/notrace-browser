#!/bin/bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_INPUT="${1:-}"
ARCHIVE_ROOT="${CLOAK_BACKUP_ARCHIVE_ROOT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/电脑文件/隐私浏览器自编译源码}"
HASHER="$ROOT/packaging/hash-profile-snapshot.mjs"
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || die '快照归档仅支持 macOS'
[[ -n "$SNAPSHOT_INPUT" && -d "$SNAPSHOT_INPUT" && ! -L "$SNAPSHOT_INPUT" ]] || die '快照目录无效'
[[ -f "$HASHER" && ! -L "$HASHER" ]] || die '快照摘要工具缺失'
[[ "$ARCHIVE_ROOT" == /* && ! -L "$ARCHIVE_ROOT" && -d "$ARCHIVE_ROOT" && -w "$ARCHIVE_ROOT" ]] \
  || die '归档根目录不可用或不可写；未生成本地孤立归档'
SNAPSHOT="$(cd "$SNAPSHOT_INPUT" && pwd -P)"; NAME="$(basename "$SNAPSHOT")"
[[ "$NAME" == independent-engine-*.noindex && -d "$SNAPSHOT/Accounts" && ! -L "$SNAPSHOT/Accounts" ]] || die '快照不在受管范围内'
[[ -f "$SNAPSHOT/snapshot.json" && ! -L "$SNAPSHOT/snapshot.json" && -f "$SNAPSHOT/current.sha256" && ! -L "$SNAPSHOT/current.sha256" ]] || die '快照元数据路径无效'
expected="$(node -e 'const fs=require("fs"),p=process.argv[1];if(fs.statSync(p).size>4096)process.exit(1);const d=JSON.parse(fs.readFileSync(p,"utf8"));if(d.schema!==1||! /^\d+(\.\d+){3,4}(-pro)?(-native)?(-notrace)?$/.test(d.previous_version)||! /^[0-9a-f]{64}$/.test(d.accounts_sha256))process.exit(1);process.stdout.write(d.accounts_sha256)' "$SNAPSHOT/snapshot.json")" || die '快照元数据无效'
actual="$(node "$HASHER" "$SNAPSHOT/Accounts")"; [[ "$actual" == "$expected" ]] || die '快照摘要不匹配'
ARCHIVE_ROOT="$(cd "$ARCHIVE_ROOT" && pwd -P)"
[[ "$ARCHIVE_ROOT" != "$SNAPSHOT" && "$ARCHIVE_ROOT" != "$SNAPSHOT"/* ]] || die '归档目录不能位于快照内'
timestamp="$(date '+%Y%m%d-%H%M%S')"
ARCHIVE="$ARCHIVE_ROOT/账号快照-$timestamp-$NAME.tar.gz"; [[ ! -e "$ARCHIVE" && ! -L "$ARCHIVE" ]] || die '归档已存在'
tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-archive-verify.XXXXXX")"; partial="$tmp/archive.tar.gz"
cleanup() { rm -rf "$tmp"; }; trap cleanup EXIT
COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs --no-acls --format=pax -czf "$partial" -C "$(dirname "$SNAPSHOT")" "$NAME"
/usr/bin/gzip -t "$partial"; /usr/bin/tar -tzf "$partial" > "$tmp/members"
node - "$tmp/members" "$NAME" <<'JS'
const fs=require('fs'),[file,root]=process.argv.slice(2);for(const n of fs.readFileSync(file,'utf8').trimEnd().split('\n')){const p=n.replace(/\/$/,'').split('/');if(n.startsWith('/')||p[0]!==root||p.some(x=>x===''||x==='..'))process.exit(1)}
JS
mkdir "$tmp/extracted"; COPYFILE_DISABLE=1 /usr/bin/tar -xzpf "$partial" -C "$tmp/extracted"
[[ "$(node "$HASHER" "$tmp/extracted/$NAME/Accounts")" == "$expected" ]] || die '归档解压摘要不匹配'
cmp -s "$SNAPSHOT/snapshot.json" "$tmp/extracted/$NAME/snapshot.json" || die '元数据不一致'
cmp -s "$SNAPSHOT/current.sha256" "$tmp/extracted/$NAME/current.sha256" || die 'current.sha256不一致'
sha="$(shasum -a 256 "$partial" | awk '{print $1}')"
cp -p "$partial" "$ARCHIVE"
[[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" == "$sha" ]] || die '云盘本地副本摘要不一致；原快照保留'
printf '%s  %s\n' "$sha" "$(basename "$ARCHIVE")" > "$ARCHIVE.sha256"; chmod 600 "$ARCHIVE" "$ARCHIVE.sha256"
printf 'archive=%s\nsha256=%s\nupload=pending\nlocal_snapshot=retained\n' "$ARCHIVE" "$sha"
