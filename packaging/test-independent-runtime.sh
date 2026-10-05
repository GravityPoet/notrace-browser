#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${1:-$HOME/.cloakbrowser/chromium-152.0.7977.82-notrace}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-runtime-marker-test.XXXXXX")"
trap '/bin/rm -rf "$tmp"' EXIT
[[ -d "$RUNTIME/Chromium.app" ]] || { echo '需要已安装的独立指纹内核'; exit 1; }
ln -s "$RUNTIME/Chromium.app" "$tmp/Chromium.app"
cp "$RUNTIME/.notrace-independent-engine.json" "$tmp/.notrace-independent-engine.json"
printf '%s\n' 'NoTrace independent local runtime' > "$tmp/.notrace-local-runtime"
if node "$ROOT/packaging/verify-independent-runtime.mjs" "$tmp" >"$tmp/rejected.log" 2>&1; then
  echo '不符合核心契约的 TCC 标记不应通过'
  exit 1
fi
printf '%s\n' 'NoTrace local runtime v1; independent Chromix runtime' > "$tmp/.notrace-local-runtime"
node "$ROOT/packaging/verify-independent-runtime.mjs" "$tmp"
printf '%s\n' '独立内核标记与核心 TCC 契约一致性验收通过'
