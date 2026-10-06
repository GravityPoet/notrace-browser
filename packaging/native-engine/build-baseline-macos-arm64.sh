#!/bin/bash
set -euo pipefail

# Build only the public-source comparison baseline. No install/current/profile
# mutation, license service, or browser launch is performed by this script.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$ROOT/.build/native-engine/upstream/chromix"
WORK="$ROOT/.build/native-engine/work"
SRC="$WORK/src"
OUT="$SRC/out/Default"
CORE="$WORK/tooling/ungoogled-chromium"
MAC="$WORK/tooling/ungoogled-chromium-macos"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || exit 1
[[ -f "$SRC/.chromix-source-ready" ]] || {
  echo '公开源码或工具链资源尚未准备完成；未开始编译。' >&2
  exit 1
}
[[ "$(git -C "$REPO" rev-parse HEAD)" == f1e41d82ca3fb9e83cedc06e22ff5f3073e8c542 ]] || exit 1
[[ "$(git -C "$CORE" rev-parse HEAD)" == e71b91c6e336d0f25cfc6b9ef09298a9d2506e24 ]] || exit 1
[[ "$(git -C "$MAC" rev-parse HEAD)" == 038db2b41f7aeb00bbceb2f5a56912b26eb5b284 ]] || exit 1
command -v ninja >/dev/null
command -v go >/dev/null
command -v gpatch >/dev/null
STATUS="$WORK/build-status-$(date +%s)-$$.txt"
# A stopped session without this final status is interrupted, not successful.
trap 'result=$?; printf "exit_code=%s\nfinished_utc=%s\n" "$result" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"' EXIT
source "$REPO/build/macos/select-xcode.sh"
select_macos_xcode
METAL_VERSION="$(xcrun metal --version 2>&1)"
[[ "$METAL_VERSION" == *'Apple metal version'* ]] || {
  printf 'Metal 组件不可用：%s\n' "$METAL_VERSION" >&2
  exit 1
}
printf '%s\n' "$METAL_VERSION"
bash "$ROOT/packaging/native-engine/prepare-macos-arm64.sh"
cd "$SRC"
ESBUILD_DIR="$SRC/third_party/devtools-frontend/src/third_party/esbuild"
if [[ ! -x "$ESBUILD_DIR/esbuild" ]]; then
  mkdir -p "$ESBUILD_DIR"
  GOPATH="$WORK/tool-cache/go" GOCACHE="$WORK/tool-cache/go-build" \
    GOBIN="$ESBUILD_DIR" GOTOOLCHAIN=local GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
    GOSUMDB=sum.golang.org GOPROXY=https://proxy.golang.org,direct \
    go install github.com/evanw/esbuild/cmd/esbuild@v0.25.1
fi
[[ "$("$ESBUILD_DIR/esbuild" --version)" == 0.25.1 ]] || exit 1
if [[ ! -f .chromix-toolchain-ready ]]; then
  [[ ! -f .chromix-domain-substituted ]] || {
    echo '域名替换后的工具链不完整，保留现场，停止编译。' >&2
    exit 1
  }
  if [[ ! -x third_party/rust-toolchain/bin/bindgen ]] || \
      ! otool -l third_party/rust-toolchain/bin/bindgen | rg -q 'LC_RPATH'; then
    BINDGEN_SRC="$SRC/third_party/rust-toolchain-intermediate/bindgen-src"
    BINDGEN_COMMIT=d874de8d646d9b8a3e7ba2db2bcd52f2fba8f1f5
    if [[ ! -d "$BINDGEN_SRC" ]]; then
      git init "$BINDGEN_SRC"
      git -C "$BINDGEN_SRC" remote add origin https://github.com/rust-lang/rust-bindgen
      git -C "$BINDGEN_SRC" fetch --depth=1 origin "$BINDGEN_COMMIT"
      git -C "$BINDGEN_SRC" checkout --detach "$BINDGEN_COMMIT"
    fi
    [[ "$(git -C "$BINDGEN_SRC" rev-parse HEAD)" == "$BINDGEN_COMMIT" ]] || exit 1
    # Skip the upstream helper's full-history/destructive checkout routine.
    python3 tools/rust/build_bindgen.py --skip-checkout --skip-test
  fi
  third_party/rust-toolchain/bin/bindgen --version
  touch .chromix-toolchain-ready
