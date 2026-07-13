#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(WORKSPACE, ".openclaw", "paw-listen");
const LAST_DIAGNOSIS_PATH = path.join(STATE_DIR, "last-diagnosis.json");
const VOICE_TASKS_PATH = path.join(STATE_DIR, "voice-tasks.json");
const LAST_TRANSCRIPT_PATH = path.join(STATE_DIR, "last-transcript.json");
const SPEAKER_PROFILE_PATH = path.join(STATE_DIR, "speaker-profile.json");
const PAW_VOICE = path.join(WORKSPACE, "tools", "paw-voice.mjs");
const PAW_MAIN_HANDOFF_WORKER = path.join(WORKSPACE, "tools", "paw-main-handoff-worker.mjs");
const PAW_VOICE_STATE_PATH = path.join(WORKSPACE, ".openclaw", "paw-voice", "state.json");
const PAW_VOICE_CATALOG_PATH = path.join(WORKSPACE, ".openclaw", "paw-voice", "voice-catalog.json");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.dirname(WORKSPACE);
const MAIN_SESSION_KEY = process.env.PAW_LISTEN_MAIN_SESSION_KEY || "agent:main:main";
const VOICE_SESSION_KEY = process.env.PAW_LISTEN_VOICE_SESSION_KEY || "agent:main:voice";
const LONG_TASK_SESSION_KEY = process.env.PAW_LISTEN_LONG_TASK_SESSION_KEY || "agent:main:voice-tasks";
const MAIN_AGENT_SESSIONS_DIR = path.join(OPENCLAW_HOME, "agents", "main", "sessions");
const MAIN_AGENT_SESSIONS_PATH = path.join(MAIN_AGENT_SESSIONS_DIR, "sessions.json");
const PAW_STT_GO = path.join(WORKSPACE, "tools", "paw-stt-go", "paw-stt-go");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DEFAULT_STT_PROVIDER = process.env.PAW_LISTEN_STT_PROVIDER || "whisper";
const DEFAULT_MODEL = process.env.PAW_LISTEN_WHISPER_MODEL || "base";
const DEFAULT_HOSTED_MODEL = process.env.PAW_LISTEN_HOSTED_STT_MODEL || "";
const DEFAULT_BENCHMARK_MODELS = ["tiny", "base", "small"];
const DEFAULT_LANGUAGE = process.env.PAW_LISTEN_LANGUAGE || "en";
const DEFAULT_DEVICE = process.env.PAW_LISTEN_DEVICE || ":0";
const DEFAULT_AGENT = process.env.PAW_LISTEN_AGENT || "main";
const DEFAULT_AGENT_THINKING = process.env.PAW_LISTEN_AGENT_THINKING || "";
const DEFAULT_VOICE_BRIEF = process.env.PAW_LISTEN_VOICE_BRIEF !== "0";
const DEFAULT_VOICE_MAX_WORDS = Number(process.env.PAW_LISTEN_VOICE_MAX_WORDS || 6);
const DEFAULT_SPEECH_MODE = (process.env.PAW_LISTEN_SPEECH_MODE || "elevenlabs").toLowerCase();
const DEFAULT_FAST_REPLY = process.env.PAW_LISTEN_FAST_REPLY !== "0";
const DEFAULT_LEAN_COMMANDS = process.env.PAW_LISTEN_LEAN_COMMANDS !== "0";
const DEFAULT_INSTANT_ACK = process.env.PAW_LISTEN_INSTANT_ACK !== "0";
const DEFAULT_INSTANT_ACK_TEXT = process.env.PAW_LISTEN_INSTANT_ACK_TEXT || "On it.";
const DEFAULT_TIMEOUT = process.env.PAW_LISTEN_TIMEOUT || "600";
const DEFAULT_LONG_TASK_TIMEOUT = process.env.PAW_LISTEN_LONG_TASK_TIMEOUT || "900";
const DEFAULT_TASK_COMPLETION_SPEAK = process.env.PAW_LISTEN_TASK_COMPLETION_SPEAK !== "0";
const AGENT_TIMEOUT_GRACE_MS = Number(process.env.PAW_LISTEN_AGENT_TIMEOUT_GRACE_MS || 5000);
const KEEP_REJECTED_AUDIO = process.env.PAW_LISTEN_KEEP_REJECTED_AUDIO !== "0";
const LOCAL_TIME_ZONE = process.env.PAW_LISTEN_TIME_ZONE || "America/Chicago";

const args = process.argv.slice(2);
const command = args[0] || "help";

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function usage() {
  console.log(`Paw Listen Phase 2

Usage:
  node tools/paw-listen.mjs status
  node tools/paw-listen.mjs transcribe --file audio.wav [--stt-provider whisper|deepgram|openai] [--model base|nova-3] [--language en] [--json] [--keep]
  node tools/paw-listen.mjs record --duration 8 [--device :0] [--stt-provider whisper|deepgram|openai] [--model base|nova-3] [--language en] [--json] [--keep]
  node tools/paw-listen.mjs ask --file audio.wav [--agent main] [--agent-model MODEL] [--session-key agent:main:voice] [--speak-reply] [--json]
  node tools/paw-listen.mjs ask --record --duration 8 [--device :0] [--speak-reply]
  node tools/paw-listen.mjs benchmark --file audio.wav [--models tiny,base,small] [--language en] [--json]
  node tools/paw-listen.mjs devices
  node tools/paw-listen.mjs diagnose [--duration 8] [--device :0|iPhone] [--models tiny,base,small] [--json]

Rules:
  - Transcribes locally with Whisper by default, or hosted STT when requested.
  - Uses temporary files unless --keep is supplied.
  - Does not log transcript text.
  - Sends to OpenClaw only when using ask.
  - Spoken replies go through Paw Voice safety filters.
`);
}

