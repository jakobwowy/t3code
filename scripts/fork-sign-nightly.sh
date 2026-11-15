#!/bin/bash
# Fork only (branch wowy): signs a self-built nightly with a stable identity.
# Usage: scripts/fork-sign-nightly.sh [path/to/App.app]   (default: /Applications/T3 Code (Nightly).app)
#
# Why: the DMG build is ad-hoc signed. macOS ties privacy grants (screen recording, camera,
# accessibility) of ad-hoc apps to the exact build hash, so every grant breaks on the next
# build and the system keeps asking although the switch in System Settings is on. Signed
# with a real certificate, the designated requirement names the certificate and the bundle
# ID instead, and grants survive rebuilds.
#
# Identity: env T3CODE_FORK_SIGN_IDENTITY, else the first valid "Apple Development" identity.
# No hardened runtime: the ad-hoc build has none either, so behaviour stays the same.
# The app must not be running while it is signed.
set -euo pipefail

APP="${1:-/Applications/T3 Code (Nightly).app}"
[[ -d "$APP" ]] || { echo "App nicht gefunden: $APP" >&2; exit 1; }

IDENTITY="${T3CODE_FORK_SIGN_IDENTITY:-$(security find-identity -v -p codesigning \
  | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "Apple Development: .*"$/\1/p' | head -1)}"
[[ -n "$IDENTITY" ]] || {
  echo "Keine Signier-Identität gefunden (security find-identity -v -p codesigning)." >&2
  echo "Eine angeben mit T3CODE_FORK_SIGN_IDENTITY=<SHA-1 oder Name>." >&2
  exit 1
}

if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
  echo "Die App läuft. Erst beenden (Cmd+Q), dann neu signieren." >&2
  exit 1
fi

sign() {
  codesign --force --timestamp=none --sign "$IDENTITY" "$@" 2> >(grep -v 'replacing existing signature' >&2)
}

# Inside-out: loose Mach-O files first (native addons, helper binaries), then nested
# bundles from the deepest level up, then the app. A parent seal covers its children,
# so a child signed after its parent would break the parent's signature.
echo "Signiere $(basename "$APP") mit $IDENTITY"
count=0
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    sign "$file"
    count=$((count + 1))
  fi
done < <(find "$APP/Contents" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) \
  -not -path '*/_CodeSignature/*' -print0)
echo "    $count Einzeldateien"

find "$APP/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0 \
  | while IFS= read -r -d '' bundle; do sign "$bundle"; done

sign "$APP"
codesign --verify --deep --strict "$APP"
echo "    Prüfung ok. Kennung für Datenschutz-Freigaben:"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /    /p'
