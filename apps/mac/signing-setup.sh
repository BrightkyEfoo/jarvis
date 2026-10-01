#!/usr/bin/env bash
# One-time: a stable local code-signing identity for Jarvis.app, so macOS keeps the Microphone and
# Speech permissions across rebuilds (an ad-hoc signature changes at every build).
# Run it as yourself. macOS asks for your password once, to trust the certificate for code signing.
set -euo pipefail

DIR="$HOME/Library/Application Support/Jarvis/signing"
KC="$DIR/jarvis-signing.keychain-db"
mkdir -p "$DIR" && chmod 700 "$DIR"
if [ -f "$KC" ] && [ -f "$DIR/identity.sha1" ]; then
  echo "✔ identité déjà configurée ($(cat "$DIR/identity.sha1"))"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PW="$(openssl rand -hex 24)"          # dedicated keychain password (not your login password)
P12PW="$(openssl rand -hex 16)"
umask 077
printf %s "$PW" > "$DIR/.kc"

cat > "$TMP/ext.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Jarvis Local Signing (Brightky)
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 3650 -nodes -config "$TMP/ext.cnf" 2>/dev/null
# OpenSSL 3 needs -legacy for a PKCS#12 that macOS `security` can import; LibreSSL does not know the flag.
LEGACY="-legacy"; openssl version | grep -q LibreSSL && LEGACY=""
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout "pass:$P12PW" -name "Jarvis Local Signing"

security create-keychain -p "$PW" "$KC"
security set-keychain-settings "$KC"                 # no auto-lock
security unlock-keychain -p "$PW" "$KC"
security import "$TMP/id.p12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
echo "macOS va demander ton mot de passe pour faire confiance à ce certificat (signature de code uniquement)…"
security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$TMP/cert.pem"
openssl x509 -in "$TMP/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d : > "$DIR/identity.sha1"
echo "✔ identité de signature locale créée. Recompile : jarvis voice build (les autorisations seront demandées une dernière fois)."