function parseOptions(rawArgs) {
  const options = {
    file: null,
    record: false,
    duration: 8,
    device: DEFAULT_DEVICE,
    sttProvider: DEFAULT_STT_PROVIDER,
    model: DEFAULT_MODEL,
    hostedModel: DEFAULT_HOSTED_MODEL,
    language: DEFAULT_LANGUAGE,
    agent: DEFAULT_AGENT,
    agentModel: null,
    agentThinking: DEFAULT_AGENT_THINKING,
    sessionKey: null,
    voiceBrief: DEFAULT_VOICE_BRIEF,
    voiceMaxWords: DEFAULT_VOICE_MAX_WORDS,
    speechMode: DEFAULT_SPEECH_MODE,
    fastReply: DEFAULT_FAST_REPLY,
    leanCommands: DEFAULT_LEAN_COMMANDS,
    instantAck: DEFAULT_INSTANT_ACK,
    instantAckText: DEFAULT_INSTANT_ACK_TEXT,
    timeout: DEFAULT_TIMEOUT,
    speakReply: false,
    json: false,
    keep: false
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--file") {
      options.file = rawArgs[++i] || "";
    } else if (arg === "--record") {
      options.record = true;
    } else if (arg === "--duration") {
      options.duration = Number(rawArgs[++i] || options.duration);
    } else if (arg === "--device") {
      options.device = rawArgs[++i] || DEFAULT_DEVICE;
    } else if (arg === "--model") {
      options.model = rawArgs[++i] || DEFAULT_MODEL;
    } else if (arg === "--stt-provider") {
      options.sttProvider = (rawArgs[++i] || DEFAULT_STT_PROVIDER).toLowerCase();
    } else if (arg === "--stt-model") {
      options.hostedModel = rawArgs[++i] || "";
    } else if (arg === "--language") {
      options.language = rawArgs[++i] || DEFAULT_LANGUAGE;
    } else if (arg === "--agent") {
      options.agent = rawArgs[++i] || DEFAULT_AGENT;
    } else if (arg === "--agent-model") {
      options.agentModel = rawArgs[++i] || "";
    } else if (arg === "--agent-thinking") {
      options.agentThinking = rawArgs[++i] || "";
    } else if (arg === "--session-key") {
      options.sessionKey = rawArgs[++i] || "";
    } else if (arg === "--voice-brief") {
      options.voiceBrief = true;
    } else if (arg === "--no-voice-brief") {
      options.voiceBrief = false;
    } else if (arg === "--voice-max-words") {
      options.voiceMaxWords = Number(rawArgs[++i] || DEFAULT_VOICE_MAX_WORDS);
    } else if (arg === "--speech-mode") {
      options.speechMode = (rawArgs[++i] || DEFAULT_SPEECH_MODE).toLowerCase();
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
      options.instantAckText = rawArgs[++i] || DEFAULT_INSTANT_ACK_TEXT;
    } else if (arg === "--timeout") {
      options.timeout = rawArgs[++i] || DEFAULT_TIMEOUT;
    } else if (arg === "--speak-reply") {
      options.speakReply = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--models") {
      options.models = (rawArgs[++i] || "").split(",").map((model) => model.trim()).filter(Boolean);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

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

function haveBin(bin) {
  return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function nowIso() {
  return new Date().toISOString();
}

function taskLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function spokenTaskLabel(task) {
  const label = taskLabel(task?.label || "voice task").replace(/[.?!]+$/g, "");
  return label || "voice task";
}

function readVoiceTasks() {
  const state = readJson(VOICE_TASKS_PATH, { tasks: [] });
  return { tasks: Array.isArray(state?.tasks) ? state.tasks : [] };
}

function writeVoiceTasks(state) {
  ensureStateDir();
  writeJson(VOICE_TASKS_PATH, { tasks: state.tasks.slice(-50) });
}

function upsertVoiceTask(task) {
  const state = readVoiceTasks();
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) state.tasks[index] = { ...state.tasks[index], ...task };
  else state.tasks.push(task);
  writeVoiceTasks(state);
}

function updateVoiceTask(id, patch) {
  const state = readVoiceTasks();
  const index = state.tasks.findIndex((item) => item.id === id);
  if (index < 0) return null;
  state.tasks[index] = { ...state.tasks[index], ...patch, updated_at: nowIso() };
  writeVoiceTasks(state);
  return state.tasks[index];
}

function syncVoiceTasks() {
  const state = readVoiceTasks();
  let changed = false;
  for (const task of state.tasks) {
    if (task.status === "failed" && !task.error) {
      const reason = taskFailureReason(task);
      if (reason) {
        task.error = reason;
        task.updated_at = nowIso();
        changed = true;
      }
    }
    if (!task.status_path || task.status === "complete" || task.status === "failed" || task.status === "canceled") continue;
    if (!fs.existsSync(task.status_path)) continue;
    const status = readJson(task.status_path, {});
    const ok = Number(status?.status) === 0 && !status?.error;
    task.status = ok ? "complete" : "failed";
    task.exit_status = status?.status ?? null;
    task.error = status?.error || taskFailureReason(task) || null;
    task.ended_at = status?.ended_at || nowIso();
    task.updated_at = nowIso();
    changed = true;
  }
  if (changed) writeVoiceTasks(state);
  return state;
}

function taskFailureReason(task) {
  try {
    const stderr = task.stderr_path && fs.existsSync(task.stderr_path) ? fs.readFileSync(task.stderr_path, "utf8") : "";
    const text = stderr.replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/usage limit|subscription usage limit|rate.limit|rate limit/i.test(text)) return "Model usage limit reached.";
    if (/timed out|timeout/i.test(text)) return "Task timed out.";
    return text.slice(0, 180);
  } catch {
    return null;
  }
}

function voiceTaskStatusReply() {
  const state = syncVoiceTasks();
  const active = state.tasks.filter((task) => task.status === "running" || task.status === "queued");
  if (active.length) {
    const latest = active[active.length - 1];
    return `Working on ${spokenTaskLabel(latest)}.`;
  }
  const latest = state.tasks[state.tasks.length - 1];
  if (!latest) return "No voice tasks yet.";
  if (latest.status === "complete") return `Last task finished: ${spokenTaskLabel(latest)}.`;
  if (latest.status === "failed") {
    const reasonText = latest.error || taskFailureReason(latest);
    const reason = reasonText ? ` ${reasonText}` : "";
    return `Last task failed.${reason}`;
  }
  if (latest.status === "canceled") return `Last task canceled: ${latest.label || "voice task"}.`;
  return `Last task is ${latest.status || "unknown"}.`;
}

function cancelLatestVoiceTask() {
  const state = syncVoiceTasks();
  const task = [...state.tasks].reverse().find((item) => item.status === "running" || item.status === "queued");
  if (!task) return { reply: "No running voice task.", command: "voice_task_cancel" };
  let killed = false;
  if (task.pid) {
    try {
      process.kill(Number(task.pid), "SIGTERM");
      killed = true;
    } catch {
      killed = false;
    }
  }
  updateVoiceTask(task.id, {
    status: "canceled",
    canceled_at: nowIso(),
    cancel_signal_sent: killed
  });
  if (task.message_path) fs.rmSync(task.message_path, { force: true });
  return { reply: killed ? "Canceled the voice task." : "Marked task canceled.", command: "voice_task_cancel" };
}

function rememberTranscript(transcript, corrected) {
  ensureStateDir();
  writeJson(LAST_TRANSCRIPT_PATH, {
    at: nowIso(),
    transcript,
    corrected
  });
}

function lastHeardReply() {
  const last = readJson(LAST_TRANSCRIPT_PATH, null);
  if (!last?.corrected && !last?.transcript) return { reply: "I don't have one yet.", command: "last_heard" };
  return { reply: `I heard: ${last.corrected || last.transcript}`, command: "last_heard" };
}

function correctionReply(transcript) {
  const match = transcript.match(/(?:correct that|correction|actually|no i said)\s*[:.,-]?\s*(.+)$/i);
  const corrected = match?.[1]?.replace(/^[\s.,”"'`-]+/, "").trim();
  if (!corrected) return null;
  rememberTranscript(corrected, correctedTranscript(corrected));
  return { reply: "Got the correction.", command: "transcript_correction" };
}

function titleCaseName(name) {
  return String(name || "")
    .trim()
    .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function extractIntroducedFirstName(transcript) {
  const text = String(transcript || "").trim();
  const patterns = [
    /\b(?:hi|hello|hey)?\s*(?:paw|there)?[,\s]*(?:my name is|my name's|i am|i'm|im|this is|it is|it's)\s+([A-Za-z][A-Za-z'-]{1,40})(?:\s+[A-Za-z][A-Za-z'-]{1,40})?\b/i,
    /\b(?:call me|you can call me)\s+([A-Za-z][A-Za-z'-]{1,40})\b/i,
    /\b(?:meet|say hi to)\s+([A-Za-z][A-Za-z'-]{1,40})\b/i
  ];
  const blocked = new Set(["paw", "openclaw", "glitter", "glitterngeek", "voice"]);
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = titleCaseName(match?.[1] || "");
    if (name && !blocked.has(name.toLowerCase())) return name;
  }
  return null;
}

function currentSpeakerProfile() {
  const profile = readJson(SPEAKER_PROFILE_PATH, null);
  if (!profile?.first_name) return { first_name: "Vic", introduced: false };
  return profile;
}

function rememberSpeaker(firstName, transcript) {
  ensureStateDir();
  const profile = {
    first_name: firstName,
    introduced: firstName !== "Vic",
    creator_name: "Vic",
    creator_context: "founder of GlitterNGeek",
    source: "voice_introduction",
    transcript,
    updated_at: nowIso()
  };
  writeJson(SPEAKER_PROFILE_PATH, profile);
  return profile;
}

function introductionGreeting(firstName) {
  const greetings = [
    `Hi, ${firstName}. Lovely to meet you. I'm Paw, created by Vic, founder of GlitterNGeek. Tiny circuits, big sparkle. How can I help?`,
    `Hi, ${firstName}. Nice to meet you. Vic, founder of GlitterNGeek, created me, and I am delighted to make your acquaintance. What can I help with?`,
    `Hi, ${firstName}. Paw here. Vic from GlitterNGeek made me, then sprinkled in just enough mischief to be useful. What are we doing first?`,
    `Hi, ${firstName}. Welcome to the sparkle side. I was created by Vic, founder of GlitterNGeek. How can I help you today?`,
    `Hi, ${firstName}. Nice to meet you. I was created by Vic, founder of GlitterNGeek, and my tiny digital paws are ready. What do you need?`
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

function introductionReply(transcript) {
  const firstName = extractIntroducedFirstName(transcript);
  if (!firstName) return null;
  rememberSpeaker(firstName, transcript);
  return {
    reply: introductionGreeting(firstName),
    command: "speaker_introduction",
    speaker_first_name: firstName
  };
}

function status() {
  const resolvedDevice = resolveInputDevice(DEFAULT_DEVICE, { quiet: true });
  const tasks = syncVoiceTasks().tasks;
  const latestTask = tasks[tasks.length - 1] || null;
  const result = {
    ok: true,
    workspace: "configured",
    state_dir: "configured",
    bins: {
      ffmpeg: haveBin("ffmpeg"),
      whisper: haveBin("whisper"),
      paw_stt_go: fs.existsSync(PAW_STT_GO),
      openclaw: fs.existsSync(OPENCLAW_BIN) || haveBin("openclaw"),
      node: haveBin("node")
    },
    openclaw_bin: "configured",
    defaults: {
      model: "configured",
      stt_provider: "configured",
      hosted_stt_model: DEFAULT_HOSTED_MODEL ? "configured" : null,
      language: "configured",
      device: "configured",
      resolved_device: resolvedDevice ? "configured" : null,
      agent: "configured",
      agent_thinking: DEFAULT_AGENT_THINKING ? "configured" : null,
      voice_brief: DEFAULT_VOICE_BRIEF,
      voice_max_words: DEFAULT_VOICE_MAX_WORDS,
      speech_mode: "configured",
      fast_reply: DEFAULT_FAST_REPLY,
      lean_commands: DEFAULT_LEAN_COMMANDS,
      instant_ack: DEFAULT_INSTANT_ACK,
      instant_ack_text: "configured",
      voice_session_key: "configured",
      main_session_key: "configured",
      long_task_session_key: "configured",
      long_task_timeout_seconds: "configured",
      task_completion_speak: DEFAULT_TASK_COMPLETION_SPEAK
    },
    voice_tasks: {
      count: tasks.length,
      active: tasks.filter((task) => task.status === "running" || task.status === "queued").length,
      latest: latestTask ? {
        id: latestTask.id,
        status: latestTask.status,
        command: latestTask.command,
        created_at: latestTask.created_at,
        updated_at: latestTask.updated_at,
        completed_at: latestTask.completed_at || null,
        exit_status: latestTask.exit_status ?? null,
        signal: latestTask.signal || null,
        error: latestTask.error ? "configured" : null,
        result_preview: latestTask.result_preview ? "available" : null
      } : null
    }
  };
  result.ok = Object.values(result.bins).every(Boolean);
  console.log(JSON.stringify(result, null, 2));
}

function tempPath(ext) {
  ensureStateDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(STATE_DIR, `paw-listen-${stamp}-${process.pid}.${ext}`);
}

function recordAudio(options) {
  if (!Number.isFinite(options.duration) || options.duration <= 0 || options.duration > 120) {
    console.error("Duration must be between 1 and 120 seconds.");
    process.exit(2);
  }
  if (!haveBin("ffmpeg")) {
    console.error("Missing ffmpeg. Install ffmpeg before recording audio.");
    process.exit(5);
  }

  const outPath = tempPath("wav");
  const device = resolveInputDevice(options.device);
  const started = Date.now();
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "avfoundation",
    "-i", device,
    "-t", String(options.duration),
    "-ac", "1",
    "-ar", "16000",
    outPath
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "ffmpeg recording failed.");
    console.error("If this is a macOS permission issue, allow microphone access for your terminal app and retry.");
    process.exit(result.status || 1);
  }
  return { file: outPath, duration_ms: Date.now() - started };
}

function audioDevices() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-f", "avfoundation",
    "-list_devices", "true",
    "-i", ""
  ], { encoding: "utf8" });
  const output = `${result.stderr || ""}${result.stdout || ""}`;
  const audioDevices = [];
  let inAudioSection = false;
  for (const line of output.split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (inAudioSection) {
      const match = line.match(/\[(\d+)\]\s+(.+)$/);
      if (match) audioDevices.push({ index: Number(match[1]), name: match[2].trim(), device: `:${match[1]}` });
    }
  }
  return audioDevices;
}

function listDevices() {
  const devices = audioDevices();
  console.log(JSON.stringify({ ok: devices.length > 0, audio_devices: devices }, null, 2));
}

function resolveInputDevice(deviceSpec, options = {}) {
  const spec = String(deviceSpec || DEFAULT_DEVICE).trim();
  if (/^:\d+$/.test(spec)) return spec;

  const devices = audioDevices();
  const normalized = spec.toLowerCase();
  const match = devices.find((device) => device.name.toLowerCase() === normalized) ||
    devices.find((device) => device.name.toLowerCase().includes(normalized));
  if (match) return match.device;

  if (!options.quiet) {
    const available = devices.map((device) => `${device.device} ${device.name}`).join(", ") || "none";
    console.error(`Audio device not found: ${spec}. Available: ${available}`);
    process.exit(2);
  }
  return spec;
}

function playCue(name) {
  if (!haveBin("afplay")) return;
  const soundPath = `/System/Library/Sounds/${name}.aiff`;
  if (fs.existsSync(soundPath)) spawnSync("afplay", [soundPath], { stdio: "ignore" });
}

function audioStats(filePath) {
  const stats = {
    file: filePath,
    bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    duration_seconds: null,
    mean_volume_db: null,
    max_volume_db: null,
    silence_seconds: 0,
    silence_ratio: null
  };

  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { encoding: "utf8" });
  const duration = Number((probe.stdout || "").trim());
  if (Number.isFinite(duration)) stats.duration_seconds = Number(duration.toFixed(3));

  const volume = spawnSync("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-af", "volumedetect",
    "-f", "null",
    "-"
  ], { encoding: "utf8" });
  const volumeOutput = `${volume.stderr || ""}${volume.stdout || ""}`;
  const meanMatch = volumeOutput.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const maxMatch = volumeOutput.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  if (meanMatch) stats.mean_volume_db = Number(meanMatch[1]);
  if (maxMatch) stats.max_volume_db = Number(maxMatch[1]);

  const silence = spawnSync("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-af", "silencedetect=noise=-45dB:d=0.25",
    "-f", "null",
    "-"
  ], { encoding: "utf8" });
  const silenceOutput = `${silence.stderr || ""}${silence.stdout || ""}`;
  const durations = [...silenceOutput.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  stats.silence_seconds = Number(durations.reduce((sum, value) => sum + value, 0).toFixed(3));
  if (Number.isFinite(stats.duration_seconds) && stats.duration_seconds > 0) {
    stats.silence_ratio = Number(Math.min(1, stats.silence_seconds / stats.duration_seconds).toFixed(3));
  }

  return stats;
}

function transcribeFile(filePath, options) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Audio file not found: ${filePath || "(missing)"}`);
    process.exit(2);
  }
  if (options.sttProvider && options.sttProvider !== "whisper") {
    return transcribeHostedFile(filePath, options);
  }
  if (!haveBin("whisper")) {
    console.error("Missing whisper. Install OpenAI Whisper before transcribing audio.");
    process.exit(5);
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-listen-whisper-"));
  const started = Date.now();
  const result = spawnSync("whisper", [
    filePath,
    "--model", options.model,
    "--language", options.language,
    "--output_format", "txt",
    "--output_dir", outDir
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    if (!options.keep) fs.rmSync(outDir, { recursive: true, force: true });
    console.error(result.stderr || result.stdout || "Whisper transcription failed.");
    process.exit(result.status || 1);
  }

  const stem = path.basename(filePath, path.extname(filePath));
  const txtPath = path.join(outDir, `${stem}.txt`);
  const transcript = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8").trim() : "";
  if (!options.keep) fs.rmSync(outDir, { recursive: true, force: true });

  return {
    transcript,
    provider: "whisper",
    model: options.model,
    duration_ms: Date.now() - started
  };
}

function transcribeHostedFile(filePath, options) {
  if (!fs.existsSync(PAW_STT_GO)) {
    console.error(`Missing hosted STT helper: ${PAW_STT_GO}`);
    process.exit(5);
  }
  const provider = String(options.sttProvider || "").toLowerCase();
  if (!["deepgram", "openai"].includes(provider)) {
    console.error(`Unknown STT provider: ${provider}. Use whisper, deepgram, or openai.`);
    process.exit(2);
  }

  const args = ["--provider", provider, "--file", filePath, "--language", options.language];
  const hostedModel = options.hostedModel || (provider === "deepgram" && options.model === DEFAULT_MODEL ? "nova-3" : options.model);
  if (hostedModel) args.push("--model", hostedModel);

  const result = spawnSync(PAW_STT_GO, args, { encoding: "utf8" });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    // Keep parsed null so the error path below includes stderr/stdout.
  }
  if (result.status !== 0 || !parsed?.ok) {
    const message = parsed?.error || result.stderr || result.stdout || `${provider} transcription failed.`;
    console.error(message);
    process.exit(result.status || 1);
  }

  return {
    transcript: String(parsed.transcript || "").trim(),
    provider,
    model: parsed.model || hostedModel || provider,
    duration_ms: parsed.duration_ms,
    confidence: parsed.confidence ?? null,
    words: parsed.words ?? null
  };
}

function extractAgentReply(jsonText) {
  const parsed = JSON.parse(jsonText);
  return parsed?.result?.meta?.finalAssistantVisibleText ||
    parsed?.result?.payloads?.map((payload) => payload.text).filter(Boolean).join("\n").trim() ||
    "";
}

function voiceMessage(transcript, options) {
  if (!options.voiceBrief) return transcript;
  const maxWords = Number.isFinite(options.voiceMaxWords) && options.voiceMaxWords > 0 ? Math.round(options.voiceMaxWords) : 6;
  const speaker = currentSpeakerProfile();
  const speakerName = speaker?.first_name || "Vic";
  const creatorLine = speakerName === "Vic"
    ? "Voice request from Vic."
    : `Voice request from ${speakerName}. Paw was created by Vic, founder of GlitterNGeek.`;
  return [
    `${creatorLine} Reply for spoken playback in ${maxWords} words or fewer unless ${speakerName} explicitly asks for detail. No markdown, no lists, no preamble.`,
    "",
    `${speakerName} said: ${transcript}`
  ].join("\n");
}

function normalizeTranscript(transcript) {
  return transcript.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ");
}

function correctedTranscript(transcript) {
  let text = String(transcript || "");
  const replacements = [
    [/\bpaul(?:'s|s)?\s+voice\b/gi, "Paw's voice"],
    [/\bpaul\b/gi, "Paw"],
    [/\bobsidian\b/gi, "Obsidian"],
    [/\bopen claw\b/gi, "OpenClaw"],
    [/\bcontrol space\b/gi, "Control Space"],
    [/\bg and g\b/gi, "GNG"],
    [/\bglitter and geek\b/gi, "GlitterNGeek"]
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

function fastVoiceReply(transcript, options) {
  if (!options.fastReply || !options.voiceBrief) return null;
  const text = normalizeTranscript(transcript);
  if (!text) return null;

  if (/\b(latency|speed|response time)\b/.test(text) && /\b(test|check)\b/.test(text)) {
    return "Latency test received.";
  }
  if (/\b(mic|microphone|audio|signal)\b/.test(text) && /\b(test|check|clear|working|hear)\b/.test(text)) {
    return "I hear you clearly.";
  }
  if (/\b(can you hear me|do you hear me|are you there)\b/.test(text)) {
    return "I hear you clearly.";
  }
  return null;
}

function shortVoiceName(voice, catalog) {
  if (!voice) return "unknown";
  const entry = catalog?.[voice] || Object.values(catalog || {}).find((item) => item?.name === voice);
  const label = entry?.name || voice;
  return String(label).split(" - ")[0].trim() || String(label);
}

function voiceStatusReply() {
  const state = readJson(PAW_VOICE_STATE_PATH, {});
  const catalog = readJson(PAW_VOICE_CATALOG_PATH, {});
  const enabled = state.enabled === false ? "off" : "on";
  const mode = state.voice_mode === "rotate" ? "rotating" : "fixed";
  const voice = shortVoiceName(state.voice, catalog);
  const modePhrase = mode === "rotating" ? "Voice rotation is on" : `Using ${voice}`;
  return `Voice is ${enabled}. ${modePhrase}.`;
}

function pushToTalkStatusReply() {
  return "Push to talk is ready.";
}

function localTimeReply() {
  return `It's ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: LOCAL_TIME_ZONE
  }).format(new Date())}.`;
}

function localDateReply() {
  return `It's ${new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: LOCAL_TIME_ZONE
  }).format(new Date())}.`;
}

function formatSpokenTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: LOCAL_TIME_ZONE
  }).format(date);
}

function formatSpokenDay(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: LOCAL_TIME_ZONE
  }).format(date);
}

function relativeDayLabel(target, base = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: LOCAL_TIME_ZONE
  });
  const baseDay = new Date(`${day.format(base)}T00:00:00Z`);
  const targetDay = new Date(`${day.format(target)}T00:00:00Z`);
  const diffDays = Math.round((targetDay - baseDay) / 86400000);
  if (diffDays === 0) return "";
  if (diffDays === 1) return "tomorrow ";
  if (diffDays === -1) return "yesterday ";
  return `${formatSpokenDay(target)} `;
}

function numberFromWords(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  if (/^\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  const words = {
    a: 1,
    an: 1,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  };
  if (normalized === "half") return 0.5;
  if (words[normalized] !== undefined) return words[normalized];

  const parts = normalized.split(" ").filter((part) => part !== "and");
  let total = 0;
  let current = 0;
  for (const part of parts) {
    if (words[part] === undefined && part !== "hundred") return null;
    if (part === "hundred") {
      current = (current || 1) * 100;
    } else {
      current += words[part];
    }
  }
  total += current;
  return Number.isFinite(total) ? total : null;
}

const NUMBER_PATTERN = [
  "\\d+(?:\\.\\d+)?",
  "a",
  "an",
  "half",
  "(?:(?:one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+and)?(?:\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\\s+(?:one|two|three|four|five|six|seven|eight|nine))?)?)",
  "(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\\s+(?:one|two|three|four|five|six|seven|eight|nine))?)",
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)"
].join("|");

function trimNumber(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.abs(value) < 1000 ? Math.round(value * 10) / 10 : Math.round(value);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.0$/, "");
}

function simpleMathReply(text) {
  const patterns = [
    { re: new RegExp(`\\b(?:what is|what s|calculate)?\\s*(${NUMBER_PATTERN})\\s+(?:plus|add|added to)\\s+(${NUMBER_PATTERN})\\b`, "i"), op: (a, b) => a + b },
    { re: new RegExp(`\\b(?:what is|what s|calculate)?\\s*(${NUMBER_PATTERN})\\s+(?:minus|less|subtract)\\s+(${NUMBER_PATTERN})\\b`, "i"), op: (a, b) => a - b },
    { re: new RegExp(`\\b(?:what is|what s|calculate)?\\s*(${NUMBER_PATTERN})\\s+(?:times|multiplied by|x)\\s+(${NUMBER_PATTERN})\\b`, "i"), op: (a, b) => a * b },
    { re: new RegExp(`\\b(?:what is|what s|calculate)?\\s*(${NUMBER_PATTERN})\\s+(?:divided by|over)\\s+(${NUMBER_PATTERN})\\b`, "i"), op: (a, b) => b === 0 ? null : a / b }
  ];
  for (const { re, op } of patterns) {
    const match = text.match(re);
    if (!match) continue;
    const left = numberFromWords(match[1]);
    const right = numberFromWords(match[2]);
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    const result = op(left, right);
    if (!Number.isFinite(result)) return "I can't divide by zero.";
    return `It's ${trimNumber(result)}.`;
  }

  const percent = text.match(new RegExp(`\\b(${NUMBER_PATTERN})\\s+percent\\s+of\\s+(${NUMBER_PATTERN})\\b`, "i"));
  if (percent) {
    const pct = numberFromWords(percent[1]);
    const value = numberFromWords(percent[2]);
    if (Number.isFinite(pct) && Number.isFinite(value)) return `It's ${trimNumber((pct / 100) * value)}.`;
  }

  return null;
}

