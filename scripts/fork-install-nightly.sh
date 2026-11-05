#!/bin/bash
# Fork only (branch wowy): installs a self-built nightly DMG on this Mac.
# Usage: scripts/fork-install-nightly.sh [path/to/T3-Code-*.dmg]   (default: newest in release/)
# Steps: back up ~/.t3/userdata, quit the running app, keep the old app for rollback,
# copy the new app into /Applications, start it, print the installed version.
set -euo pipefail

APP_NAME="T3 Code (Nightly)"
APP="/Applications/$APP_NAME.app"
APP_PROCESS="T3 Code \\(Nightly\\)\\.app/Contents/MacOS/"
BACKUPS="$HOME/.t3/backups"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SELF="$REPO/scripts/fork-install-nightly.sh"

# Quitting the app ends every process it started. Run from a T3 thread, hand over to Terminal.
if [[ -n "${T3CODE_THREAD_ID:-}" ]]; then
  open -a Terminal "$SELF"
  echo "Installation läuft im Terminal-Fenster weiter (neueste DMG aus release/)."
  exit 0
fi

DMG="${1:-$(ls -t "$REPO"/release/T3-Code-*-arm64.dmg 2>/dev/null | head -1 || true)}"
[[ -f "$DMG" ]] || { echo "Keine DMG gefunden. Erst bauen (Runbook)." >&2; exit 1; }
NEW_VERSION="$(basename "$DMG" | sed -E 's/^T3-Code-(.*)-arm64\.dmg$/\1/')"
OLD_VERSION="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo none)"
STAMP="$(date +%Y-%m-%d)"

echo "Installiert: $OLD_VERSION"
echo "Neu:         $NEW_VERSION ($DMG)"
read -r -p "Weiter? Die App wird dafür beendet. [j/N] " answer
[[ "$answer" == [jJyY] ]] || exit 1

echo "1/5 App beenden"
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  pgrep -f "$APP_PROCESS" >/dev/null || break
  sleep 1
done
if pgrep -f "$APP_PROCESS" >/dev/null; then
  echo "Die App läuft nach 60 s noch. Bitte selbst beenden (Cmd+Q) und das Skript neu starten." >&2
  exit 1
fi

echo "2/5 Daten sichern"
BACKUP="$BACKUPS/userdata-$STAMP-vor-$NEW_VERSION"
mkdir -p "$BACKUPS"
if [[ -e "$BACKUP" ]]; then
  echo "    $BACKUP gibt es schon, wird nicht überschrieben."
else
  # The app is closed, so a plain copy is consistent. A read-only sqlite3 open would fail here:
  # a cleanly closed WAL database has no -shm file, and read-only mode cannot create one.
  cp -Rp "$HOME/.t3/userdata" "$BACKUP"
  echo "    $BACKUP ($(du -sh "$BACKUP" | cut -f1))"
fi

echo "3/5 Alte App für einen Rückweg aufheben"
if [[ -d "$APP" ]]; then
  OLD_COPY="$BACKUPS/T3-Code-Nightly-$OLD_VERSION.app"
  rm -rf "$OLD_COPY"
  mv "$APP" "$OLD_COPY"
  echo "    $OLD_COPY"
fi

echo "4/5 Neue App installieren"
MOUNT="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"
cp -R "$MOUNT/$APP_NAME.app" /Applications/
hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT"

echo "5/5 Starten"
open "$APP"
INSTALLED="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
echo
echo "Fertig: $APP_NAME $INSTALLED (vorher $OLD_VERSION)."
echo "Rückweg: App beenden, $APP löschen, die aufgehobene App aus $BACKUPS zurückschieben."
echo "Sicherungen in $BACKUPS belegen zusammen $(du -sh "$BACKUPS" | cut -f1)."
