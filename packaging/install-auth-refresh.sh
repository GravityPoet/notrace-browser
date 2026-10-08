#!/bin/bash
set -euo pipefail

# Install the daily NoTrace OAuth authority check. The CLI only rotates grants
# owned by NoTrace and only inside the access-token lead window; Cockpit, CPA,
# and official Codex grants are recorded as external authorities and skipped.

APP="${CLOAK_PICKER_INSTALL_APP:-/Applications/Cloak Picker.app}"
CLI="$APP/Contents/MacOS/cloak"
LAUNCHER="$APP/Contents/Resources/授权续期后台任务.sh"
LABEL="com.notrace-browser.auth-refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/NoTrace Browser/auth-refresh.log"
BACKUP_ARCHIVE_ROOT="${CLOAK_BACKUP_ARCHIVE_ROOT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/电脑文件/隐私浏览器自编译源码}"

[[ -x "$CLI" && -x "$LAUNCHER" ]] || {
  printf 'error: bundled auth refresh launcher or CLI not found: %s\n' "$APP" >&2
  printf '%s\n' 'Run packaging/install-cloak-picker-app.sh first.' >&2
  exit 1
}

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
umask 077
tmp="$PLIST.tmp.$$"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LAUNCHER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>86400</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$tmp" >/dev/null
if [[ -f "$PLIST" ]] && ! cmp -s "$PLIST" "$tmp"; then
  [[ "$BACKUP_ARCHIVE_ROOT" == /* && ! -L "$BACKUP_ARCHIVE_ROOT" && -d "$BACKUP_ARCHIVE_ROOT" && -w "$BACKUP_ARCHIVE_ROOT" ]] || {
    printf 'error: iCloud backup root is unavailable or not writable; live plist unchanged\n' >&2
    exit 1
  }
  backup="$BACKUP_ARCHIVE_ROOT/启动配置-$(date '+%Y%m%d-%H%M%S')-$LABEL.plist"
  [[ ! -e "$backup" && ! -L "$backup" ]] || { printf 'error: backup target already exists; live plist unchanged\n' >&2; exit 1; }
  if ! cp -p "$PLIST" "$backup"; then
    rm -f -- "$backup"
    printf 'error: unable to write the single iCloud backup root: %s\n' "$BACKUP_ARCHIVE_ROOT" >&2
    exit 1
  fi
  chmod 600 "$backup"
  cmp -s "$PLIST" "$backup" || { printf 'error: launchd backup mismatch; live plist unchanged\n' >&2; exit 1; }
  printf 'backup  : %s\n' "$backup"
fi
mv -f "$tmp" "$PLIST"
chmod 600 "$PLIST"

uid="$(id -u)"
launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
if launchctl bootstrap "gui/$uid" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null; then
  printf 'installed launchd authority check: %s\n' "$LABEL"
else
  printf 'error: failed to load %s\n' "$PLIST" >&2
  exit 1
fi

printf 'schedule: at login and every 24 hours; refresh only when due\n'
printf 'plist   : %s\n' "$PLIST"
printf 'log     : %s\n' "$LOG"