function convertUnit(value, from, to) {
  const key = `${from}:${to}`;
  const conversions = {
    "fahrenheit:celsius": (x) => (x - 32) * (5 / 9),
    "celsius:fahrenheit": (x) => (x * 9 / 5) + 32,
    "miles:kilometers": (x) => x * 1.609344,
    "kilometers:miles": (x) => x / 1.609344,
    "pounds:kilograms": (x) => x * 0.45359237,
    "kilograms:pounds": (x) => x / 0.45359237,
    "feet:meters": (x) => x * 0.3048,
    "meters:feet": (x) => x / 0.3048,
    "inches:centimeters": (x) => x * 2.54,
    "centimeters:inches": (x) => x / 2.54
  };
  return conversions[key]?.(value) ?? null;
}

function canonicalUnit(unit) {
  const normalized = unit.toLowerCase();
  const aliases = {
    f: "fahrenheit",
    fahrenheit: "fahrenheit",
    c: "celsius",
    celsius: "celsius",
    mile: "miles",
    miles: "miles",
    kilometer: "kilometers",
    kilometers: "kilometers",
    kilometre: "kilometers",
    kilometres: "kilometers",
    pound: "pounds",
    pounds: "pounds",
    lb: "pounds",
    lbs: "pounds",
    kilogram: "kilograms",
    kilograms: "kilograms",
    kilo: "kilograms",
    kilos: "kilograms",
    foot: "feet",
    feet: "feet",
    meter: "meters",
    meters: "meters",
    metre: "meters",
    metres: "meters",
    inch: "inches",
    inches: "inches",
    centimeter: "centimeters",
    centimeters: "centimeters",
    centimetre: "centimeters",
    centimetres: "centimeters"
  };
  return aliases[normalized] || null;
}

