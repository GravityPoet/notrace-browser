#!/bin/bash
set -euo pipefail

[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Requires Linux root' >&2; exit 1; }
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
helper=/usr/local/libexec/notrace-cpa-acl.py
state=/var/lib/notrace-cpa-acl
auths=/opt/cliproxyapi/auths

# Source files are versioned. New helper/units need no duplicate binary backup;
# the helper saves at most two ACL-only snapshots before changing permissions.
python3 - "$script_dir" <<'PY'
import ast, sys
from pathlib import Path
ast.parse((Path(sys.argv[1]) / 'cpa-broker-acl.py').read_text())
for path in (Path('/usr/local/libexec'), Path('/var/lib/notrace-cpa-acl')):
    for parent in (path, *path.parents):
        if not parent.exists():
            continue
        info = parent.lstat()
        if parent.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('Privileged helper or snapshot directory has an unsafe ancestor')
PY
test -d "$auths"
test ! -L "$auths"
getent passwd notrace-broker >/dev/null
systemd-analyze verify "$script_dir/notrace-cpa-acl.service" "$script_dir/notrace-cpa-acl.path"
install -d -o root -g root -m 755 /usr/local/libexec
install -d -o root -g root -m 700 "$state"
for destination in "$helper" /etc/systemd/system/notrace-cpa-acl.service /etc/systemd/system/notrace-cpa-acl.path; do
  test ! -L "$destination"
  case "$destination" in
    "$helper") source_file="$script_dir/cpa-broker-acl.py" ;;
    *) source_file="$script_dir/$(basename "$destination")" ;;
  esac
  if [[ -e "$destination" ]]; then
    if ! cmp -s "$source_file" "$destination"; then
      echo "Changed installation requires a reviewed update: $destination" >&2
      exit 1
    fi
  fi
done
[[ -e "$helper" ]] || install -o root -g root -m 755 "$script_dir/cpa-broker-acl.py" "$helper"
[[ -e /etc/systemd/system/notrace-cpa-acl.service ]] || install -o root -g root -m 644 "$script_dir/notrace-cpa-acl.service" /etc/systemd/system/notrace-cpa-acl.service
[[ -e /etc/systemd/system/notrace-cpa-acl.path ]] || install -o root -g root -m 644 "$script_dir/notrace-cpa-acl.path" /etc/systemd/system/notrace-cpa-acl.path
python3 "$helper"
systemctl daemon-reload
if ! systemctl start notrace-cpa-acl.service; then
  if [[ -s "$state/acl.json" ]]; then python3 "$helper" --rollback --repair; fi
  exit 1
fi
systemctl enable --now notrace-cpa-acl.path
systemctl is-active --quiet notrace-cpa-acl.path
python3 "$helper"
systemctl show notrace-cpa-acl.service -p ExecMainStatus -p Result
echo 'CPA Broker ACL compatibility installed; credential contents were not read.'
