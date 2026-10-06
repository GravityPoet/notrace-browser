#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CB="${CLOAK_BROWSER_ROOT:-$HOME/.cloakbrowser}"
VERSION=145.0.7632.109.2
DEST="$CB/chromium-$VERSION-notrace"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo '本安装路径仅验收 macOS ARM64'; exit 1; }
[[ ! -L "$CB" && ! -L "$DEST" ]] || { echo '内核目录不能为符号链接'; exit 1; }
if [[ -d "$DEST" ]]; then
  node "$ROOT/packaging/verify-keyless-runtime.mjs" "$DEST"
  echo '免 Key 候选已安装；未切换 current'
  exit 0
fi
echo '备份：保留全部既有内核；只新增候选，不修改账号和 current'
node "$ROOT/packaging/audit-cloakbrowser-compatibility.mjs" --candidate "$VERSION"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-keyless-install.XXXXXX")"
stage="$CB/.keyless-stage.$$"
[[ ! -e "$stage" ]] || { echo '候选隔离目录已存在'; exit 1; }
cleanup() { /bin/rm -rf "$tmp"; if [[ -d "$stage" ]]; then /bin/rm -rf "$stage"; fi; }
trap cleanup EXIT INT TERM
mkdir -p "$CB" "$stage"
# An empty private cache prevents the wrapper from discovering the user's
# saved key. The original key is neither opened nor modified.
if [[ -n "${NOTRACE_KEYLESS_SOURCE_APP:-}" ]]; then
  source_bin="$NOTRACE_KEYLESS_SOURCE_APP/Contents/MacOS/Chromium"
else
source_bin="$(env -u CLOAKBROWSER_LICENSE_KEY -u CLOAKBROWSER_LICENSE_STATUS_FILE \
  -u CLOAKBROWSER_BINARY_PATH -u CLOAKBROWSER_DOWNLOAD_URL -u CLOAKBROWSER_SKIP_CHECKSUM \
  CLOAKBROWSER_CACHE_DIR="$tmp/cache" CLOAKBROWSER_VERSION="$VERSION" CLOAKBROWSER_AUTO_UPDATE=false \
  "$ROOT/packaging/cloakbrowser-wrapper/node_modules/.bin/cloakbrowser" install \
  | awk '/\/Chromium[.]app\/Contents\/MacOS\/Chromium$/ {value=$0} END {print value}')"
fi
[[ -x "$source_bin" && ! -L "$source_bin" ]] \
  || { echo '官方下载路径或可执行文件校验失败'; exit 1; }
source_app="${source_bin%/Contents/MacOS/Chromium}"
/usr/bin/codesign --verify --deep --strict "$source_app"
source_hash="$(shasum -a 256 "$source_bin" | awk '{print $1}')"
[[ "$source_hash" == 79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79 ]] \
  || { echo '官方免 Key 内核与已验收源二进制不一致'; exit 1; }
source_framework="$source_app/Contents/Frameworks/Chromium Framework.framework/Versions/145.0.7632.109/Chromium Framework"
[[ "$(shasum -a 256 "$source_framework" | awk '{print $1}')" == 99bd238d0b3666016b5bde244829adaed372a636a8a8adbc18352d639ac438ad ]] \
  || { echo '官方免 Key Framework 来源校验失败'; exit 1; }
/usr/bin/ditto "$source_app" "$stage/Chromium.app"
printf '%s\n' 'NoTrace local runtime v1; official keyless Cloak 145; do not redistribute' > "$stage/.notrace-local-runtime"
CLOAK_BROWSER_APP="$stage/Chromium.app" bash "$ROOT/packaging/patch-chromium.sh"
node - "$stage" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2],hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const data={provider:'cloak-keyless',version:'145.0.7632.109.2',engine_version:'145.0.7632.109',
archive_sha256:'505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c',
source_binary_sha256:'79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79',
binary_sha256:hash(path.join(root,'Chromium.app/Contents/MacOS/Chromium')),
framework_sha256:hash(path.join(root,'Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/145.0.7632.109/Chromium Framework'))};
fs.writeFileSync(path.join(root,'.notrace-keyless-engine.json'),JSON.stringify(data,null,2)+'\n',{mode:0o600});
NODE
node "$ROOT/packaging/verify-keyless-runtime.mjs" "$stage"
/bin/mv "$stage" "$DEST"
echo "免 Key 本机候选已安装：${DEST}；current 与账号数据未改动"
