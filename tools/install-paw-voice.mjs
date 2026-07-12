#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const BUILD_APP = path.join(WORKSPACE, "tools", "build-paw-push-to-talk-app.mjs");
const HOTKEY_INSTALLER = path.join(WORKSPACE, "tools", "install-paw-hotkey-listener.mjs");
const DOCTOR = path.join(WORKSPACE, "tools", "paw-voice-doctor.mjs");
const NODE = process.execPath;

const args = process.argv.slice(2);

function usage() {
  console.log(`Paw Voice V1 installer

Usage:
  node tools/install-paw-voice.mjs [--speech-mode elevenlabs|macos] [--target voice|fresh|main|SESSION_KEY] [--mode quick|normal|dictation] [--skip-doctor]

Defaults:
  --speech-mode elevenlabs
  --target voice
  --mode normal
`);
}

function parseOptions() {
  const options = {
    speechMode: "elevenlabs",
    target: "voice",
    mode: "normal",
    skipDoctor: false
  };

  function readValue(flag, index) {
    const value = args[index + 1] || "";
    if (!value || value.startsWith("--")) {
      console.error(`Missing value for ${flag}.`);
      process.exit(2);
    }
    return value;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--speech-mode") {
      options.speechMode = readValue(arg, i).toLowerCase();
      i += 1;
    } else if (arg === "--target") {
      options.target = readValue(arg, i);
      i += 1;
    } else if (arg === "--mode") {
      options.mode = readValue(arg, i);
      i += 1;
    } else if (arg === "--skip-doctor") {
      options.skipDoctor = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  if (!["elevenlabs", "macos"].includes(options.speechMode)) {
    console.error("Use --speech-mode elevenlabs or --speech-mode macos.");
    process.exit(2);
  }
  if (!["quick", "normal", "dictation"].includes(options.mode)) {
    console.error("Use --mode quick, normal, or dictation.");
    process.exit(2);
  }
  return options;
}

function commandExists(bin) {
  return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: WORKSPACE,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: WORKSPACE,
      PAW_NODE_BIN: NODE,
      OPENCLAW_BIN: process.env.OPENCLAW_BIN || "openclaw"
    },
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function checkPrereqs(options) {
  const issues = [];
  if (process.platform !== "darwin") {
    issues.push("Paw Voice V1 installer currently supports macOS only.");
  }
  if (Number(process.versions.node.split(".")[0]) < 20) {
    issues.push(`Node.js 20+ is required. Current version: ${process.version}`);
  }
  for (const bin of ["openclaw", "ffmpeg", "osascript", "afplay", "swiftc", "plutil", "codesign", "launchctl"]) {
    if (!commandExists(bin)) issues.push(`Missing command: ${bin}`);
  }
  if (options.speechMode === "elevenlabs" && !process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY_FILE && !fs.existsSync(path.join(process.env.HOME || "", ".openclaw", "secrets", "elevenlabs-api-key"))) {
    issues.push("ElevenLabs speech selected, but no ElevenLabs key was found. Set ELEVENLABS_API_KEY, ELEVENLABS_API_KEY_FILE, or use --speech-mode macos.");
  }
  if (!fs.existsSync(BUILD_APP)) issues.push(`Missing ${BUILD_APP}`);
  if (!fs.existsSync(HOTKEY_INSTALLER)) issues.push(`Missing ${HOTKEY_INSTALLER}`);
  if (!fs.existsSync(DOCTOR)) issues.push(`Missing ${DOCTOR}`);

  if (issues.length > 0) {
    console.error("Paw Voice install cannot continue:");
    for (const issue of issues) console.error(`- ${issue}`);
    console.error("\nOpenClaw setup: https://docs.openclaw.ai/start/getting-started");
    process.exit(1);
  }
}

const options = parseOptions();
checkPrereqs(options);

console.log("Building Paw Voice native macOS recorder...");
run(NODE, [BUILD_APP]);

console.log("Installing Paw Voice Control+Space listener...");
run(NODE, [
  HOTKEY_INSTALLER,
  "install",
  "--mode", options.mode,
  "--target", options.target,
  "--speech-mode", options.speechMode
]);

if (!options.skipDoctor) {
  console.log("Running Paw Voice doctor...");
  run(NODE, [DOCTOR, "status"]);
}

console.log("Paw Voice V1 is installed. Press Control+Space to talk.");
