#!/bin/bash
set -euo pipefail

ssh_pid=""
pause_pid=""
active_host=""

# A running SSH process is not proof that the Broker is reachable. Supervise
# only our own child and test the complete forwarding path, without credentials.
tunnel_ssh() {
  exec /usr/bin/ssh -NT \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o ConnectionAttempts=1 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -L 127.0.0.1:18555:127.0.0.1:18455 "$1"
}

tunnel_healthy() {
  local body ok version
  body="$(/usr/bin/curl --silent --show-error --fail --noproxy '*' \
    --connect-timeout 2 --max-time 3 --max-filesize 4096 "$1" 2>/dev/null)" || return 1
  ok="$(printf '%s' "$body" | /usr/bin/plutil -extract ok raw -o - - 2>/dev/null)" || return 1
  version="$(printf '%s' "$body" | /usr/bin/plutil -extract api_version raw -o - - 2>/dev/null)" || return 1
  [[ "$ok" == true && "$version" == 1 ]]
}

tunnel_owns_child() {
  [[ -n "$1" && "$(/bin/ps -p "$1" -o ppid= 2>/dev/null | /usr/bin/tr -d ' ')" == "$$" ]]
}

tunnel_stop_child() {
  local child="$1" attempt
  if tunnel_owns_child "$child"; then
    kill -TERM "$child" 2>/dev/null || true
    for attempt in 1 2 3 4 5; do
      tunnel_owns_child "$child" || break
      /bin/sleep 1
    done
    if tunnel_owns_child "$child"; then kill -KILL "$child" 2>/dev/null || true; fi
  fi
  wait "$child" 2>/dev/null || true
}

tunnel_pause() {
  /bin/sleep "$1" &
  pause_pid=$!
  wait "$pause_pid" || true
  pause_pid=""
}

tunnel_log() {
  printf '%s %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S%z')" "$1" >&2
}

tunnel_cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$pause_pid" ]]; then tunnel_stop_child "$pause_pid"; fi
  if [[ -n "$ssh_pid" ]]; then tunnel_stop_child "$ssh_pid"; fi
}

tunnel_main() {
  local hosts_value host host_index=0 host_count start_index failures backoff=5 connected
  hosts_value="${NOTRACE_VPS_HOSTS:-${NOTRACE_VPS_HOST:-}}"
  : "${hosts_value:?Set NOTRACE_VPS_HOSTS to your SSH hosts}"
  local -a hosts=()
  IFS=',' read -r -a hosts <<< "$hosts_value"
  host_count="${#hosts[@]}"
  if [[ "$host_count" -eq 0 ]]; then
    printf '%s\n' 'SSH 主机列表为空' >&2
    return 1
  fi
  for host in "${hosts[@]}"; do
    case "$host" in
      ''|-*|*[!a-zA-Z0-9_.@:-]*) printf '%s\n' 'SSH 主机格式无效' >&2; return 1 ;;
    esac
  done
  trap 'exit 0' INT TERM
  trap tunnel_cleanup EXIT
  while true; do
    # Never start another SSH listener over an already working local service.
    if tunnel_healthy http://127.0.0.1:18555/healthz; then
      tunnel_pause 15
      continue
    fi
    start_index="$host_index"
    while true; do
      active_host="${hosts[$host_index]}"
      tunnel_log "续期隧道正在连接（${active_host}）"
      tunnel_ssh "$active_host" &
      ssh_pid=$!
      failures=0
      connected=0
      while tunnel_owns_child "$ssh_pid"; do
        tunnel_pause 15
        tunnel_owns_child "$ssh_pid" || break
        if tunnel_healthy http://127.0.0.1:18555/healthz; then
          failures=0
          backoff=5
          start_index="$host_index"
          if [[ "$connected" == 0 ]]; then tunnel_log '续期隧道已连接，健康检查通过'; fi
          connected=1
        else
          failures=$((failures + 1))
          if [[ "$failures" -ge 3 ]]; then
            tunnel_log '续期隧道连续 3 次健康检查失败，正在重建连接'
            break
          fi
        fi
      done
      tunnel_stop_child "$ssh_pid"
      ssh_pid=""
      host_index=$(( (host_index + 1) % host_count ))
      if [[ "$connected" == 1 ]]; then
        tunnel_log "续期隧道入口（${active_host}）已断开，切换备用入口"
      else
        tunnel_log "续期隧道入口（${active_host}）连接失败，切换备用入口"
      fi
      active_host=""
      if [[ "$host_index" != "$start_index" ]]; then
        continue
      fi
      tunnel_log "所有 SSH 入口均不可用，将在 ${backoff} 秒后重连"
      tunnel_pause "$backoff"
      backoff=$((backoff * 2))
      if [[ "$backoff" -gt 60 ]]; then backoff=60; fi
      break
    done
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then tunnel_main; fi
