#!/bin/bash
set -euo pipefail

exec /usr/bin/ssh \
  -NT \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 18555:127.0.0.1:18455 \
  gravity-vps
