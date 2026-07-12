#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const PAW_LISTEN = path.join(WORKSPACE, "tools", "paw-listen.mjs");
const STATE_DIR = path.join(WORKSPACE, ".openclaw", "paw-listen");
const LOCK_FILE = path.join(STATE_DIR, "paw-push-to-talk.lock");
const DEFAULT_DURATION = Number(process.env.PAW_PUSH_TO_TALK_DURATION || 8);
const DEFAULT_MODEL = process.env.PAW_PUSH_TO_TALK_WHISPER_MODEL || "base";
const DEFAULT_STT_PROVIDER = process.env.PAW_PUSH_TO_TALK_STT_PROVIDER || "deepgram";
const DEFAULT_STT_MODEL = process.env.PAW_PUSH_TO_TALK_STT_MODEL || "nova-3";
const DEFAULT_DEVICE = process.env.PAW_PUSH_TO_TALK_DEVICE || ":0";
const DEFAULT_AGENT = process.env.PAW_PUSH_TO_TALK_AGENT || "main";
const DEFAULT_AGENT_THINKING = process.env.PAW_PUSH_TO_TALK_AGENT_THINKING || "minimal";
const DEFAULT_VOICE_BRIEF = process.env.PAW_PUSH_TO_TALK_VOICE_BRIEF !== "0";
const DEFAULT_VOICE_MAX_WORDS = Number(process.env.PAW_PUSH_TO_TALK_VOICE_MAX_WORDS || 6);
const DEFAULT_SPEECH_MODE = (process.env.PAW_PUSH_TO_TALK_SPEECH_MODE || "elevenlabs").toLowerCase();
const DEFAULT_FAST_REPLY = process.env.PAW_PUSH_TO_TALK_FAST_REPLY !== "0";
const DEFAULT_LEAN_COMMANDS = process.env.PAW_PUSH_TO_TALK_LEAN_COMMANDS !== "0";
const DEFAULT_INSTANT_ACK = process.env.PAW_PUSH_TO_TALK_INSTANT_ACK !== "0";
const DEFAULT_INSTANT_ACK_TEXT = process.env.PAW_PUSH_TO_TALK_INSTANT_ACK_TEXT || "On it.";
const MAIN_SESSION_KEY = process.env.PAW_PUSH_TO_TALK_MAIN_SESSION_KEY || "agent:main:main";
const VOICE_SESSION_KEY = process.env.PAW_PUSH_TO_TALK_VOICE_SESSION_KEY || "agent:main:voice";
const DEFAULT_TARGET = process.env.PAW_PUSH_TO_TALK_TARGET || "voice";
const DEFAULT_SESSION_KEY = process.env.PAW_PUSH_TO_TALK_SESSION_KEY || null;
const DEFAULT_AGENT_TIMEOUT = process.env.PAW_PUSH_TO_TALK_AGENT_TIMEOUT || "45";
const WRAPPER_TIMEOUT_GRACE_MS = Number(process.env.PAW_PUSH_TO_TALK_WRAPPER_TIMEOUT_GRACE_MS || 30000);
const START_DELAY_MS = Number(process.env.PAW_PUSH_TO_TALK_START_DELAY_MS || 350);
const CUES = {
  start: process.env.PAW_PUSH_TO_TALK_START_CUE || "Glass",
  done: process.env.PAW_PUSH_TO_TALK_DONE_CUE || "none",
  failed: process.env.PAW_PUSH_TO_TALK_FAILED_CUE || "Basso",
  busy: process.env.PAW_PUSH_TO_TALK_BUSY_CUE || "Funk"
};
const STALE_LOCK_MS = Number(process.env.PAW_PUSH_TO_TALK_STALE_LOCK_MS || 10 * 60 * 1000);
const MODES = {
  quick: {
    duration: 5,
    model: "tiny",
    label: "quick"
  },
  normal: {
    duration: DEFAULT_DURATION,
    model: DEFAULT_MODEL,
    label: "normal"
  },
  dictation: {
    duration: 25,
    model: "base",
    label: "dictation"
  }
};

const args = process.argv.slice(2);

