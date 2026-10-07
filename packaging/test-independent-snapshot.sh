#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/notrace-snapshot-test.XXXXXX")"
trap '/bin/rm -rf "$tmp"' EXIT
CB="$tmp/browser"
accounts="$tmp/Accounts"
backup_root="$tmp/iCloud/隐私浏览器自编译源码/账号快照"
app="$CB/chromium-151.0.0.0/Chromium.app"
mkdir -p "$app/Contents/MacOS" "$accounts/synthetic-account"
printf '#!/bin/sh\nprintf "Chromium 151.0.0.0\\n"\n' > "$app/Contents/MacOS/Chromium"
chmod 700 "$app/Contents/MacOS/Chromium"
/usr/bin/plutil -create xml1 "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string Chromium' "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string org.chromium.Chromium' "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$app/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$app" >/dev/null
ln -s "$CB/chromium-151.0.0.0" "$CB/current"
shasum -a 256 "$app/Contents/MacOS/Chromium" > "$CB/current.sha256"
printf '%s\n' 'original-synthetic-storage' > "$accounts/synthetic-account/storage.txt"
ln -s 'nonexistent-cookie' "$accounts/synthetic-account/SingletonCookie"
legacy_output="$(CLOAK_BROWSER_ROOT="$CB" CLOAK_ACCOUNT_BASE="$accounts" bash "$ROOT/packaging/switch-independent-engine.sh" backup)"
legacy_snapshot="${legacy_output##*账号快照：}"
[[ "$legacy_snapshot" == "$CB/backups"/independent-engine-*.noindex ]]
output="$(CLOAK_BROWSER_ROOT="$CB" CLOAK_ACCOUNT_BASE="$accounts" CLOAK_BACKUP_ROOT="$backup_root" bash "$ROOT/packaging/switch-independent-engine.sh" backup)"
snapshot="${output##*账号快照：}"
[[ -f "$snapshot/snapshot.json" ]]
[[ "$snapshot" == "$backup_root"/independent-engine-*.noindex ]]
printf '%s\n' 'post-switch-synthetic-storage' > "$accounts/synthetic-account/storage.txt"
cp "$snapshot/Accounts/synthetic-account/storage.txt" "$tmp/original.txt"
printf '%s\n' 'corrupted-backup' > "$snapshot/Accounts/synthetic-account/storage.txt"
if CLOAK_BROWSER_ROOT="$CB" CLOAK_ACCOUNT_BASE="$accounts" CLOAK_BACKUP_ROOT="$backup_root" bash "$ROOT/packaging/switch-independent-engine.sh" restore "$snapshot"; then
  printf '%s\n' '损坏快照不应允许恢复' >&2
  exit 1
fi
[[ "$(< "$accounts/synthetic-account/storage.txt")" == post-switch-synthetic-storage ]]
cp -p "$tmp/original.txt" "$snapshot/Accounts/synthetic-account/storage.txt"
CLOAK_BROWSER_ROOT="$CB" CLOAK_ACCOUNT_BASE="$accounts" CLOAK_BACKUP_ROOT="$backup_root" bash "$ROOT/packaging/switch-independent-engine.sh" restore "$snapshot"
[[ "$(< "$accounts/synthetic-account/storage.txt")" == original-synthetic-storage ]]
[[ -L "$accounts/synthetic-account/SingletonCookie" ]]
for preserved in "$tmp"/Accounts.after-independent-*.noindex; do
  [[ "$(< "$preserved/synthetic-account/storage.txt")" == post-switch-synthetic-storage ]]
done
printf '%s\n' '账号快照恢复、符号链接和切换后数据保留验收通过'
