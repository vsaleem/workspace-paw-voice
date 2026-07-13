#!/usr/bin/env bash
set -euo pipefail

KEY_FILE="${ELEVENLABS_API_KEY_FILE:-$HOME/.openclaw/secrets/elevenlabs-api-key}"
KEY_DIR="$(dirname "$KEY_FILE")"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

printf "Paste ElevenLabs API key for Paw Voice (input hidden): " >&2
stty -echo
IFS= read -r API_KEY
stty echo
printf "\n" >&2

if [ -z "$API_KEY" ]; then
  echo "No key provided; leaving existing key unchanged." >&2
  exit 2
fi

umask 077
printf "%s" "$API_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

echo "Saved ElevenLabs API key to $KEY_FILE"
echo "Validating with sag voices..."
sag voices --api-key-file "$KEY_FILE" --limit 3 >/dev/null
echo "ElevenLabs key validation passed."
