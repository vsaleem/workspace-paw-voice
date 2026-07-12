#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(WORKSPACE, "dist");
const VERSION = process.env.PAW_VOICE_VERSION || "v1";
const ARCHIVE = path.join(DIST_DIR, `paw-voice-${VERSION}.tar.gz`);

const SOURCE_FILES = [
  ".gitignore",
  "README.md",
  "assets/gng-paw-voice-logo.svg",
  "tools/PAW_PUSH_TO_TALK_SHORTCUTS.md",
  "tools/build-paw-push-to-talk-app.mjs",
  "tools/install-paw-hotkey-listener.mjs",
  "tools/install-paw-push-to-talk-trigger.mjs",
  "tools/install-paw-voice.mjs",
  "tools/package-paw-voice-release.mjs",
  "tools/paw-listen.mjs",
  "tools/paw-main-handoff-worker.mjs",
  "tools/paw-push-to-talk-app.swift",
  "tools/paw-push-to-talk-dictation.command",
  "tools/paw-push-to-talk-hotkey.swift",
  "tools/paw-push-to-talk-normal.command",
  "tools/paw-push-to-talk-quick.command",
  "tools/paw-push-to-talk.applescript",
  "tools/paw-push-to-talk.command",
  "tools/paw-push-to-talk.mjs",
  "tools/paw-stt-go/README.md",
  "tools/paw-stt-go/go.mod",
  "tools/paw-stt-go/main.go",
  "tools/paw-voice-doctor.mjs",
  "tools/paw-voice-install-key.sh",
  "tools/paw-voice.mjs"
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: WORKSPACE, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${command} failed\n`);
    process.exit(result.status || 1);
  }
  return result;
}

const missing = SOURCE_FILES.filter((file) => !fs.existsSync(path.join(WORKSPACE, file)));
if (missing.length > 0) {
  console.error(`Cannot package release; missing files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
  process.exit(1);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
run("tar", ["-czf", ARCHIVE, ...SOURCE_FILES]);

console.log(JSON.stringify({
  ok: true,
  archive: ARCHIVE,
  files: SOURCE_FILES.length
}, null, 2));
