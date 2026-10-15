#!/bin/bash
set -euo pipefail

# Keep the real SSH host in the private environment, not in this public repository.
: "${NOTRACE_VPS_HOST:?Set NOTRACE_VPS_HOST to your SSH host}"

exec /usr/bin/ssh \
  -NT \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 18555:127.0.0.1:18455 \
  "$NOTRACE_VPS_HOST"