function simpleConversionReply(text) {
  const unitPattern = "(fahrenheit|celsius|miles?|kilometers?|kilometres?|pounds?|lbs?|kilograms?|kilos?|feet|foot|meters?|metres?|inches?|centimeters?|centimetres?)";
  const patterns = [
    new RegExp(`\\b(?:convert|what is|what s|how much is)?\\s*(${NUMBER_PATTERN})\\s+${unitPattern}\\s+(?:in|to|as)\\s+${unitPattern}\\b`, "i"),
    new RegExp(`\\b(?:convert|what is|what s|how much is)?\\s*(${NUMBER_PATTERN})\\s+degrees?\\s+(fahrenheit|celsius)\\s+(?:in|to|as)\\s+(fahrenheit|celsius)\\b`, "i")
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = numberFromWords(match[1]);
    const from = canonicalUnit(match[2]);
    const to = canonicalUnit(match[3]);
    if (!Number.isFinite(amount) || !from || !to) continue;
    const converted = convertUnit(amount, from, to);
    if (!Number.isFinite(converted)) continue;
    const unit = to === "fahrenheit" ? "degrees Fahrenheit" : to === "celsius" ? "degrees Celsius" : to;
    return `It's ${trimNumber(converted)} ${unit}.`;
  }
  return null;
}

