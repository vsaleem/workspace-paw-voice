# Paw Push-To-Talk Shortcuts Setup

Use macOS Shortcuts as the first hotkey layer.

## Installed Local Trigger

Paw can also install a macOS Quick Action/Service wrapper:

```bash
node tools/install-paw-push-to-talk-trigger.mjs
```

Installed workflow:

`~/Library/Services/Paw Push To Talk.workflow`

This gets Paw into macOS Keyboard Shortcuts without choosing a hotkey automatically.

Set the first trial hotkey, `Control + Space`:

```bash
node tools/install-paw-push-to-talk-trigger.mjs set-control-space
```

## Recommended Shortcut

1. Open Shortcuts.
2. Create a new shortcut named `Paw Push To Talk`.
3. Add action: `Open App`.
4. Choose:

   `tools/Paw Push To Talk.app`

5. Open the shortcut details.
6. Set a keyboard shortcut that is easy to press intentionally.

Suggested hotkey:

`Control` + `Option` + `Command` + `Space`

## Test

Run the shortcut once. You should hear a short cue, see a notification, speak within the recording window, and then hear Bella reply.

## Troubleshooting

- If nothing records, allow microphone access for the terminal/automation app macOS prompts for.
- If it says Paw is busy, wait for the current voice request to finish.
- If it fails silently, check `/tmp/paw-push-to-talk.log`.
- If Shortcuts is unreliable, move this same command into Keyboard Maestro:

  `tools/paw-push-to-talk.command`

## Notes

The local wrapper prevents duplicate overlapping runs with a lock file at:

`.openclaw/paw-listen/paw-push-to-talk.lock`

Do not bind the hotkey to a key combination that fires accidentally during typing. `Control + Space` is the first trial choice. If it conflicts with input switching, Spotlight, Raycast, or typing habits, move push-to-talk to a mouse/trackpad button with BetterTouchTool later.