function usage() {
  console.log(`Paw Push-To-Talk Phase 2B

Usage:
  node tools/paw-push-to-talk.mjs
  node tools/paw-push-to-talk.mjs --mode quick|normal|dictation
  node tools/paw-push-to-talk.mjs --target voice|fresh|main|SESSION_KEY
  node tools/paw-push-to-talk.mjs --duration 8 [--device :0] [--stt-provider deepgram] [--stt-model nova-3] [--timeout 45]
  node tools/paw-push-to-talk.mjs --file audio.wav [--no-speak] [--json]
  node tools/paw-push-to-talk.mjs status
  node tools/paw-push-to-talk.mjs --dry-run

Behavior:
  - Records a short microphone request unless --file is provided.
  - Transcribes through Paw Listen, using Deepgram by default.
  - Sends the transcript to Paw through OpenClaw.
  - Speaks the reply through Bella unless --no-speak is used.
  - Uses minimal model thinking and a short spoken-reply instruction by default.
  - Routes to the sticky isolated voice session by default.
  - Use --target fresh for disposable diagnostic sessions.
  - Use --target main only when deliberately testing same-session continuity.
  - Does not log transcript text.
  - Uses a lock file to prevent duplicate overlapping recordings.
`);
}

function parseOptions(rawArgs) {
  const options = {
    file: null,
    mode: "normal",
    duration: DEFAULT_DURATION,
    device: DEFAULT_DEVICE,
    model: DEFAULT_MODEL,
    sttProvider: DEFAULT_STT_PROVIDER,
    sttModel: DEFAULT_STT_MODEL,
    agent: DEFAULT_AGENT,
    agentModel: null,
    agentThinking: DEFAULT_AGENT_THINKING,
    voiceBrief: DEFAULT_VOICE_BRIEF,
    voiceMaxWords: DEFAULT_VOICE_MAX_WORDS,
    speechMode: DEFAULT_SPEECH_MODE,
    fastReply: DEFAULT_FAST_REPLY,
    leanCommands: DEFAULT_LEAN_COMMANDS,
    instantAck: DEFAULT_INSTANT_ACK,
    instantAckText: DEFAULT_INSTANT_ACK_TEXT,
    target: DEFAULT_TARGET,
    sessionKey: DEFAULT_SESSION_KEY,
    timeout: DEFAULT_AGENT_TIMEOUT,
    speak: true,
    notify: true,
    sound: true,
    lock: true,
    json: false,
    keep: false,
    dryRun: false
  };
  const explicit = {
    duration: false,
    model: false
  };

  function readValue(flag, index) {
    const value = rawArgs[index + 1] || "";
    if (!value || value.startsWith("--")) {
      console.error(`Missing value for ${flag}.`);
      process.exit(2);
    }
    return value;
  }

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--file") {
      options.file = readValue(arg, i);
      i += 1;
    } else if (arg === "--mode") {
      options.mode = readValue(arg, i);
      if (!MODES[options.mode]) {
        console.error(`Unknown mode: ${options.mode}. Use quick, normal, or dictation.`);
        process.exit(2);
      }
      i += 1;
    } else if (arg === "--duration") {
      options.duration = Number(readValue(arg, i));
      explicit.duration = true;
      i += 1;
    } else if (arg === "--device") {
      options.device = readValue(arg, i);
      i += 1;
    } else if (arg === "--model") {
      options.model = readValue(arg, i);
      explicit.model = true;
      i += 1;
    } else if (arg === "--stt-provider") {
      options.sttProvider = readValue(arg, i).toLowerCase();
      i += 1;
    } else if (arg === "--stt-model") {
      options.sttModel = readValue(arg, i);
      i += 1;
    } else if (arg === "--agent") {
      options.agent = readValue(arg, i);
      i += 1;
    } else if (arg === "--agent-model") {
      options.agentModel = readValue(arg, i);
      i += 1;
    } else if (arg === "--agent-thinking") {
      options.agentThinking = readValue(arg, i);
      i += 1;
    } else if (arg === "--voice-brief") {
      options.voiceBrief = true;
    } else if (arg === "--no-voice-brief") {
      options.voiceBrief = false;
    } else if (arg === "--voice-max-words") {
      options.voiceMaxWords = Number(readValue(arg, i));
      i += 1;
    } else if (arg === "--speech-mode") {
      options.speechMode = readValue(arg, i).toLowerCase();
      i += 1;
    } else if (arg === "--fast-reply") {
      options.fastReply = true;
    } else if (arg === "--no-fast-reply") {
      options.fastReply = false;
    } else if (arg === "--lean-commands") {
      options.leanCommands = true;
    } else if (arg === "--no-lean-commands") {
      options.leanCommands = false;
    } else if (arg === "--instant-ack") {
      options.instantAck = true;
    } else if (arg === "--no-instant-ack") {
      options.instantAck = false;
    } else if (arg === "--instant-ack-text") {
      options.instantAckText = readValue(arg, i);
      i += 1;
    } else if (arg === "--target") {
      options.target = readValue(arg, i);
      i += 1;
    } else if (arg === "--session-key") {
      options.sessionKey = readValue(arg, i);
      i += 1;
    } else if (arg === "--main-session") {
      options.target = "main";
      options.sessionKey = MAIN_SESSION_KEY;
    } else if (arg === "--voice-session") {
      options.target = "voice";
      options.sessionKey = VOICE_SESSION_KEY;
    } else if (arg === "--fresh-session") {
      options.target = "fresh";
      options.sessionKey = null;
    } else if (arg === "--timeout") {
      options.timeout = readValue(arg, i);
      i += 1;
    } else if (arg === "--no-speak") {
      options.speak = false;
    } else if (arg === "--no-notify") {
      options.notify = false;
    } else if (arg === "--no-sound") {
      options.sound = false;
    } else if (arg === "--no-lock") {
      options.lock = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  const mode = MODES[options.mode];
  if (mode) {
    if (!explicit.duration) options.duration = mode.duration;
    if (!explicit.model) options.model = mode.model;
  }
  options.sessionKey = resolveSessionKey(options);
  if (!Number.isFinite(options.voiceMaxWords) || options.voiceMaxWords <= 0) {
    console.error("Voice max words must be a positive number.");
    process.exit(2);
  }
  if (!["elevenlabs", "macos"].includes(options.speechMode)) {
    console.error("Speech mode must be elevenlabs or macos.");
    process.exit(2);
  }

  return options;
}

