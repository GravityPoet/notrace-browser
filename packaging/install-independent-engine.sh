#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CB="${CLOAK_BROWSER_ROOT:-$HOME/.cloakbrowser}"
DEST="$CB/chromium-152.0.7977.82-notrace"
EXPECTED="8ceefefced9018dfe917650ce156bd1ffdaa9bc2bc6b89b70b6d021262166eb4"
URL="https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.82/chromix-mac-arm64.zip"
[[ "$(uname -m)" == "arm64" ]] || { echo '独立内核仅验收了 macOS ARM64'; exit 1; }
[[ ! -L "$CB" && ! -L "$DEST" ]] || { echo '独立内核目录不能是符号链接'; exit 1; }

if [[ -d "$DEST" ]]; then
  node "$ROOT/packaging/verify-independent-runtime.mjs" "$DEST"
  echo '独立内核已安装；未修改当前指针'
  exit 0
fi
echo '备份：保留现有内核；本步骤只安装独立候选，不切换账号'
tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-independent-install.XXXXXX")"
stage="$CB/.independent-stage.$$"
[[ ! -e "$stage" && ! -L "$stage" ]] || { echo '隔离安装目录已存在；停止以免覆盖'; exit 1; }
cleanup() { /bin/rm -rf "$tmp"; if [[ -d "$stage" ]]; then /bin/rm -rf "$stage"; fi; }
trap cleanup EXIT INT TERM
mkdir -p "$CB" "$stage"
if [[ -n "${NOTRACE_ENGINE_ARCHIVE:-}" ]]; then
  cp "$NOTRACE_ENGINE_ARCHIVE" "$tmp/browser.zip"
else
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 240 --silent --show-error --output "$tmp/browser.zip" "$URL"
fi
[[ "$(shasum -a 256 "$tmp/browser.zip" | awk '{print $1}')" == "$EXPECTED" ]] || { echo '内核下载哈希不匹配'; exit 1; }
python3 - "$tmp/browser.zip" <<'PY'
import sys
from pathlib import PurePosixPath
from zipfile import ZipFile
with ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if sum(entry.file_size for entry in entries) > 2 * 1024**3:
        raise SystemExit('内核压缩包展开体积超过验收范围')
    for entry in entries:
        path = PurePosixPath(entry.filename)
        if path.is_absolute() or '..' in path.parts or not entry.filename.startswith('chromix/'):
            raise SystemExit('内核压缩包包含非法路径')
PY
/usr/bin/ditto -x -k "$tmp/browser.zip" "$tmp/extracted.noindex"
/usr/bin/ditto "$tmp/extracted.noindex/chromix/Chromium.app" "$stage/Chromium.app"
cp "$tmp/extracted.noindex/chromix/LICENSE.chromium" "$stage/LICENSE.chromium"
cp "$tmp/extracted.noindex/chromix/LICENSE.chromix" "$stage/LICENSE.chromix"
printf '%s\n' 'NoTrace independent local runtime' > "$stage/.notrace-local-runtime"
CLOAK_BROWSER_APP="$stage/Chromium.app" bash "$ROOT/packaging/patch-chromium.sh"
node - "$stage" <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2],version='152.0.7977.82';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const metadata={provider:'chromix',version,archive_sha256:'8ceefefced9018dfe917650ce156bd1ffdaa9bc2bc6b89b70b6d021262166eb4',source_commit:'ca52ae0d01168a8bc118ccc28d484011a7eb0efb',binary_sha256:hash(path.join(root,'Chromium.app/Contents/MacOS/Chromium')),framework_sha256:hash(path.join(root,`Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/${version}/Chromium Framework`))};
fs.writeFileSync(path.join(root,'.notrace-independent-engine.json'),JSON.stringify(metadata,null,2)+'\n',{mode:0o600});
JS
node "$ROOT/packaging/verify-independent-runtime.mjs" "$stage"
/bin/mv "$stage" "$DEST"
echo "独立候选已安装：${DEST}；当前指针尚未切换"