function parseRelativeTime(text) {
  const unitMs = {
    minute: 60000,
    minutes: 60000,
    min: 60000,
    mins: 60000,
    hour: 3600000,
    hours: 3600000,
    day: 86400000,
    days: 86400000,
    week: 604800000,
    weeks: 604800000
  };
  const numberPattern = "(\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)";
  const unitPattern = "(minutes?|mins?|hours?|days?|weeks?)";
  const patterns = [
    new RegExp(`\\bin\\s+${numberPattern}\\s+${unitPattern}\\b`, "i"),
    new RegExp(`\\b${numberPattern}\\s+${unitPattern}\\s+from\\s+now\\b`, "i"),
    new RegExp(`\\b${numberPattern}\\s+${unitPattern}\\s+later\\b`, "i"),
    new RegExp(`\\b${numberPattern}\\s+${unitPattern}\\s+ago\\b`, "i")
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = numberFromWords(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || !unitMs[unit]) continue;
    const sign = /\bago\b/i.test(match[0]) ? -1 : 1;
    return { offsetMs: sign * amount * unitMs[unit], amount, unit };
  }
  return null;
}

function relativeTimeReply(transcript) {
  const relative = parseRelativeTime(transcript);
  if (!relative) return null;
  const now = new Date();
  const target = new Date(now.getTime() + relative.offsetMs);
  return `It'll be ${relativeDayLabel(target, now)}${formatSpokenTime(target)}.`;
}

