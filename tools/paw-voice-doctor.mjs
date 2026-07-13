#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const HOTKEY_LABEL = process.env.PAW_HOTKEY_LABEL || "dev.openclaw.paw.push-to-talk.hotkey";
const LEGACY_HOTKEY_LABELS = (process.env.PAW_LEGACY_HOTKEY_LABELS || "").split(",").map((label) => label.trim()).filter(Boolean);
const HOTKEY_LABELS = [HOTKEY_LABEL, ...LEGACY_HOTKEY_LABELS.filter((label) => label !== HOTKEY_LABEL)];
const HOTKEY_INSTALLER = path.join(WORKSPACE, "tools", "install-paw-hotkey-listener.mjs");
const PAW_LISTEN = path.join(WORKSPACE, "tools", "paw-listen.mjs");
const PAW_PUSH_TO_TALK = path.join(WORKSPACE, "tools", "paw-push-to-talk.mjs");
const PAW_VOICE = path.join(WORKSPACE, "tools", "paw-voice.mjs");
const COMMAND = path.join(WORKSPACE, "tools", "paw-push-to-talk.command");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const HOTKEY_LOG = "/tmp/paw-push-to-talk-hotkey.log";
const COMMAND_LOG = "/tmp/paw-push-to-talk.log";
const HOTKEY_ERR = "/tmp/paw-push-to-talk-hotkey.err";
const ELEVENLABS_KEY_FILE = process.env.ELEVENLABS_API_KEY_FILE || path.join(os.homedir(), ".openclaw", "secrets", "elevenlabs-api-key");
const E2E_PROMPT = "Single word, blueberry.";
const E2E_EXPECTED_REPLY = "blueberry";
const E2E_TIMEOUT = process.env.PAW_VOICE_DOCTOR_E2E_TIMEOUT || process.env.PAW_PUSH_TO_TALK_AGENT_TIMEOUT || "45";
const E2E_TARGET = process.env.PAW_VOICE_DOCTOR_E2E_TARGET || "voice";

const args = process.argv.slice(2);
const command = args[0] || "status";
const SELF = process.argv[1];

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", ...options });
}

function haveBin(bin) {
  return run("which", [bin]).status === 0;
}

