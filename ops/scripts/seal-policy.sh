#!/usr/bin/env bash
# Seals a policy: validated, copied root-owned and read-only into a root-owned directory,
# and its SHA-256 recorded in YOUR Keychain. Run it as yourself (it asks sudo for the copy):
#   ops/scripts/seal-policy.sh config/policy.example.yaml
set -euo pipefail

SRC="${1:?usage: seal-policy.sh <policy.yaml>}"
DEST_DIR="/Library/Application Support/Jarvis"
DEST="$DEST_DIR/policy.yaml"
REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
JARVIS="$REPO/apps/jarvisd/bin/jarvis"

if [ "$(id -u)" -eq 0 ]; then
  echo "✖ run this as your own user, not with sudo: the hash goes to your Keychain" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "✖ no such file: $SRC" >&2; exit 1; }

"$JARVIS" policy check "$SRC"
# A root-owned file in a user-owned folder could still be renamed away: the folder is root's too.
sudo install -d -o root -g wheel -m 755 "$DEST_DIR"
sudo install -o root -g wheel -m 444 "$SRC" "$DEST"
"$JARVIS" policy record-hash
"$JARVIS" policy verify
echo "✔ sealed: $DEST — restart jarvisd to load it"
