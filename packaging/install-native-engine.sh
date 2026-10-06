#!/bin/bash
set -euo pipefail
umask 077

# Promote a completed public-source Chromium build into the managed runtime
# root without changing current, profiles, license files, or account data.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CB="${CLOAK_BROWSER_ROOT:-$HOME/.cloakbrowser}"
SOURCE_APP="${NOTRACE_NATIVE_SOURCE_APP:-$ROOT/.build/native-engine/work/src/out/Default/Chromium.app}"
VERSION="152.0.7977.82"
DEST="$CB/chromium-$VERSION-native-notrace"
STAGE="$CB/.native-stage.$$"
SOURCE_ROOT="$ROOT/.build/native-engine/work/src"
CHROMIX_ROOT="$ROOT/.build/native-engine/upstream/chromix"

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo '本安装路径仅验收 macOS ARM64' >&2; exit 1; }
[[ -d "$SOURCE_APP" && -x "$SOURCE_APP/Contents/MacOS/Chromium" ]] || { echo "自编译 Chromium.app 不存在：$SOURCE_APP" >&2; exit 1; }
[[ ! -L "$CB" && ! -L "$DEST" && ! -e "$STAGE" && ! -L "$STAGE" ]] || { echo '内核根目录或候选目录无效' >&2; exit 1; }
if [[ -d "$DEST" ]]; then
  node "$ROOT/packaging/verify-independent-runtime.mjs" "$DEST"
  echo '自编译原生候选已安装；current 未切换'
  exit 0
fi

source_bin="$SOURCE_APP/Contents/MacOS/Chromium"
version_output="$($source_bin --version 2>/dev/null)"
[[ "$version_output" == *"Chromium $VERSION"* ]] || { echo "候选版本不匹配：$version_output" >&2; exit 1; }
[[ "$(file -b "$source_bin")" == *arm64* ]] || { echo '候选不是 ARM64 Mach-O' >&2; exit 1; }
[[ -d "$SOURCE_ROOT" && -f "$ROOT/packaging/native-engine/source-lock.json" ]] || { echo '源码锁定文件缺失' >&2; exit 1; }
[[ -d "$CHROMIX_ROOT/.git" ]] || { echo 'Chromix 来源仓库缺失，不能生成来源标记' >&2; exit 1; }

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT INT TERM
mkdir -p "$CB" "$STAGE"
ditto "$SOURCE_APP" "$STAGE/Chromium.app"
printf '%s\n' 'NoTrace local runtime v1; public-source native Chromium; do not redistribute' > "$STAGE/.notrace-local-runtime"
CLOAK_BROWSER_APP="$STAGE/Chromium.app" bash "$ROOT/packaging/patch-chromium.sh"

source_commit="$(git -C "$CHROMIX_ROOT" rev-parse HEAD)"
source_lock_sha256="$(shasum -a 256 "$ROOT/packaging/native-engine/source-lock.json" | awk '{print $1}')"
patch_stack_sha256="$({
  for patch in \
    "$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch" \
    "$ROOT/packaging/native-engine/patches/0007-stable-native-rendering.patch" \
    "$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch" \
    "$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch" \
    "$ROOT/packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch"; do
    shasum -a 256 "$patch"
  done
} | shasum -a 256 | awk '{print $1}')"
node - "$STAGE" "$source_commit" "$source_lock_sha256" "$patch_stack_sha256" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, sourceCommit, sourceLockSha, patchStackSha] = process.argv.slice(2);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const framework = path.join(root, 'Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/152.0.7977.82/Chromium Framework');
const metadata = {
  provider: 'notrace-native', version: '152.0.7977.82', engine_version: '152.0.7977.82',
  source_commit: sourceCommit, source_lock_sha256: sourceLockSha, patch_stack_sha256: patchStackSha,
  binary_sha256: hash(path.join(root, 'Chromium.app/Contents/MacOS/Chromium')),
  framework_sha256: hash(framework),
};
fs.writeFileSync(path.join(root, '.notrace-independent-engine.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
NODE
node "$ROOT/packaging/verify-independent-runtime.mjs" "$STAGE"
mv "$STAGE" "$DEST"
echo "自编译原生候选已安装：${DEST}；current 未切换"