function isSimpleCurrentTimeQuestion(text) {
  if (parseRelativeTime(text)) return false;
  return /\b(what time is it|current time|tell me the time)\b/.test(text) ||
    /^what time$/.test(text) ||
    /^time$/.test(text);
}

function leanCommandReply(transcript, options) {
  if (!options.leanCommands || !options.voiceBrief) return null;
  const text = normalizeTranscript(transcript);
  if (!text) return null;

  const introduction = introductionReply(transcript);
  if (introduction) return introduction;

  if (/\b(what is my name|what s my name|who am i|who are you talking to)\b/.test(text)) {
    const speaker = currentSpeakerProfile();
    return { reply: `You're ${speaker.first_name}.`, command: "speaker_name_status" };
  }

  if (/\b(what did you hear|what did i say|repeat what you heard|read back what you heard)\b/.test(text)) {
    return lastHeardReply();
  }

  const correction = correctionReply(transcript);
  if (correction) return correction;

  if (/\b(cancel|stop)\b.*\b(voice task|task|background task|work)\b/.test(text)) {
    return cancelLatestVoiceTask();
  }

  if (/\b(reset|clear|restart)\b.*\b(voice context|voice session|spoken context|voice memory)\b/.test(text)) {
    return resetVoiceContext();
  }

  const handoff = voiceHandoff(text, transcript, options);
  if (handoff) return handoff;

  const longTask = longTaskHandoff(text, transcript, options);
  if (longTask) return longTask;

  const relativeTime = relativeTimeReply(text);
  if (relativeTime && /\b(time|hour|minute|later|from now|ago|in)\b/.test(text)) {
    return { reply: relativeTime, command: "relative_time" };
  }

  const math = simpleMathReply(text);
  if (math && /\b(what is|what s|calculate|plus|add|minus|subtract|times|multiplied|divided|percent)\b/.test(text)) {
    return { reply: math, command: "simple_math" };
  }

  const conversion = simpleConversionReply(text);
  if (conversion && /\b(convert|what is|what s|how much|in|to|as|degrees?|fahrenheit|celsius|miles?|kilometers?|pounds?|kilograms?|feet|meters?|inches?|centimeters?)\b/.test(text)) {
    return { reply: conversion, command: "unit_conversion" };
  }

  if (isSimpleCurrentTimeQuestion(text)) {
    return { reply: localTimeReply(), command: "local_time" };
  }
  if (/\b(what date|current date|today s date|what day is it|what is today)\b/.test(text)) {
    return { reply: localDateReply(), command: "local_date" };
  }

  const asksStatus = /\b(status|state|configured|configuration|settings?)\b/.test(text);
  if (asksStatus && /\b(voice|bella|elevenlabs|speech|tts)\b/.test(text)) {
    return { reply: voiceStatusReply(), command: "voice_status" };
  }
  if (asksStatus && /\b(push to talk|push talk|hotkey|control space|microphone|mic|listen|listening)\b/.test(text)) {
    return { reply: pushToTalkStatusReply(), command: "push_to_talk_status" };
  }
  if (/\b(what are you working on|voice task|voice tasks|background task|background tasks|task status|work status)\b/.test(text)) {
    return { reply: voiceTaskStatusReply(), command: "voice_task_status" };
  }
  return null;
}

function resetVoiceContext() {
  const sessions = readJson(MAIN_AGENT_SESSIONS_PATH, {});
  const entry = sessions?.[VOICE_SESSION_KEY] || null;
  if (!entry?.sessionId) {
    return { reply: "Voice context is already clear.", command: "voice_context_reset" };
  }

  const suffix = `.archived-by-paw-reset-${timestamp()}`;
  const transcriptPath = path.join(MAIN_AGENT_SESSIONS_DIR, `${entry.sessionId}.jsonl`);
  const archived = [];
  for (const fileName of fs.readdirSync(MAIN_AGENT_SESSIONS_DIR)) {
    const filePath = path.join(MAIN_AGENT_SESSIONS_DIR, fileName);
    if (filePath === transcriptPath || fileName.startsWith(`${entry.sessionId}.jsonl.`)) {
      const archivePath = `${filePath}${suffix}`;
      fs.renameSync(filePath, archivePath);
      archived.push(archivePath);
    }
  }

  delete sessions[VOICE_SESSION_KEY];
  writeJson(MAIN_AGENT_SESSIONS_PATH, sessions);
  return {
    reply: "Voice context reset.",
    command: "voice_context_reset",
    reset_session_id: entry.sessionId,
    archived
  };
}

function voiceHandoff(normalizedText, originalTranscript, options) {
  const patterns = [
    /^(send|route|handoff|hand off|pass)\s+(this\s+)?(to\s+)?(main|the main thread|terminal|typed thread)\s*[:,-]?\s*(.+)$/i,
    /^(continue|move)\s+(this\s+)?(in|on|to)\s+(main|the main thread|terminal|typed thread)\s*[:,-]?\s*(.+)$/i,
    /^(tell|ask)\s+(main|the main thread|terminal|typed thread)\s*[:,-]?\s*(.+)$/i
  ];
  const original = originalTranscript.trim();
  let payload = "";
  for (const pattern of patterns) {
    const match = original.match(pattern);
    if (match) {
      payload = match[match.length - 1]?.trim() || "";
      break;
    }
  }
  if (!payload && /\b(send|route|handoff|hand off|pass|continue|move|tell|ask)\b/.test(normalizedText) && /\b(main|terminal|typed thread)\b/.test(normalizedText)) {
    payload = original.replace(/^(send|route|handoff|hand off|pass|continue|move|tell|ask)\b/i, "").trim();
  }
  if (!payload) return null;

  return createMainHandoff({
    payload,
    options,
    timeout: String(options.timeout),
    command: "main_handoff",
    reply: "Sent to main.",
    prefix: `Voice handoff from ${currentSpeakerProfile().first_name} via ${VOICE_SESSION_KEY}: ${payload}`
  });
}

function shouldHandoffLongTask(normalizedText) {
  const asksWork = /\b(write|draft|document|documenting|documentation|research|investigate|look into|update|create|make|build|implement|fix|audit|summarize|organize|refactor|clean up|write up)\b/.test(normalizedText);
  if (!asksWork) return false;
  const targetWork = /\b(documentation|docs?|obsidian|note|notes|memory|overview|rule|readme|guide|research|report|summary|plan|proposal|task|workflow|system|code|file|files|project)\b/.test(normalizedText);
  const explicitDo = /\b(can you|could you|please|go ahead|start|continue|work on|take care of|handle|document everything|write up)\b/.test(normalizedText);
  return targetWork || explicitDo;
}