function fileInfo(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const stat = fs.statSync(file);
  return {
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

function tail(file, lines = 20) {
  if (!fs.existsSync(file)) return "";
  const result = run("tail", ["-n", String(lines), file]);
  return result.stdout.trim();
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
}

function check(name, ok, details = {}) {
  return { name, ok: Boolean(ok), ...details };
}

function hotkeyStatus() {
  for (const label of HOTKEY_LABELS) {
    const result = run("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    const running = result.status === 0 && /state = running|pid = [0-9]+/.test(result.stdout);
    if (running || result.status === 0) {
      return {
        label,
        plist: plistForLabel(label),
        running,
        raw_ok: result.status === 0,
        mode: plistValue(label, "PAW_PUSH_TO_TALK_MODE") || null,
        target: plistValue(label, "PAW_PUSH_TO_TALK_TARGET") || null
      };
    }
  }
  return {
    label: HOTKEY_LABEL,
    plist: plistForLabel(HOTKEY_LABEL),
    running: false,
    raw_ok: false,
    mode: null,
    target: null
  };
}

function plistForLabel(label) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function plistValue(label, key) {
  const plist = plistForLabel(label);
  if (!fs.existsSync(plist)) return "";
  const result = run("plutil", ["-extract", `EnvironmentVariables.${key}`, "raw", plist]);
  return result.status === 0 ? result.stdout.trim() : "";
}

function status() {
  const hotkey = hotkeyStatus();
  const listenStatus = run("node", [PAW_LISTEN, "status"]);
  const pushStatus = run("node", [PAW_PUSH_TO_TALK, "status"]);
  const voiceStatus = run("node", [PAW_VOICE, "status"]);
  const gateway = run(OPENCLAW_BIN, ["gateway", "status"]);

  const checks = [
    check("hotkey listener running", hotkey.running, { label: hotkey.label }),
    check("push-to-talk wrapper exists", fs.existsSync(PAW_PUSH_TO_TALK), { path: PAW_PUSH_TO_TALK }),
    check("listen wrapper exists", fs.existsSync(PAW_LISTEN), { path: PAW_LISTEN }),
    check("shell launcher executable", fs.existsSync(COMMAND) && (fs.statSync(COMMAND).mode & 0o111) !== 0, { path: COMMAND }),
    check("openclaw binary exists", fs.existsSync(OPENCLAW_BIN) || haveBin(OPENCLAW_BIN), { path: OPENCLAW_BIN }),
    check("openclaw gateway reachable", gateway.status === 0),
    check("ffmpeg available", haveBin("ffmpeg")),
    check("whisper available", haveBin("whisper")),
    check("afplay available", haveBin("afplay")),
    check("osascript available", haveBin("osascript")),
    check("ElevenLabs key file exists", fs.existsSync(ELEVENLABS_KEY_FILE), { path: ELEVENLABS_KEY_FILE })
  ];

  const result = {
    ok: checks.every((item) => item.ok),
    checked_at: new Date().toISOString(),
    workspace: WORKSPACE,
    checks,
    hotkey: {
      label: hotkey.label,
      plist: hotkey.plist,
      running: hotkey.running,
      configured_mode: hotkey.mode,
      configured_target: hotkey.target
    },
    status_commands: {
      paw_listen: listenStatus.status === 0 ? JSON.parse(listenStatus.stdout) : { ok: false, error: listenStatus.stderr || listenStatus.stdout },
      paw_push_to_talk: pushStatus.status === 0 ? JSON.parse(pushStatus.stdout) : { ok: false, error: pushStatus.stderr || pushStatus.stdout },
      paw_voice: voiceStatus.status === 0 ? safeJson(voiceStatus.stdout) : { ok: false, error: voiceStatus.stderr || voiceStatus.stdout }
    },
    logs: {
      hotkey: fileInfo(HOTKEY_LOG),
      command: fileInfo(COMMAND_LOG),
      hotkey_error: fileInfo(HOTKEY_ERR)
    }
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text.trim() };
  }
}

function logs() {
  console.log(JSON.stringify({
    hotkey_log: tail(HOTKEY_LOG, 60),
    command_log: tail(COMMAND_LOG, 120),
    hotkey_error_log: tail(HOTKEY_ERR, 60)
  }, null, 2));
}

function lastRun() {
  const hotkeyLines = readLines(HOTKEY_LOG);
  const commandLines = readLines(COMMAND_LOG);
  const lastHotkey = [...hotkeyLines].reverse().find((line) => /\bhotkey pressed\b/.test(line)) || null;
  const runs = parseCommandRuns(commandLines);
  const pushStatusResult = run("node", [PAW_PUSH_TO_TALK, "status"]);
  const pushStatus = pushStatusResult.status === 0 ? safeJson(pushStatusResult.stdout) : null;
  const latestRun = annotateLatestRun(runs.at(-1) || null, pushStatus);

  console.log(JSON.stringify({
    ok: Boolean(lastHotkey || latestRun),
    hotkey_log: HOTKEY_LOG,
    command_log: COMMAND_LOG,
    last_hotkey_press: parseHotkeyPress(lastHotkey),
    last_command_run: latestRun
  }, null, 2));
  process.exit(lastHotkey || latestRun ? 0 : 1);
}

function annotateLatestRun(run, pushStatus) {
  if (!run) return null;
  if (run.ended_at) return run;
  const locked = Boolean(pushStatus?.locked);
  return {
    ...run,
    active: locked,
    stale: !locked,
    failure_hint: locked ? run.failure_hint : run.failure_hint || "No exit line and no active lock; prior run likely stopped outside the launcher."
  };
}

function parseHotkeyPress(line) {
  if (!line) return null;
  const match = line.match(/^(\S+)\s+hotkey pressed$/);
  return match ? { at: match[1] } : { raw: line };
}

function parseCommandRuns(lines) {
  const runs = [];
  let current = null;

  for (const line of lines) {
    const start = line.match(/^\[(\S+)\]\s+(paw-push-to-talk(?:\.command|-native)) start(?: mode=([^\s]+) target=([^\s]+))?/);
    if (start) {
      if (current) runs.push(finalizeRun(current));
      current = {
        started_at: start[1],
        runner: start[2],
        mode: start[3] || null,
        target: start[4] || null,
        output_lines: 0,
        failure_hint: null,
        duplicate_busy: false
      };
      continue;
    }

    const exit = line.match(/^\[(\S+)\]\s+(paw-push-to-talk(?:\.command|-native)) exit\s+(\d+)/);
    if (exit && current) {
      current.ended_at = exit[1];
      if (!current.runner) current.runner = exit[2];
      current.exit_code = Number(exit[3]);
      runs.push(finalizeRun(current));
      current = null;
      continue;
    }

    if (current && line.trim()) {
      if (/^\[\S+\]\s+paw-push-to-talk(?:\.command|-native)\s+/.test(line)) continue;
      current.output_lines += 1;
      if (/Paw is already listening or replying/i.test(line)) current.duplicate_busy = true;
      if (/failed|could not|error|TypeError|ERR_/i.test(line) && !current.failure_hint) {
        current.failure_hint = redactLogLine(line);
      }
    }
  }

  if (current) runs.push(finalizeRun(current));
  return runs;
}

function finalizeRun(run) {
  const durationMs = run.started_at && run.ended_at ? Date.parse(run.ended_at) - Date.parse(run.started_at) : null;
  const exitCode = Number.isInteger(run.exit_code) ? run.exit_code : null;
  return {
    started_at: run.started_at || null,
    ended_at: run.ended_at || null,
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    runner: run.runner || null,
    mode: run.mode,
    target: run.target,
    exit_code: exitCode,
    ok: exitCode === 0,
    duplicate_busy: run.duplicate_busy,
    non_timestamp_output_lines: run.output_lines,
    content_redacted: run.output_lines > 0,
    failure_hint: run.failure_hint
  };
}

function redactLogLine(line) {
  if (/TypeError|ERR_|failed|could not|error/i.test(line)) return line.slice(0, 240);
  return "[redacted]";
}

function cueTest() {
  const result = run("afplay", ["/System/Library/Sounds/Glass.aiff"]);
  console.log(JSON.stringify({
    ok: result.status === 0,
    cue: "Glass",
    error: result.stderr || result.stdout || null
  }, null, 2));
  process.exit(result.status || 0);
}

function dryRunModes() {
  const modes = ["quick", "normal", "dictation"];
  const target = hotkeyStatus().target || "voice";
  const results = modes.map((mode) => {
    const result = run("node", [PAW_PUSH_TO_TALK, "--mode", mode, "--target", target, "--dry-run"]);
    return {
      mode,
      ok: result.status === 0,
      dry_run: result.status === 0 ? JSON.parse(result.stdout) : null,
      error: result.status === 0 ? null : result.stderr || result.stdout
    };
  });
  console.log(JSON.stringify({
    ok: results.every((item) => item.ok),
    results
  }, null, 2));
  process.exit(results.every((item) => item.ok) ? 0 : 1);
}

function generatedAudioE2e() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-voice-e2e-"));
  const aiff = path.join(workDir, "prompt.aiff");
  const wav = path.join(workDir, "prompt.wav");

  try {
    const say = run("say", ["-o", aiff, E2E_PROMPT]);
    if (say.status !== 0) {
      printE2eResult(false, "say failed", { error: say.stderr || say.stdout });
    }

    const ffmpeg = run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", aiff,
      "-ac", "1",
      "-ar", "16000",
      wav
    ]);
    if (ffmpeg.status !== 0) {
      printE2eResult(false, "ffmpeg conversion failed", { error: ffmpeg.stderr || ffmpeg.stdout });
    }

    const request = run("node", [
      PAW_PUSH_TO_TALK,
	      "--file", wav,
	      "--target", E2E_TARGET,
	      "--no-speak",
	      "--json",
	      "--timeout", E2E_TIMEOUT
	    ]);
	    if (request.status !== 0) {
	      printE2eResult(false, "push-to-talk file request failed", { target: E2E_TARGET, timeout_seconds: E2E_TIMEOUT, error: request.stderr || request.stdout });
	    }

    const parsed = JSON.parse(request.stdout);
    const reply = String(parsed.reply || "").trim();
    const ok = normalizeReply(reply) === normalizeReply(E2E_EXPECTED_REPLY);
    printE2eResult(ok, ok ? "generated-audio e2e passed" : "unexpected agent reply", {
      expected_reply: E2E_EXPECTED_REPLY,
      reply,
	      transcript: parsed.transcript || "",
	      transcription_model: parsed.transcription_model || null,
	      transcription_duration_ms: parsed.transcription_duration_ms || null,
	      target: E2E_TARGET,
	      timeout_seconds: E2E_TIMEOUT
	    });
  } catch (error) {
    printE2eResult(false, "generated-audio e2e threw", { error: error?.message || String(error) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function printE2eResult(ok, message, details = {}) {
  console.log(JSON.stringify({
    ok,
    message,
    prompt: E2E_PROMPT,
    ...details
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

function normalizeReply(reply) {
  return String(reply || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function checkup() {
  const commands = [
    ["status"],
    ["dry-run-modes"],
    ["e2e-generated-audio"]
  ];
  const results = commands.map((commandArgs) => {
    const result = run("node", [SELF, ...commandArgs]);
    return {
      command: commandArgs.join(" "),
      ok: result.status === 0,
      output: safeJson(result.stdout),
      error: result.status === 0 ? null : result.stderr || result.stdout
    };
  });
  console.log(JSON.stringify({
    ok: results.every((item) => item.ok),
    checked_at: new Date().toISOString(),
    results
  }, null, 2));
  process.exit(results.every((item) => item.ok) ? 0 : 1);
}

function hotkeyReinstall() {
  const installArgs = ["install", ...args.slice(1)];
  const result = run("node", [HOTKEY_INSTALLER, ...installArgs], { stdio: "inherit" });
  process.exit(result.status || 0);
}

function usage() {
  console.log(`Paw Voice Doctor

Usage:
  node tools/paw-voice-doctor.mjs status
  node tools/paw-voice-doctor.mjs logs
  node tools/paw-voice-doctor.mjs last-run
  node tools/paw-voice-doctor.mjs cue-test
  node tools/paw-voice-doctor.mjs dry-run-modes
  node tools/paw-voice-doctor.mjs e2e-generated-audio
  node tools/paw-voice-doctor.mjs checkup
  node tools/paw-voice-doctor.mjs reinstall-hotkey [--mode quick|normal|dictation] [--target voice|fresh|main|SESSION_KEY]
`);
}

if (command === "status") status();
else if (command === "logs") logs();
else if (command === "last-run") lastRun();
else if (command === "cue-test") cueTest();
else if (command === "dry-run-modes") dryRunModes();
else if (command === "e2e-generated-audio") generatedAudioE2e();
else if (command === "checkup") checkup();
else if (command === "reinstall-hotkey") hotkeyReinstall();
else {
  usage();
  process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 2);
}
