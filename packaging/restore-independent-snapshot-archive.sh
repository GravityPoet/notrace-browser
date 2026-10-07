#!/bin/bash
set -euo pipefail
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ARCHIVE="${1:-}"
CB="${CLOAK_BROWSER_ROOT:-$HOME/.cloakbrowser}"
HASHER="$ROOT/hash-profile-snapshot.mjs"
if [[ ! -f "$HASHER" ]]; then HASHER="$ROOT/NoTrace-账号快照-20261008-校验器.mjs"; fi
LIST=""
RESTORE=""
complete=0
cleanup() {
  [[ -z "$LIST" ]] || /bin/rm -f -- "$LIST"
  if [[ "$complete" != 1 && -n "$RESTORE" ]]; then /bin/rm -rf -- "$RESTORE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
die() { printf '%s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die '需要 Node.js 校验；未解压'
[[ -f "$HASHER" && ! -L "$HASHER" ]] || die '缺少快照摘要校验器'
[[ -d "$CB" && ! -L "$CB" ]] || die '本机隔离目录根路径无效'
if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$(node - "$ROOT" <<'JS'
const fs=require('fs'),path=require('path'),root=process.argv[2];
const files=fs.readdirSync(root).map(n=>({n,m:n.match(/^(?:NoTrace-)?账号快照-([0-9]{8}(?:-[0-9]{6})?).*\.tar\.gz$/)})).filter(x=>x.m);
files.sort((a,b)=>b.m[1].localeCompare(a.m[1])||b.n.localeCompare(a.n));
if(files.length)process.stdout.write(path.join(root,files[0].n));
JS
)"
fi
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" && "$ARCHIVE" == *.tar.gz ]] || die '没有可取回的 tar.gz 账号归档'
[[ -f "$ARCHIVE.sha256" && ! -L "$ARCHIVE.sha256" ]] || die '缺少归档校验清单'
expected="$(awk 'NR==1 {print $1}' "$ARCHIVE.sha256")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die '校验清单格式无效'
[[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" == "$expected" ]] || die '归档 SHA-256 不匹配；未解压'

LIST="$(mktemp "${TMPDIR:-/tmp}/notrace-restore-members.XXXXXX")"
/usr/bin/tar -tzf "$ARCHIVE" > "$LIST"
roots="$(node - "$LIST" <<'JS'
const fs=require('fs'),roots=new Set();
for(const name of fs.readFileSync(process.argv[2],'utf8').trimEnd().split('\n')){
 const parts=name.replace(/\/$/,'').split('/');
 if(name.startsWith('/')||!/^independent-engine-[A-Za-z0-9._-]+\.noindex$/.test(parts[0])||parts.some(p=>p===''||p==='..'))throw Error('归档路径越界；未解压');
 roots.add(parts[0]);
}
if(!roots.size)process.exit(1);
process.stdout.write([...roots].sort().join('\n'));
JS
)"
RESTORE="$(mktemp -d "$CB/账号快照取回-$(date '+%Y%m%d').XXXXXX")"
COPYFILE_DISABLE=1 /usr/bin/tar -xzpf "$ARCHIVE" -C "$RESTORE"
while IFS= read -r name; do
  [[ -d "$RESTORE/$name" && ! -L "$RESTORE/$name" && -d "$RESTORE/$name/Accounts" && ! -L "$RESTORE/$name/Accounts" ]] || die '取回目录结构无效'
  [[ -f "$RESTORE/$name/snapshot.json" && ! -L "$RESTORE/$name/snapshot.json" ]] || die '快照元数据路径无效'
  expected="$(node -e 'const fs=require("fs"),p=process.argv[1];if(fs.statSync(p).size>4096)process.exit(1);const d=JSON.parse(fs.readFileSync(p,"utf8"));if(d.schema!==1||! /^[a-f0-9]{64}$/.test(d.accounts_sha256))process.exit(1);process.stdout.write(d.accounts_sha256)' "$RESTORE/$name/snapshot.json")"
  [[ "$(node "$HASHER" "$RESTORE/$name/Accounts")" == "$expected" ]] || die '取回完整摘要不匹配；现行账号未修改'
done <<< "$roots"
complete=1
printf '两份或单份归档快照均已校验，现行账号和内核未修改。\nCLOAK_BACKUP_ROOT=%s\n' "$RESTORE"
printf '%s\n' '真正回滚仍须退出浏览器和 Picker 后显式运行 switch-independent-engine.sh restore。'