function longTaskHandoff(normalizedText, originalTranscript, options) {
  if (!shouldHandoffLongTask(normalizedText)) return null;
  const timeout = String(process.env.PAW_LISTEN_LONG_TASK_TIMEOUT || DEFAULT_LONG_TASK_TIMEOUT);
  const speakerName = currentSpeakerProfile().first_name;
  return createMainHandoff({
    payload: originalTranscript.trim(),
    options,
    sessionKey: LONG_TASK_SESSION_KEY,
    timeout,
    command: "long_task_handoff",
    reply: "I'll work on it.",
    prefix: [
      `Long-running voice task from ${speakerName} via ${VOICE_SESSION_KEY}.`,
      "Paw was created by Vic, founder of GlitterNGeek. Do not assume the current speaker is Vic unless the speaker introduced themself as Vic.",
      "Do the requested work asynchronously in this voice-task session. Do not answer only with a brief voice reply.",
      "When useful, summarize completion in the source conversation or hand off a concise status to the main session.",
      "If the task changes Obsidian, follow the Obsidian loading and overview-maintenance rules, then run the vault audit before reporting completion.",
      "",
      `${speakerName} said: ${originalTranscript.trim()}`
    ].join("\n")
  });
}

function createMainHandoff({ payload, options, sessionKey = MAIN_SESSION_KEY, timeout, command, reply, prefix }) {
  if (!payload) return null;

  ensureStateDir();
  const id = `main-handoff-${timestamp()}-${process.pid}`;
  const messagePath = path.join(STATE_DIR, `${id}.txt`);
  const stdoutPath = path.join(STATE_DIR, `${id}.out.log`);
  const stderrPath = path.join(STATE_DIR, `${id}.err.log`);
  const statusPath = path.join(STATE_DIR, `${id}.status.json`);
  fs.writeFileSync(messagePath, `${prefix || `Voice handoff from ${currentSpeakerProfile().first_name} via ${VOICE_SESSION_KEY}: ${payload}`}\n`, { mode: 0o600 });

  const child = spawn(process.execPath, [
    PAW_MAIN_HANDOFF_WORKER,
    OPENCLAW_BIN,
    options.agent,
    sessionKey,
    options.agentThinking || "minimal",
    timeout,
    messagePath,
    stdoutPath,
    stderrPath,
    statusPath,
    VOICE_TASKS_PATH,
    id,
    PAW_VOICE,
    DEFAULT_TASK_COMPLETION_SPEAK ? "1" : "0"
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  upsertVoiceTask({
    id,
    status: "running",
    command,
    label: taskLabel(payload),
    session_key: sessionKey,
    timeout_seconds: timeout,
    pid: child.pid || null,
    message_path: messagePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    status_path: statusPath,
    created_at: nowIso(),
    updated_at: nowIso()
  });

  return { reply, command, handoff_status: statusPath };
}

function askAgent(transcript, options) {
  if (!transcript.trim()) {
    console.error("Transcript is empty; not sending to Paw.");
    process.exit(3);
  }
  const timeoutSeconds = Number(options.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    console.error("Agent timeout must be a positive number of seconds.");
    process.exit(2);
  }

  const args = [
    "agent",
    "--agent", options.agent,
    "--json",
    "--timeout", String(options.timeout),
    "--message", voiceMessage(transcript, options)
  ];
  if (options.sessionKey) args.splice(3, 0, "--session-key", options.sessionKey);
  if (options.agentModel) args.splice(3, 0, "--model", options.agentModel);
  if (options.agentThinking) args.splice(3, 0, "--thinking", options.agentThinking);

  const started = Date.now();
  const result = spawnSync(OPENCLAW_BIN, args, {
    encoding: "utf8",
    timeout: (timeoutSeconds * 1000) + AGENT_TIMEOUT_GRACE_MS,
    killSignal: "SIGTERM"
  });
  if (result.status !== 0) {
    const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : "";
    const timedOut = result.error?.code === "ETIMEDOUT";
    const timeoutMessage = timedOut ? `openclaw agent timed out after ${options.timeout} seconds.` : "";
    const message = String(result.stderr || result.stdout || timeoutMessage || spawnError || `openclaw agent failed with exit code ${result.status || 1}.`);
    process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
    process.exit(result.status || 1);
  }
  const reply = extractAgentReply(result.stdout);
  return { raw: JSON.parse(result.stdout), reply, duration_ms: Date.now() - started };
}

function speakReply(reply, options) {
  if (!reply.trim()) return;
  const started = Date.now();
  const speechMode = options.speechMode || DEFAULT_SPEECH_MODE;
  const result = speechMode === "macos"
    ? spawnSync("/usr/bin/say", [reply], { stdio: "inherit" })
    : spawnSync("node", [
      PAW_VOICE,
      "speak",
      "--force",
      reply
    ], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
  return { duration_ms: Date.now() - started, mode: speechMode };
}

function startInstantAck(options) {
  if (!options.instantAck || !options.speakReply || !options.voiceBrief) return null;
  const text = String(options.instantAckText || "").trim();
  if (!text) return null;
  const started = Date.now();
  const child = options.speechMode === "macos"
    ? spawn("/usr/bin/say", [text], { stdio: "ignore", detached: true })
    : spawn("node", [PAW_VOICE, "speak", "--force", text], { stdio: "ignore", detached: true });
  child.unref();
  return {
    started: true,
    text,
    mode: options.speechMode || DEFAULT_SPEECH_MODE,
    launch_duration_ms: Date.now() - started
  };
}

function resolveAudio(options) {
  if (options.record) {
    const recording = recordAudio(options);
    return { file: recording.file, recorded: true, record_duration_ms: recording.duration_ms };
  }
  if (options.file) return { file: options.file, recorded: false, record_duration_ms: null };
  console.error("Provide --file audio.wav or --record.");
  process.exit(2);
}

function transcribeCommand(rawArgs) {
  const options = parseOptions(rawArgs);
  const { file, recorded, record_duration_ms: recordDurationMs } = resolveAudio(options);
  const stats = audioStats(file);
  const result = transcribeFile(file, options);
  if (recorded && !options.keep) fs.rmSync(file, { force: true });

  if (options.json) {
    console.log(JSON.stringify({ ...result, record_duration_ms: recordDurationMs, audio_stats: stats, audio_file: options.keep ? file : null }, null, 2));
  } else {
    console.log(result.transcript);
  }
}

function recordCommand(rawArgs) {
  const options = parseOptions(["--record", ...rawArgs]);
  const { file, record_duration_ms: recordDurationMs } = resolveAudio(options);
  const stats = audioStats(file);
  const result = transcribeFile(file, options);
  if (!options.keep) fs.rmSync(file, { force: true });

  if (options.json) {
    console.log(JSON.stringify({ ...result, record_duration_ms: recordDurationMs, audio_stats: stats, audio_file: options.keep ? file : null }, null, 2));
  } else {
    console.log(result.transcript);
  }
}

function askCommand(rawArgs) {
  const options = parseOptions(rawArgs);
  const { file, recorded, record_duration_ms: recordDurationMs } = resolveAudio(options);
  const stats = audioStats(file);
  const transcription = transcribeFile(file, options);
  const rejection = rejectWeakTranscript(transcription.transcript, stats);
  if (rejection) {
    console.error(`${rejection.title}: ${rejection.hint}`);
    console.error(`Transcript rejected: ${rejection.reason}`);
    if (recorded && (options.keep || KEEP_REJECTED_AUDIO)) {
      console.error(`Rejected audio file: ${file}`);
      console.error(`Audio stats: ${JSON.stringify(stats)}`);
    } else if (recorded) {
      fs.rmSync(file, { force: true });
    }
    process.exit(3);
  }
  if (recorded && !options.keep) fs.rmSync(file, { force: true });
  const corrected = correctedTranscript(transcription.transcript);
  const fastReply = fastVoiceReply(corrected, options);
  const leanCommand = fastReply ? null : leanCommandReply(corrected, options);
  if (!["last_heard", "transcript_correction"].includes(leanCommand?.command)) {
    rememberTranscript(transcription.transcript, corrected);
  }
  const instantAck = fastReply || leanCommand ? null : startInstantAck(options);
  const agentResult = fastReply
    ? { raw: null, reply: fastReply, duration_ms: 0, fast_reply: true }
    : leanCommand
      ? { raw: null, reply: leanCommand.reply, duration_ms: 0, lean_command: leanCommand.command }
    : askAgent(corrected, options);
  const speech = options.speakReply ? speakReply(agentResult.reply, options) : null;

  if (options.json) {
    console.log(JSON.stringify({
      transcript: transcription.transcript,
      corrected_transcript: corrected === transcription.transcript ? null : corrected,
      transcription_provider: transcription.provider || options.sttProvider || "whisper",
      transcription_model: transcription.model,
      transcription_duration_ms: transcription.duration_ms,
      transcription_confidence: transcription.confidence ?? null,
      transcription_words: transcription.words ?? null,
      record_duration_ms: recordDurationMs,
      agent_duration_ms: agentResult.duration_ms,
      fast_reply: Boolean(agentResult.fast_reply),
      lean_command: agentResult.lean_command || null,
      instant_ack: Boolean(instantAck?.started),
      instant_ack_mode: instantAck?.mode || null,
      instant_ack_launch_duration_ms: instantAck?.launch_duration_ms ?? null,
      speech_duration_ms: speech?.duration_ms || null,
      speech_mode: speech?.mode || null,
      total_duration_ms: [recordDurationMs, transcription.duration_ms, agentResult.duration_ms, speech?.duration_ms]
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0),
      audio_stats: stats,
      reply: agentResult.reply,
      agent: options.agent,
      agent_thinking: options.agentThinking || null,
      voice_brief: options.voiceBrief,
      voice_max_words: options.voiceMaxWords,
      audio_file: options.keep ? file : null
    }, null, 2));
  } else {
    console.log(agentResult.reply);
  }
}

function rejectWeakTranscript(transcript, stats) {
  const normalized = transcript.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
  const words = normalized ? normalized.split(" ") : [];
  const weakAudio =
    (stats.max_volume_db !== null && stats.max_volume_db < -35) ||
    (stats.mean_volume_db !== null && stats.mean_volume_db < -50) ||
    (stats.silence_ratio !== null && stats.silence_ratio > 0.7);
  const likelyWhisperHallucination =
    normalized === "" ||
    normalized === "you" ||
    normalized === "me" ||
    normalized === "you and" ||
    normalized === "thank you" ||
    normalized === "thanks for watching" ||
    /^[.\s]+$/.test(transcript.trim());

  if (likelyWhisperHallucination && weakAudio) {
    return {
      title: "Paw did not hear speech",
      hint: "Try again closer to the microphone or switch input devices.",
      reason: `weak audio plus likely hallucinated transcript (${JSON.stringify(transcript)})`
    };
  }
  if (words.length <= 1 && weakAudio) {
    return {
      title: "Paw heard too little speech",
      hint: "Try a longer phrase after the start cue.",
      reason: `single-word transcript from weak audio (${JSON.stringify(transcript)})`
    };
  }
  return null;
}

function benchmarkCommand(rawArgs) {
  const options = parseOptions(rawArgs);
  if (!options.file) {
    console.error("Provide --file audio.wav for benchmark.");
    process.exit(2);
  }
  const models = options.models?.length ? options.models : DEFAULT_BENCHMARK_MODELS;
  const results = models.map((model) => {
    const result = transcribeFile(options.file, { ...options, model });
    return {
      model,
      duration_ms: result.duration_ms,
      transcript: result.transcript
    };
  });

  if (options.json) {
    console.log(JSON.stringify({ file: options.file, language: options.language, results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`\n[${result.model}] ${result.duration_ms}ms`);
      console.log(result.transcript);
    }
  }
}

function diagnoseCommand(rawArgs) {
  const options = parseOptions(["--record", "--keep", "--json", ...rawArgs]);
  playCue("Glass");
  spawnSync("sleep", ["0.4"]);
  const { file, record_duration_ms: recordDurationMs } = resolveAudio(options);
  const stats = audioStats(file);
  const models = options.models?.length ? options.models : DEFAULT_BENCHMARK_MODELS;
  const results = models.map((model) => {
    const result = transcribeFile(file, { ...options, model });
    return {
      model,
      duration_ms: result.duration_ms,
      transcript: result.transcript
    };
  });
  const diagnosis = {
    ok: true,
    recorded_at: new Date().toISOString(),
    device: options.device,
    resolved_device: resolveInputDevice(options.device, { quiet: true }),
    duration_seconds_requested: options.duration,
    record_duration_ms: recordDurationMs,
    audio_file: file,
    audio_stats: stats,
    results,
    hints: diagnosticHints(stats, results)
  };
  ensureStateDir();
  fs.writeFileSync(LAST_DIAGNOSIS_PATH, `${JSON.stringify(diagnosis, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(diagnosis, null, 2));
}

function diagnosticHints(stats, results) {
  const hints = [];
  if (stats.bytes < 20000) hints.push("Recording file is very small; ffmpeg may not be capturing usable audio.");
  if (stats.max_volume_db !== null && stats.max_volume_db < -35) hints.push("Peak volume is very low; try a different microphone device or move closer.");
  if (stats.silence_ratio !== null && stats.silence_ratio > 0.75) hints.push("Recording is mostly silence at -45 dB; check input device and speak after the start cue.");
  const transcripts = results.map((item) => item.transcript.trim().toLowerCase()).filter(Boolean);
  if (transcripts.length === 0) hints.push("All transcription models returned empty text.");
  if (transcripts.every((text) => text === "you" || text === "me")) hints.push("Whisper is likely hallucinating from weak/silent audio rather than hearing the phrase.");
  if (new Set(transcripts).size > 1) hints.push("Models disagree on the transcript; keep this audio file for model comparison.");
  return hints;
}

switch (command) {
  case "status":
    status();
    break;
  case "devices":
    listDevices();
    break;
  case "transcribe":
    transcribeCommand(args.slice(1));
    break;
  case "record":
    recordCommand(args.slice(1));
    break;
  case "ask":
    askCommand(args.slice(1));
    break;
  case "benchmark":
    benchmarkCommand(args.slice(1));
    break;
  case "diagnose":
    diagnoseCommand(args.slice(1));
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    usage();
    process.exit(2);
}
