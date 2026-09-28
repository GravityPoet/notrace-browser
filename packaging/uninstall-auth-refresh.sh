#!/bin/bash
set -euo pipefail

LABEL="com.notrace-browser.auth-refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
uid="$(id -u)"

launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
printf 'removed launchd authority check: %s\n' "$LABEL"
