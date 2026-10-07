#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-archive-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
snapshot="$tmp/backups/independent-engine-2099-0101.Q.noindex"; archive_root="$tmp/cloud"
mkdir -p "$snapshot/Accounts/demo" "$archive_root" "$tmp/browser"; printf 'synthetic\n' > "$snapshot/Accounts/demo/storage.txt"; printf 'sha\n' > "$snapshot/current.sha256"
chmod 644 "$snapshot/Accounts/demo/storage.txt"
ln -s missing-cookie "$snapshot/Accounts/demo/SingletonCookie"
digest="$(node "$ROOT/packaging/hash-profile-snapshot.mjs" "$snapshot/Accounts")"; printf '{"schema":1,"account_base":"%s","previous_version":"151.0.0.0","accounts_sha256":"%s"}\n' "$tmp/Accounts" "$digest" > "$snapshot/snapshot.json"
out="$(CLOAK_BACKUP_ARCHIVE_ROOT="$archive_root" bash "$ROOT/packaging/archive-independent-snapshot.sh" "$snapshot")"; archive="$(printf '%s\n' "$out" | sed -n 's/^archive=//p')"; [[ -f "$archive" && -f "$archive.sha256" ]]
restore_output="$(CLOAK_BROWSER_ROOT="$tmp/browser" bash "$ROOT/packaging/restore-independent-snapshot-archive.sh" "$archive")"
restored="$(printf '%s\n' "$restore_output" | sed -n 's/^CLOAK_BACKUP_ROOT=//p')"
[[ -d "$restored/$(basename "$snapshot")/Accounts" && ! -L "$restored/$(basename "$snapshot")" ]]
[[ -L "$restored/$(basename "$snapshot")/Accounts/demo/SingletonCookie" ]]
cp "$archive.sha256" "$tmp/valid.sha256"
printf '%064d  %s\n' 0 "$(basename "$archive")" > "$archive.sha256"
if CLOAK_BROWSER_ROOT="$tmp/browser" bash "$ROOT/packaging/restore-independent-snapshot-archive.sh" "$archive" >/dev/null 2>&1; then exit 1; fi
cp "$tmp/valid.sha256" "$archive.sha256"
missing_root="$tmp/missing-cloud"; if CLOAK_BACKUP_ARCHIVE_ROOT="$missing_root" bash "$ROOT/packaging/archive-independent-snapshot.sh" "$snapshot" >/dev/null 2>&1; then exit 1; fi; [[ ! -e "$missing_root" ]]
printf 'changed\n' > "$snapshot/Accounts/demo/storage.txt"; if CLOAK_BACKUP_ARCHIVE_ROOT="$archive_root" bash "$ROOT/packaging/archive-independent-snapshot.sh" "$snapshot" >/dev/null 2>&1; then exit 1; fi
printf '%s\n' 'archive-independent-snapshot=passed'
