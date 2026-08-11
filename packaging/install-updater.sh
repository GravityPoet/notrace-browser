#!/bin/bash
set -euo pipefail

# Install (or refresh) the launchd timer that asks the pinned official wrapper
# for a signed candidate each day. Candidates remain isolated until NoTrace's
# local and explicitly requested headed gates approve promotion. Idempotent.
#
# Uninstall:
#   launchctl bootout gui/$(id -u)/com.notrace-browser.update 2>/dev/null || \
#     launchctl unload ~/Library/LaunchAgents/com.notrace-browser.update.plist
#   rm ~/Library/LaunchAgents/com.notrace-browser.update.plist

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cloak/
LABEL="com.notrace-browser.update"
UPDATER="$ROOT/packaging/update-chromium.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.cloakbrowser/update.log"
BACKUP_DIR="$HOME/.cloakbrowser/backups/launchagents"

[[ -f "$UPDATER" ]] || { printf 'error: updater not found: %s\n' "$UPDATER" >&2; exit 1; }
chmod +x "$UPDATER"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.cloakbrowser"

plist_tmp="$PLIST.tmp.$$"
cleanup() { rm -f "$plist_tmp"; }
trap cleanup EXIT
umask 077
cat > "$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$UPDATER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>NOTRACE_UPDATE_LAUNCHD</key><string>1</string></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$plist_tmp" >/dev/null
if [[ -f "$PLIST" ]] && ! cmp -s "$PLIST" "$plist_tmp"; then
  mkdir -p "$BACKUP_DIR"
  backup="$BACKUP_DIR/$LABEL.$(date '+%Y%m%d-%H%M%S').plist"
  cp -p "$PLIST" "$backup"
  chmod 600 "$backup"
  printf 'backup  : %s\n' "$backup"
fi
mv -f "$plist_tmp" "$PLIST"
chmod 600 "$PLIST"

# Reload: modern bootout/bootstrap, fall back to legacy unload/load.
uid="$(id -u)"
launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
if launchctl bootstrap "gui/$uid" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null; then
  printf 'installed launchd timer: %s\n' "$LABEL"
else
  printf 'error: failed to load %s\n' "$PLIST" >&2; exit 1
fi

printf 'plist   : %s\n' "$PLIST"
printf 'schedule: daily 18:00 (signed candidate staging; deferred while a browser is open)\n'
printf 'log     : %s\n' "$LOG"
printf 'check now: DRY_RUN=1 %s\n' "$UPDATER"
