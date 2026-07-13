#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
WORKSPACE="${OPENCLAW_WORKSPACE:-${SCRIPT_DIR:h}}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw)}"

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [[ -z "$OPENCLAW_BIN" ]]; then
  print "Missing openclaw. Install OpenClaw or set OPENCLAW_BIN."
  exit 127
fi

cd "$WORKSPACE"

if [[ "${1:-}" == "--restart" ]]; then
  "$OPENCLAW_BIN" mcp reload
  "$OPENCLAW_BIN" gateway restart
else
  "$OPENCLAW_BIN" mcp reload >/dev/null 2>&1 || true
fi

exec "$OPENCLAW_BIN" terminal --session main --history-limit 200