fi
[[ ! -f .chromix-domain-substitution-in-progress ]] || {
  echo '域名替换曾中断，保留现场，停止编译。' >&2
  exit 1
}
if [[ ! -f .chromix-domain-substituted ]]; then
  touch .chromix-domain-substitution-in-progress
  python3 "$CORE/utils/domain_substitution.py" apply \
    -r "$CORE/domain_regex.list" -f "$CORE/domain_substitution.list" "$SRC"
  mv .chromix-domain-substitution-in-progress .chromix-domain-substituted
fi
SOURCE_REPORT="$WORK/source-verified-$(date +%s)-$$.json"
CUSTOM_MARKER="$SRC/.notrace-custom-native-fingerprint"
CUSTOM_PATCHES=(
  "$ROOT/packaging/native-engine/patches/0007-stable-native-rendering.patch"
)
WARNING_PATCH="$ROOT/packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch"
if gpatch -d "$SRC" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$WARNING_PATCH" >/dev/null 2>&1; then
  printf '%s\n' '原生渲染警告清理已存在。'
else
  gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --dry-run -i "$WARNING_PATCH"
  gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --reject-file=- -i "$WARNING_PATCH"
fi
FRAMEWORK_PATCH="$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
if gpatch -d "$SRC" -p1 --fuzz=0 --batch --reverse --dry-run \
    -i "$FRAMEWORK_PATCH" >/dev/null 2>&1; then
  printf '%s\n' 'Chromium Framework compact-unwind 修正已存在。'
else
  gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --dry-run -i "$FRAMEWORK_PATCH"
  gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --reject-file=- -i "$FRAMEWORK_PATCH"
fi
# Live source is never reversed merely to verify it. Scratch verification
# covers the complete stack, including local repairs, on every resumed build.
REPAIRED=0
if [[ -f "$CUSTOM_MARKER" ]]; then
  [[ "${NOTRACE_NATIVE_REPAIRS:-0}" == "1" ]] || {
    echo '源码已包含原生修复；拒绝把它当作未修复基线编译。' >&2
    exit 1
  }
  REPAIRED=1
elif [[ "${NOTRACE_NATIVE_REPAIRS:-0}" == "1" ]]; then
  for patch in "${CUSTOM_PATCHES[@]}"; do
    gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --dry-run -i "$patch"
    gpatch -d "$SRC" -p1 --fuzz=0 --batch --forward --reject-file=- -i "$patch"
  done
  printf '%s\n' 'schema=1' > "$CUSTOM_MARKER"
  REPAIRED=1
fi
if [[ "$REPAIRED" == 1 ]]; then
  if [[ "${NOTRACE_FULL_SOURCE_VERIFY:-0}" == "1" ]]; then
    python3 "$ROOT/packaging/native-engine/verify-source.py" --repaired --output "$SOURCE_REPORT"
  else
    python3 "$ROOT/packaging/native-engine/verify-local-patches.py" --repaired \
      --src "$SRC" --output "$SOURCE_REPORT" \
      --patch "$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0007-stable-native-rendering.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
  fi
else
  if [[ "${NOTRACE_FULL_SOURCE_VERIFY:-0}" == "1" ]]; then
    python3 "$ROOT/packaging/native-engine/verify-source.py" --output "$SOURCE_REPORT"
  else
    python3 "$ROOT/packaging/native-engine/verify-local-patches.py" \
      --src "$SRC" --output "$SOURCE_REPORT" \
      --patch "$ROOT/packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch" \
      --patch "$ROOT/packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
  fi
fi
mkdir -p "$OUT"
python3 "$REPO/tools/merge_gn_args.py" "$OUT/args.gn" \
  "$CORE/flags.gn" "$MAC/flags.macos.gn" "$REPO/build/args.macos.gn" \
  "$ROOT/packaging/native-engine/args.dev.gn"
python3 "$REPO/tools/bootstrap_gn.py" --src "$SRC" --out "$OUT"
"$OUT/gn" gen "$OUT" --fail-on-unused-args
JOBS="${CHROMIX_JOBS:-$(sysctl -n hw.ncpu)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || exit 1
printf '开始公开源码基线编译：ARM64，%s 并发，唯一输出 %s\n' "$JOBS" "$OUT"
ninja -C "$OUT" -j "$JOBS" chrome
[[ -x "$OUT/Chromium.app/Contents/MacOS/Chromium" ]] || exit 1
printf '基线编译完成：%s。未安装；原生隐私修复与正常启动验收仍是发布门槛。\n' "$OUT/Chromium.app"
