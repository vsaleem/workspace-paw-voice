#!/bin/zsh

SCRIPT_DIR="${0:A:h}"
WORKSPACE="${OPENCLAW_WORKSPACE:-${SCRIPT_DIR:h}}"
NODE_BIN="${PAW_NODE_BIN:-$(command -v node)}"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export OPENCLAW_WORKSPACE="$WORKSPACE"
export OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw)}"
export PAW_PUSH_TO_TALK_MODE="${PAW_PUSH_TO_TALK_MODE:-normal}"
export PAW_PUSH_TO_TALK_TARGET="${PAW_PUSH_TO_TALK_TARGET:-voice}"

if [[ -z "$NODE_BIN" ]]; then
  print "Missing node. Install Node.js or set PAW_NODE_BIN."
  exit 127
fi
if [[ -z "$OPENCLAW_BIN" ]]; then
  print "Missing openclaw. Install OpenClaw or set OPENCLAW_BIN."
  exit 127
fi

cd "$WORKSPACE" || exit 1
tmp_log=""
cleanup() {
  rc=$?
  if [[ -n "$tmp_log" && -f "$tmp_log" ]]; then
    rm -f "$tmp_log"
  fi
  print "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] paw-push-to-talk.command exit $rc"
}
trap cleanup EXIT

{
  print "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] paw-push-to-talk.command start mode=$PAW_PUSH_TO_TALK_MODE target=$PAW_PUSH_TO_TALK_TARGET"
  tmp_log="$(mktemp -t paw-push-to-talk-output.XXXXXX)"
  "$NODE_BIN" "$WORKSPACE/tools/paw-push-to-talk.mjs" --mode "$PAW_PUSH_TO_TALK_MODE" --target "$PAW_PUSH_TO_TALK_TARGET" "$@" >"$tmp_log" 2>&1
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    sed -E 's/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/[redacted-email]/g' "$tmp_log" | head -n 40
  fi
  exit $rc
}
