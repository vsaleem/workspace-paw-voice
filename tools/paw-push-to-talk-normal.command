#!/bin/zsh

export PAW_PUSH_TO_TALK_MODE=normal
export PAW_PUSH_TO_TALK_TARGET="${PAW_PUSH_TO_TALK_TARGET:-voice}"
SCRIPT_DIR="${0:A:h}"
exec "$SCRIPT_DIR/paw-push-to-talk.command" "$@"