function resolveSessionKey(options) {
  if (options.sessionKey) return options.sessionKey;
  if (options.target === "main") return MAIN_SESSION_KEY;
  if (options.target === "voice") return VOICE_SESSION_KEY;
  if (options.target === "fresh") return `${VOICE_SESSION_KEY}:${randomUUID()}`;
  if (!options.target || options.target === "default") return null;
  return options.target;
}

function haveBin(bin) {
  return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function notify(title, message) {
  if (!haveBin("osascript")) return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function playCue(name) {
  if (!name || name === "none" || name === "off") return;
  if (!haveBin("afplay")) return;
  const soundPath = `/System/Library/Sounds/${name}.aiff`;
  if (!fs.existsSync(soundPath)) return;
  spawnSync("afplay", [soundPath], { stdio: "ignore" });
}

function sleepMs(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function cue(options, type) {
  if (!options.sound) return;
  playCue(CUES[type]);
}

function classifyFailure(message, status) {
  const text = message || "";
  if (/Transcript is empty|Transcript rejected|Paw did not hear speech|Paw heard too little speech/i.test(text)) {
    return {
      title: "Paw did not hear speech",
      hint: "Try again closer to the microphone or use a longer duration."
    };
  }
  if (/ffmpeg recording failed|permission issue|Input\/output error|avfoundation/i.test(text)) {
    return {
      title: "Paw could not record",
      hint: "Check macOS microphone permission and the selected input device."
    };
  }
  if (/Whisper transcription failed|Missing whisper/i.test(text)) {
    return {
      title: "Paw could not transcribe",
      hint: "Check Whisper installation or try the tiny/base model again."
    };
  }
  if (/rate_limit|usage limit|cooldown|All models failed|FailoverError/i.test(text)) {
    return {
      title: "Paw model is unavailable",
      hint: "The voice request was heard, but the configured model provider is rate-limited or unavailable."
    };
  }
  if (/openclaw agent failed|GatewayClientRequestError|ECONNREFUSED|ENOTFOUND|OPENCLAW_BIN/i.test(text)) {
    return {
      title: "Paw could not reach OpenClaw",
      hint: "Check the OpenClaw gateway and OPENCLAW_BIN path."
    };
  }
  if (/openclaw agent timed out|Paw push-to-talk timed out|ETIMEDOUT/i.test(text)) {
    return {
      title: "Paw handoff timed out",
      hint: "The voice request reached OpenClaw, but the target session did not answer in time."
    };
  }
  if (/Deepgram|OpenAI|hosted STT|transcription failed|missing API key/i.test(text)) {
    return {
      title: "Paw could not transcribe",
      hint: "Check the hosted STT key and network connection."
    };
  }
  if (/ElevenLabs|sag|API key|paid_plan|required/i.test(text)) {
    return {
      title: "Paw could not speak",
      hint: "Check ElevenLabs key, voice access, and Paw Voice status."
    };
  }
  if (status === 4) {
    return {
      title: "Paw is already busy",
      hint: "Wait for the current voice request to finish."
    };
  }
  return {
    title: "Paw voice failed",
    hint: "Check /tmp/paw-push-to-talk.log for details."
  };
}

function readLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return { pid: null, started_at: null };
  }
}

function isPidRunning(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function acquireLock(options) {
  if (!options.lock) return () => {};
  ensureStateDir();

  const existing = readLock();
  if (existing) {
    const startedAt = existing.started_at ? Date.parse(existing.started_at) : NaN;
    const stale = Number.isFinite(startedAt) && Date.now() - startedAt > STALE_LOCK_MS;
    if (stale || !isPidRunning(existing.pid)) {
      fs.rmSync(LOCK_FILE, { force: true });
    } else {
      const message = `Paw is already listening or replying (pid ${existing.pid}).`;
      if (options.notify) notify("Paw is busy", "Already handling a voice request.");
      cue(options, "busy");
      console.error(message);
      process.exit(4);
    }
  }

  const lock = {
    pid: process.pid,
    started_at: new Date().toISOString()
  };

  try {
    const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    fs.closeSync(fd);
  } catch {
    if (options.notify) notify("Paw is busy", "Already handling a voice request.");
    cue(options, "busy");
    console.error("Paw is already listening or replying.");
    process.exit(4);
  }

  return () => {
    const current = readLock();
    if (current?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  };
}

function status() {
  const lock = readLock();
  const locked = Boolean(lock && isPidRunning(lock.pid));
  const visibleLock = locked ? lock : null;
  const result = {
    ok: fs.existsSync(PAW_LISTEN) && haveBin("node") && haveBin("openclaw") && haveBin("whisper") && haveBin("ffmpeg"),
    wrapper: path.join(WORKSPACE, "tools", "paw-push-to-talk.mjs"),
    paw_listen: PAW_LISTEN,
    state_dir: STATE_DIR,
    lock_file: LOCK_FILE,
    locked,
    lock: visibleLock,
    stale_lock: Boolean(lock && !locked),
    defaults: {
      duration_seconds: DEFAULT_DURATION,
      whisper_model: "configured",
      stt_provider: "configured",
      stt_model: "configured",
      device: "configured",
      agent: "configured",
      agent_thinking: DEFAULT_AGENT_THINKING ? "configured" : null,
      voice_brief: DEFAULT_VOICE_BRIEF,
      voice_max_words: DEFAULT_VOICE_MAX_WORDS,
      speech_mode: "configured",
      fast_reply: DEFAULT_FAST_REPLY,
      lean_commands: DEFAULT_LEAN_COMMANDS,
      instant_ack: DEFAULT_INSTANT_ACK,
      instant_ack_text: "configured",
      agent_timeout_seconds: "configured",
      start_delay_ms: START_DELAY_MS,
      cues: "configured",
      target: "configured",
      main_session_key: "configured",
      voice_session_key: "configured",
      fresh_voice_session_key: "configured",
      session_key: "configured"
    },
    modes: MODES,
    bins: {
      node: haveBin("node"),
      openclaw: haveBin("openclaw"),
      whisper: haveBin("whisper"),
      ffmpeg: haveBin("ffmpeg"),
      osascript: haveBin("osascript"),
      afplay: haveBin("afplay")
    }
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function buildListenArgs(options) {
  const listenArgs = ["ask"];

  if (options.file) {
    listenArgs.push("--file", options.file);
  } else {
    if (!Number.isFinite(options.duration) || options.duration <= 0 || options.duration > 120) {
      console.error("Duration must be between 1 and 120 seconds.");
      process.exit(2);
    }
    listenArgs.push("--record", "--duration", String(options.duration), "--device", options.device);
  }

  listenArgs.push("--model", options.model, "--stt-provider", options.sttProvider, "--agent", options.agent);
  if (options.sttModel) listenArgs.push("--stt-model", options.sttModel);

  if (options.agentModel) listenArgs.push("--agent-model", options.agentModel);
  if (options.agentThinking) listenArgs.push("--agent-thinking", options.agentThinking);
  listenArgs.push(options.voiceBrief ? "--voice-brief" : "--no-voice-brief");
  if (options.voiceBrief && Number.isFinite(options.voiceMaxWords)) listenArgs.push("--voice-max-words", String(options.voiceMaxWords));
  if (options.speechMode) listenArgs.push("--speech-mode", options.speechMode);
  listenArgs.push(options.fastReply ? "--fast-reply" : "--no-fast-reply");
  listenArgs.push(options.leanCommands ? "--lean-commands" : "--no-lean-commands");
  listenArgs.push(options.instantAck ? "--instant-ack" : "--no-instant-ack");
  if (options.instantAckText) listenArgs.push("--instant-ack-text", options.instantAckText);
  if (options.sessionKey) listenArgs.push("--session-key", options.sessionKey);
  if (options.timeout) listenArgs.push("--timeout", options.timeout);
  if (options.speak) listenArgs.push("--speak-reply");
  if (options.json) listenArgs.push("--json");
  if (options.keep) listenArgs.push("--keep");

  return listenArgs;
}

function listenTimeoutMs(options) {
  const durationSeconds = options.file ? 0 : Number(options.duration);
  const agentTimeoutSeconds = Number(options.timeout);
  const safeDurationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const safeAgentTimeoutSeconds = Number.isFinite(agentTimeoutSeconds) && agentTimeoutSeconds > 0 ? agentTimeoutSeconds : Number(DEFAULT_AGENT_TIMEOUT);
  return Math.ceil((safeDurationSeconds + safeAgentTimeoutSeconds) * 1000 + WRAPPER_TIMEOUT_GRACE_MS);
}

function run(options) {
  if (!fs.existsSync(PAW_LISTEN)) {
    console.error(`Missing Paw Listen wrapper: ${PAW_LISTEN}`);
    process.exit(5);
  }
  if (options.file && !fs.existsSync(options.file)) {
    console.error(`Audio file not found: ${options.file}`);
    process.exit(2);
  }

  if (options.dryRun) {
    console.log(JSON.stringify({
      command: "node",
      args: ["tools/paw-listen.mjs", "<runtime-options-redacted>"],
      redacted: true,
      note: "Dry run hides environment-derived voice configuration."
    }, null, 2));
    return;
  }

  const listenArgs = buildListenArgs(options);
  const releaseLock = acquireLock(options);

  let result;
  try {
    cue(options, "start");
    if (!options.file && START_DELAY_MS > 0) sleepMs(START_DELAY_MS);
    if (options.notify && !options.file) {
      notify("Paw listening", `${options.mode} mode, ${options.duration} seconds...`);
    } else if (options.notify) {
      notify("Paw listening", "Processing voice request...");
    }

    result = spawnSync("node", [PAW_LISTEN, ...listenArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: listenTimeoutMs(options),
      killSignal: "SIGTERM"
    });
  } finally {
    releaseLock();
  }

  if (result.status !== 0) {
    const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : "";
    const timedOut = result.error?.code === "ETIMEDOUT";
    const timeoutMessage = timedOut ? `Paw push-to-talk timed out after ${Math.round(listenTimeoutMs(options) / 1000)} seconds.` : "";
    const message = String(result.stderr || result.stdout || timeoutMessage || spawnError || "Paw push-to-talk failed.").trim();
    const failure = classifyFailure(message, result.status);
    if (options.notify) notify(failure.title, failure.hint);
    cue(options, "failed");
    process.stderr.write(`${failure.title}: ${failure.hint}\n${message}\n`);
    process.exit(result.status || 1);
  }

  cue(options, "done");
  if (options.notify) notify("Paw replied", options.speak ? "Spoken reply complete." : "Text reply ready.");
  process.stdout.write(result.stdout);
}

const command = args[0] || "";
if (command === "status") {
  status();
} else if (command === "help" || command === "--help" || command === "-h") {
  usage();
} else {
  run(parseOptions(args));
}
