#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.build/native-engine/work/src/out/Default"
PID="${1:?usage: watch-build-space.sh OWNED_NINJA_PID}"
[[ "$PID" =~ ^[1-9][0-9]*$ ]] || exit 1
START="$(ps -p "$PID" -o lstart=)"
[[ -n "$START" ]] || exit 1
lsof -a -p "$PID" "$OUT/.ninja_log" >/dev/null
printf '只监测持有本次构建日志的 Ninja PID %s；磁盘保留 8 GiB。\n' "$PID"
while [[ "$(ps -p "$PID" -o lstart= || true)" == "$START" ]]; do
  # PID reuse or loss of the owned log binding ends monitoring; never target
  # browser processes or unrelated jobs, and never delete data for space.
  lsof -a -p "$PID" "$OUT/.ninja_log" >/dev/null 2>&1 || break
  AVAILABLE_KIB="$(df -Pk "$OUT" | awk 'NR==2 {print $4}')"
  [[ "$AVAILABLE_KIB" =~ ^[0-9]+$ ]] || exit 1
  if [[ "$AVAILABLE_KIB" -lt 8388608 ]]; then
    printf '剩余磁盘低于 8 GiB；中断本次编译，保留源码与增量产物，不删除用户数据。\n' >&2
    kill -INT "$PID"
    exit 2
  fi
  sleep 20
done
printf '%s\n' '本次 Ninja 已结束；成功或失败以主构建退出码为准。'
