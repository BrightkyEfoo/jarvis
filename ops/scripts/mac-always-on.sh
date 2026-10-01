#!/usr/bin/env bash
# Keeps the Mac available for Jarvis (night mode, morning briefing). Run as yourself; asks sudo.
# A MacBook's battery already rides through Douala power cuts like a UPS; these settings stop it
# from sleeping on the charger and, where the hardware supports it, restart it after a full outage.
set -euo pipefail

sudo pmset -c sleep 0 disksleep 0 displaysleep 15 womp 1 powernap 1   # on charger: never sleep
if pmset -g cap | grep -q autorestart; then
  sudo pmset -a autorestart 1                                       # restart after power loss
else
  echo "ℹ︎ autorestart non disponible sur ce Mac (portable) : la batterie prend le relais."
fi
echo "Réglages actuels (secteur) :"
pmset -g custom | sed -n '/AC Power/,$p' | grep -E "^ (sleep|disksleep|displaysleep|womp|powernap|autorestart) "
echo "Astuce : couvercle ouvert, ou écran externe branché, sinon un portable fermé se met en veille."
