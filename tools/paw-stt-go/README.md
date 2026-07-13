# Paw STT Go Probe

Small saved-audio transcription probe for comparing hosted STT providers against the same WAV files captured by `paw-listen.mjs diagnose`.

## Keys

Preferred key files:

- Deepgram: `~/.openclaw/secrets/deepgram-api-key`
- OpenAI: `~/.openclaw/secrets/openai-api-key`

Equivalent environment variables also work:

- `DEEPGRAM_API_KEY` or `DEEPGRAM_API_KEY_FILE`
- `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`

## Commands

Build and validate:

```bash
cd tools/paw-stt-go
go test ./...
```

Transcribe a saved diagnosis WAV with Deepgram:

```bash
go run . \
  --provider deepgram \
  --file ../../.openclaw/paw-listen/last.wav
```

Transcribe with OpenAI:

```bash
go run . \
  --provider openai \
  --file ../../.openclaw/paw-listen/last.wav
```

Use a specific saved diagnostic file:

```bash
go run . \
  --provider deepgram \
  --file ../../.openclaw/paw-listen/paw-listen-2026-06-30T18-27-27-556Z-95341.wav
```

## Current Purpose

Phase 1 is file-based only: prove whether hosted STT can correctly transcribe the same WAV clips that local Whisper currently mishandles. If Deepgram or OpenAI transcribes the saved clips correctly, use that provider as the push-to-talk STT backend. If hosted STT also fails, focus on the capture source/device path before changing the assistant pipeline.
