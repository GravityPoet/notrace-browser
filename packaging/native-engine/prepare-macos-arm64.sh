#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$ROOT/.build/native-engine/upstream/chromix"
WORK="$ROOT/.build/native-engine/work"
MAC="$WORK/tooling/ungoogled-chromium-macos"
CHROMIX_COMMIT=f1e41d82ca3fb9e83cedc06e22ff5f3073e8c542
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || exit 1
export PATCH_BIN="$(command -v gpatch)"
command -v go >/dev/null
"$PATCH_BIN" --version
# No existing checkout is reset or deleted. Only the owned shallow source
# workspace is created; real browser/profile/current paths are out of scope.
if [[ ! -d "$REPO" ]]; then
  git init "$REPO"
  git -C "$REPO" remote add origin https://github.com/xiaozhou26/Chromix.git
  git -C "$REPO" fetch --depth=1 origin "$CHROMIX_COMMIT"
  git -C "$REPO" checkout --detach "$CHROMIX_COMMIT"
fi
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$CHROMIX_COMMIT" ]] || exit 1
OVERLAY="$ROOT/packaging/native-engine/patches/0001-macos152-test-context.patch"
if git -C "$REPO" apply --reverse --check "$OVERLAY" 2>/dev/null; then
  printf '%s\n' 'macOS 152 测试上下文修正已存在。'
else
  git -C "$REPO" apply --check "$OVERLAY"
  git -C "$REPO" apply "$OVERLAY"
fi
bash "$REPO/build/prepare-ungoogled.sh" "$WORK" macos arm64
# The pinned macOS recipe originally omitted a Rust checksum. Independently
# verify the official release digest before allowing the baseline build.
RUST_ARCHIVE="$WORK/download_cache/rust-nightly-2026-06-16-aarch64-apple-darwin.tar.xz"
[[ "$(shasum -a 256 "$RUST_ARCHIVE" | awk '{print $1}')" == \
  8b5933fa6319cc2b4a83098562731eff4c16cb982be44282aef51c17a43fe7e6 ]] || exit 1
OVERLAY="$ROOT/packaging/native-engine/patches/0002-rust-resource-integrity.patch"
if git -C "$MAC" apply --reverse --check "$OVERLAY" 2>/dev/null; then
  printf '%s\n' 'Rust 资源完整性修正已存在。'
else
  git -C "$MAC" apply --check "$OVERLAY"
  git -C "$MAC" apply "$OVERLAY"
fi
OVERLAY="$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch"
if "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$OVERLAY" >/dev/null 2>&1; then
  printf '%s\n' 'macOS SDK 绑定工具链接器修正已存在。'
else
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward --dry-run -i "$OVERLAY"
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward -i "$OVERLAY"
fi
LINKER_PATCH="$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch"
if "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$LINKER_PATCH" >/dev/null 2>&1; then
  printf '%s\n' 'V8 快照生成器 compact-unwind 修正已存在。'
else
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward --dry-run -i "$LINKER_PATCH"
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward -i "$LINKER_PATCH"
fi
FRAMEWORK_PATCH="$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
if "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$FRAMEWORK_PATCH" >/dev/null 2>&1; then
  printf '%s\n' 'Chromium Framework compact-unwind 修正已存在。'
else
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward --dry-run -i "$FRAMEWORK_PATCH"
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward -i "$FRAMEWORK_PATCH"
fi
WARNING_PATCH="$ROOT/packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch"
if "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$WARNING_PATCH" >/dev/null 2>&1; then
  printf '%s\n' '原生渲染警告清理已存在。'
else
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward --dry-run -i "$WARNING_PATCH"
  "$PATCH_BIN" -d "$WORK/src" -p1 --fuzz=0 --batch --forward -i "$WARNING_PATCH"
fi
REPORT="$WORK/source-prepared-$(date +%s)-$$.json"
if [[ -f "$WORK/src/.notrace-custom-native-fingerprint" ]]; then
  if [[ "${NOTRACE_FULL_SOURCE_VERIFY:-0}" == "1" ]]; then
    python3 "$ROOT/packaging/native-engine/verify-source.py" --repaired --output "$REPORT"
  else
    python3 "$ROOT/packaging/native-engine/verify-local-patches.py" --repaired \
      --src "$WORK/src" --output "$REPORT" \
      --patch "$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0007-stable-native-rendering.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
  fi
else
  if [[ "${NOTRACE_FULL_SOURCE_VERIFY:-0}" == "1" ]]; then
    python3 "$ROOT/packaging/native-engine/verify-source.py" --output "$REPORT"
  else
    python3 "$ROOT/packaging/native-engine/verify-local-patches.py" \
      --src "$WORK/src" --output "$REPORT" \
      --patch "$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
  fi
fi
printf '公开源码基线已验证：%s；尚未编译或安装。\n' "$WORK/src"
