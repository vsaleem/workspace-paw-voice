#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const SOURCE = path.join(WORKSPACE, "tools", "paw-push-to-talk-hotkey.swift");
const NATIVE_APP = path.join(WORKSPACE, "tools", "Paw Push To Talk Native.app");
const BIN_DIR = path.join(WORKSPACE, ".openclaw", "bin");
const BINARY = path.join(BIN_DIR, "paw-push-to-talk-hotkey");
const LABEL = process.env.PAW_HOTKEY_LABEL || "dev.openclaw.paw.push-to-talk.hotkey";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = "/tmp/paw-push-to-talk-hotkey.log";
const ERR = "/tmp/paw-push-to-talk-hotkey.err";
const VALID_MODES = new Set(["quick", "normal", "dictation"]);
const VALID_SPEECH_MODES = new Set(["elevenlabs", "macos"]);
const DEFAULT_MODE = process.env.PAW_PUSH_TO_TALK_MODE || "normal";
const DEFAULT_TARGET = process.env.PAW_PUSH_TO_TALK_TARGET || "voice";
const DEFAULT_SPEECH_MODE = process.env.PAW_PUSH_TO_TALK_SPEECH_MODE || "elevenlabs";

const args = process.argv.slice(2);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${command} failed\n`);
    process.exit(result.status || 1);
  }
  return result;
}

function which(bin) {
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readValue(flag, index) {
  const value = args[index + 1] || "";
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${flag}.`);
    process.exit(2);
  }
  return value;
}

function parseOptions() {
  const options = {
    mode: DEFAULT_MODE,
    target: DEFAULT_TARGET,
    speechMode: DEFAULT_SPEECH_MODE
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mode") {
      options.mode = readValue(arg, i);
      i += 1;
    } else if (arg === "--target") {
      options.target = readValue(arg, i);
      i += 1;
    } else if (arg === "--speech-mode") {
      options.speechMode = readValue(arg, i).toLowerCase();
      i += 1;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  if (!VALID_MODES.has(options.mode)) {
    console.error(`Unknown mode: ${options.mode}. Use quick, normal, or dictation.`);
    process.exit(2);
  }
  if (!VALID_SPEECH_MODES.has(options.speechMode)) {
    console.error(`Unknown speech mode: ${options.speechMode}. Use elevenlabs or macos.`);
    process.exit(2);
  }
  return options;
}

function plist(options) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BINARY}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAW_PUSH_TO_TALK_MODE</key>
    <string>${options.mode}</string>
    <key>PAW_PUSH_TO_TALK_TARGET</key>
    <string>${options.target}</string>
    <key>PAW_PUSH_TO_TALK_SPEECH_MODE</key>
    <string>${options.speechMode}</string>
    <key>OPENCLAW_WORKSPACE</key>
    <string>${WORKSPACE}</string>
    <key>OPENCLAW_BIN</key>
    <string>${process.env.OPENCLAW_BIN || which("openclaw") || "openclaw"}</string>
    <key>PAW_NODE_BIN</key>
    <string>${process.execPath}</string>
    <key>PAW_NATIVE_APP</key>
    <string>${NATIVE_APP}</string>
    <key>PATH</key>
    <string>${process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `launchctl ${args.join(" ")} failed\n`);
    process.exit(result.status || 1);
  }
  return result;
}

function install() {
  const options = parseOptions();
  if (!fs.existsSync(SOURCE)) {
    console.error(`Missing source: ${SOURCE}`);
    process.exit(2);
  }
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  run("swiftc", [SOURCE, "-o", BINARY]);
  fs.chmodSync(BINARY, 0o755);

  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist(options));
  run("plutil", ["-lint", PLIST]);

  launchctl(["bootout", `gui/${process.getuid()}`, PLIST], true);
  launchctl(["bootstrap", `gui/${process.getuid()}`, PLIST]);
  launchctl(["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], true);

  status();
}

function uninstall() {
  launchctl(["bootout", `gui/${process.getuid()}`, PLIST], true);
  if (fs.existsSync(PLIST)) fs.rmSync(PLIST, { force: true });
  status(false);
}

function status(expectInstalled = true) {
  const print = launchctl(["print", `gui/${process.getuid()}/${LABEL}`], true);
  const running = print.status === 0 && /state = running|pid = [0-9]+/.test(print.stdout);
  const mode = plistValue("PAW_PUSH_TO_TALK_MODE");
  const target = plistValue("PAW_PUSH_TO_TALK_TARGET");
  const speechMode = plistValue("PAW_PUSH_TO_TALK_SPEECH_MODE");
  const result = {
    ok: expectInstalled ? fs.existsSync(BINARY) && fs.existsSync(PLIST) && running : !fs.existsSync(PLIST),
    label: LABEL,
    source: SOURCE,
    binary: BINARY,
    plist: PLIST,
    log: LOG,
    error_log: ERR,
    running,
    installed: fs.existsSync(PLIST),
    binary_exists: fs.existsSync(BINARY),
    native_app_exists: fs.existsSync(NATIVE_APP),
    configured_mode: mode || null,
    configured_target: target || null,
    configured_speech_mode: speechMode || null
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function plistValue(key) {
  if (!fs.existsSync(PLIST)) return "";
  const result = spawnSync("plutil", ["-extract", `EnvironmentVariables.${key}`, "raw", PLIST], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const command = args[0] || "install";
if (command === "install") install();
else if (command === "status") status();
else if (command === "uninstall") uninstall();
else {
  console.error("Usage: node tools/install-paw-hotkey-listener.mjs [install [--mode quick|normal|dictation] [--target voice|fresh|main|SESSION_KEY] [--speech-mode elevenlabs|macos]|status|uninstall]");
  process.exit(2);
}
