#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(WORKSPACE, ".openclaw", "paw-voice");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const LOG_PATH = path.join(STATE_DIR, "usage.jsonl");
const VOICE_CATALOG_PATH = path.join(STATE_DIR, "voice-catalog.json");
const VOICE_RATINGS_PATH = path.join(STATE_DIR, "voice-ratings.json");
const SECRETS_DIR = path.join(os.homedir(), ".openclaw", "secrets");
const DEFAULT_KEY_FILE = path.join(SECRETS_DIR, "elevenlabs-api-key");
const DEFAULT_MODEL = "eleven_flash_v2_5";
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || process.env.PAW_VOICE || "Sarah";
const DEFAULT_VOICE_ROTATION = ["Sarah", "River", "Matilda"];
const PRICE_PER_1K_CHARS_USD = 0.05;

const args = process.argv.slice(2);
const command = args[0] || "help";

const sensitivePatterns = [
  /\b(api[-_ ]?key|secret|token|password|passcode|credential)s?\b/i,
  /\b(contract|pricing|invoice|legal|lawsuit|termination|firing|hiring)\b/i,
  /\b(client|customer|lead|prospect)\b/i,
  /\bprivate slack|dm|direct message\b/i,
  /\bcheckout|deployment|deploy|launch approval|public[- ]facing\b/i
];

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function defaultState() {
  return {
    enabled: true,
    quiet_until: null,
    quiet_hours: { start: 23, end: 8 },
    mode: "summaries-only",
    max_chars: 900,
    voice: DEFAULT_VOICE,
    alternate_voice: null,
    voice_mode: "fixed",
    voice_rotation: DEFAULT_VOICE_ROTATION,
    voice_rotation_index: 0,
    audition_mode: true,
    last_voice: null,
    model: DEFAULT_MODEL,
    api_key_file: process.env.ELEVENLABS_API_KEY_FILE || DEFAULT_KEY_FILE
  };
}

function readState() {
  ensureStateDir();
  if (!fs.existsSync(STATE_PATH)) {
    const state = defaultState();
    writeState(state);
    return state;
  }
  return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureStateDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function usage() {
  console.log(`Paw Voice

Usage:
  node tools/paw-voice.mjs status
  node tools/paw-voice.mjs on
  node tools/paw-voice.mjs off
  node tools/paw-voice.mjs quiet [minutes]
  node tools/paw-voice.mjs voices [--limit 100]
  node tools/paw-voice.mjs refresh-voices
  node tools/paw-voice.mjs current-voice
  node tools/paw-voice.mjs set-voice NAME_OR_ID
  node tools/paw-voice.mjs set-alternate-voice NAME_OR_ID
  node tools/paw-voice.mjs voice-mode fixed|rotate
  node tools/paw-voice.mjs set-rotation VOICE [VOICE...]
  node tools/paw-voice.mjs set-premade-rotation
  node tools/paw-voice.mjs set-saved-rotation
  node tools/paw-voice.mjs audition-mode on|off
  node tools/paw-voice.mjs rate-voice 1-5 "notes"
  node tools/paw-voice.mjs shortlist-voice "notes"
  node tools/paw-voice.mjs skip-voice "notes"
  node tools/paw-voice.mjs audition-summary
  node tools/paw-voice.mjs estimate "Text to estimate"
  node tools/paw-voice.mjs speak [--dry-run] [--force] [--voice NAME_OR_ID] [--alternate] "Safe summary"
  node tools/paw-voice.mjs speak-result [--dry-run] [--force] [--alternate] "What changed"
  node tools/paw-voice.mjs speak-status [--dry-run] [--force] [--alternate] "Current status"
  node tools/paw-voice.mjs speak-blocker [--dry-run] [--force] [--alternate] "What is blocked"
  node tools/paw-voice.mjs speak-audit [--dry-run] [--force] [--alternate] "Audit result"
  node tools/paw-voice.mjs speak-choice [--dry-run] [--force] [--alternate] "Decision needed"

Rules:
  - Speaks local summaries only.
  - Refuses sensitive text.
  - Respects quiet hours unless --force is supplied.
  - Requires ELEVENLABS_API_KEY, ELEVENLABS_API_KEY_FILE, or ${DEFAULT_KEY_FILE} for real speech.
`);
}

function parseOptions(rawArgs) {
  const options = {
    dryRun: false,
    force: false,
    alternate: false,
    voice: null,
    textParts: []
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--alternate") {
      options.alternate = true;
    } else if (arg === "--voice") {
      options.voice = rawArgs[++i] || "";
    } else {
      options.textParts.push(arg);
    }
  }
  return options;
}

function estimateCost(text) {
  const chars = [...text].length;
  return {
    chars,
    estimated_cost_usd: Number(((chars / 1000) * PRICE_PER_1K_CHARS_USD).toFixed(4))
  };
}

function readVoiceCatalog() {
  return readJson(VOICE_CATALOG_PATH, {});
}

function voiceLabel(voice) {
  const catalog = readVoiceCatalog();
  const entry = catalog[voice] || Object.values(catalog).find((item) => item.name === voice);
  return entry ? `${entry.name} (${entry.id})` : voice;
}

function nextRotationVoice(state) {
  if (state.voice_mode === "rotate" && Array.isArray(state.voice_rotation) && state.voice_rotation.length > 0) {
    const index = Number.isInteger(state.voice_rotation_index) ? state.voice_rotation_index : 0;
    return state.voice_rotation[index % state.voice_rotation.length];
  }
  return state.voice || DEFAULT_VOICE;
}

function localHour() {
  return Number(new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: "America/Chicago"
  }).format(new Date()));
}

function isQuietHours(state) {
  const hour = localHour();
  const { start, end } = state.quiet_hours;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function quietUntilActive(state) {
  if (!state.quiet_until) return false;
  return Date.now() < Date.parse(state.quiet_until);
}

function hasSensitiveText(text) {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

function expandHome(filePath) {
  if (!filePath) return null;
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function isInsideDirectory(filePath, directory) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedDirectory, resolvedFile);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function configuredKeyFile(state) {
  const rawPath = process.env.ELEVENLABS_API_KEY_FILE || state.api_key_file || DEFAULT_KEY_FILE;
  const keyFile = path.resolve(expandHome(rawPath));
  if (!isInsideDirectory(keyFile, SECRETS_DIR)) return null;
  return keyFile;
}

function isValidElevenLabsKey(value) {
  return /^[A-Za-z0-9_-]{20,200}$/.test(String(value || "").trim());
}

function safeElevenLabsApiKey(state) {
  const envKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (envKey) return isValidElevenLabsKey(envKey) ? envKey : null;

  const keyFile = configuredKeyFile(state);
  if (!keyFile || !fs.existsSync(keyFile)) return null;

  const stat = fs.statSync(keyFile);
  if (!stat.isFile() || stat.size > 1024) return null;

  const key = fs.readFileSync(keyFile, "utf8").trim();
  return isValidElevenLabsKey(key) ? key : null;
}

function hasConfiguredElevenLabsKeySource(state) {
  if (process.env.ELEVENLABS_API_KEY) return isValidElevenLabsKey(process.env.ELEVENLABS_API_KEY);
  const keyFile = configuredKeyFile(state);
  return Boolean(keyFile && fs.existsSync(keyFile) && fs.statSync(keyFile).isFile());
}

function publicStatus(state) {
  return {
    enabled: state.enabled,
    quiet_until: state.quiet_until,
    quiet_hours: state.quiet_hours,
    mode: state.mode,
    max_chars: state.max_chars,
    voice: state.voice,
    alternate_voice: state.alternate_voice,
    voice_mode: state.voice_mode,
    voice_rotation_count: Array.isArray(state.voice_rotation) ? state.voice_rotation.length : 0,
    voice_rotation_index: state.voice_rotation_index,
    audition_mode: state.audition_mode,
    last_voice: state.last_voice,
    model: state.model,
    api_key_configured: hasConfiguredElevenLabsKeySource(state),
    api_key_file: configuredKeyFile(state) ? "configured" : null
  };
}

function hasElevenLabsKey() {
  const state = readState();
  return Boolean(safeElevenLabsApiKey(state));
}

function sagAuthArgs(state) {
  if (process.env.ELEVENLABS_API_KEY) return [];
  const keyFile = configuredKeyFile(state);
  if (keyFile && fs.existsSync(keyFile)) return ["--api-key-file", keyFile];
  return [];
}

function elevenLabsApiKey(state) {
  return safeElevenLabsApiKey(state);
}

function appendLog(entry) {
  ensureStateDir();
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

async function refreshVoices() {
  const state = readState();
  const apiKey = elevenLabsApiKey(state);
  if (!apiKey) {
    console.error("Missing ElevenLabs API key. Set ELEVENLABS_API_KEY or ELEVENLABS_API_KEY_FILE.");
    process.exit(5);
  }
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    // The local secret file contains an ElevenLabs API key, and this request sends it only to ElevenLabs.
    // codeql[js/file-access-to-http-request]
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) {
    console.error(`ElevenLabs voices request failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  const body = await response.json();
  const catalog = {};
  for (const voice of body.voices || []) {
    catalog[voice.voice_id] = {
      id: voice.voice_id,
      name: voice.name,
      category: voice.category,
      description: voice.description || "",
      labels: voice.labels || {},
      sharing_status: voice.sharing?.status || null
    };
  }
  writeJson(VOICE_CATALOG_PATH, catalog);
  console.log(`Saved ${Object.keys(catalog).length} voices to ${VOICE_CATALOG_PATH}`);
}

function resolveVoice(state, explicitVoice, useAlternate = false) {
  if (explicitVoice) return explicitVoice;
  if (useAlternate) return state.alternate_voice || state.voice || DEFAULT_VOICE;
  if (state.voice_mode === "rotate" && Array.isArray(state.voice_rotation) && state.voice_rotation.length > 0) {
    return nextRotationVoice(state);
  }
  return state.voice || DEFAULT_VOICE;
}

function advanceRotation(state, explicitVoice) {
  if (explicitVoice) return;
  if (state.voice_mode !== "rotate" || !Array.isArray(state.voice_rotation) || state.voice_rotation.length === 0) return;
  const index = Number.isInteger(state.voice_rotation_index) ? state.voice_rotation_index : 0;
  state.voice_rotation_index = (index + 1) % state.voice_rotation.length;
}

function currentVoice() {
  const state = readState();
  const voice = nextRotationVoice(state);
  console.log(JSON.stringify({
    voice,
    label: voiceLabel(voice),
    alternate_voice: state.alternate_voice || null,
    alternate_label: state.alternate_voice ? voiceLabel(state.alternate_voice) : null,
    mode: state.voice_mode,
    rotation_index: state.voice_rotation_index,
    last_voice: state.last_voice || null
  }, null, 2));
}

function listVoices(rawArgs) {
  const state = readState();
  const limitIndex = rawArgs.indexOf("--limit");
  const limit = limitIndex >= 0 ? rawArgs[limitIndex + 1] || "100" : "100";
  if (!hasElevenLabsKey()) {
    console.error("Missing ElevenLabs API key. Set ELEVENLABS_API_KEY or ELEVENLABS_API_KEY_FILE.");
    process.exit(5);
  }
  const result = spawnSync("sag", [
    "voices",
    ...sagAuthArgs(state),
    "--limit", limit
  ], { stdio: "inherit" });
  process.exit(result.status || 0);
}

function voiceIdsByCategory(predicate) {
  const catalog = readVoiceCatalog();
  return Object.values(catalog)
    .filter(predicate)
    .map((entry) => entry.id);
}

function setCatalogRotation(label, voices) {
  if (voices.length === 0) {
    console.error(`No ${label} voices found. Run: node tools/paw-voice.mjs refresh-voices`);
    process.exit(2);
  }
  const state = readState();
  state.voice_rotation = voices;
  state.voice_rotation_index = 0;
  state.voice_mode = "rotate";
  state.last_voice = null;
  writeState(state);
  console.log(`Paw voice rotation set to ${label} voices:`);
  for (const voice of voices) {
    console.log(`- ${voiceLabel(voice)}`);
  }
}

function setPremadeRotation() {
  setCatalogRotation("premade/free", voiceIdsByCategory((entry) => entry.category === "premade"));
}

function setSavedRotation() {
  setCatalogRotation("saved/non-premade", voiceIdsByCategory((entry) => entry.category && entry.category !== "premade"));
}

const speechIntros = {
  result: "Done.",
  status: "Status update.",
  blocker: "I hit a blocker.",
  audit: "Audit complete.",
  choice: "Decision needed."
};

function operationalText(kind, text) {
  const intro = speechIntros[kind];
  if (!intro) return text;
  return `${intro} ${text}`;
}

function speak(rawArgs, kind = "summary") {
  const state = readState();
  const options = parseOptions(rawArgs);
  const text = options.textParts.join(" ").trim();
  const voice = resolveVoice(state, options.voice, options.alternate);
  const label = voiceLabel(voice);
  const bodyText = operationalText(kind, text);
  const spokenText = state.audition_mode && !options.voice && !options.alternate ? `This is ${label}. ${bodyText}` : bodyText;
  const estimate = estimateCost(spokenText);

  if (!text) {
    console.error("No text provided.");
    process.exit(2);
  }
  if (estimate.chars > state.max_chars) {
    console.error(`Refusing to speak ${estimate.chars} chars; configured max is ${state.max_chars}.`);
    process.exit(2);
  }
  if (!state.enabled && !options.force) {
    console.error("Paw voice is off. Run: node tools/paw-voice.mjs on");
    process.exit(3);
  }
  if ((isQuietHours(state) || quietUntilActive(state)) && !options.force) {
    console.error("Paw voice is quiet right now. Re-run with --force if this is intentional.");
    process.exit(3);
  }
  if (hasSensitiveText(text)) {
    console.error("Refusing to speak potentially sensitive text.");
    process.exit(4);
  }
  if (!options.dryRun && !hasElevenLabsKey()) {
    console.error("Missing ElevenLabs API key. Set ELEVENLABS_API_KEY or ELEVENLABS_API_KEY_FILE.");
    process.exit(5);
  }

  const event = {
    at: new Date().toISOString(),
    mode: state.mode,
    kind,
    voice,
    voice_label: label,
    model: state.model,
    chars: estimate.chars,
    estimated_cost_usd: estimate.estimated_cost_usd,
    dry_run: options.dryRun
  };

  if (options.dryRun) {
    advanceRotation(state, options.voice);
    state.last_voice = { voice, label, at: event.at, dry_run: true };
    writeState(state);
    console.log(JSON.stringify({ ok: true, would_speak: spokenText, ...event }, null, 2));
    return;
  }

  const result = spawnSync("sag", [
    "speak",
    ...sagAuthArgs(state),
    "--model-id", state.model,
    "--stability", "0.5",
    "--similarity", "0.75",
    "--style", "0",
    "--normalize", "auto",
    "--lang", "en",
    "--voice", voice,
    spokenText
  ], { stdio: "inherit" });

  if (result.status !== 0) process.exit(result.status || 1);
  advanceRotation(state, options.voice);
  state.last_voice = { voice, label, at: event.at, dry_run: false };
  writeState(state);
  appendLog(event);
}

function readRatings() {
  return readJson(VOICE_RATINGS_PATH, { ratings: [], shortlist: [], skipped: [] });
}

function auditionTarget(state) {
  const voice = state.last_voice?.voice || nextRotationVoice(state);
  return { voice, label: voiceLabel(voice) };
}

function rateVoice(rawArgs) {
  const rating = Number(rawArgs[0]);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    console.error("Rating must be a number from 1 to 5.");
    process.exit(2);
  }
  const notes = rawArgs.slice(1).join(" ").trim();
  const state = readState();
  const target = auditionTarget(state);
  const ratings = readRatings();
  ratings.ratings.push({ at: new Date().toISOString(), ...target, rating, notes });
  writeJson(VOICE_RATINGS_PATH, ratings);
  console.log(`Rated ${target.label}: ${rating}/5${notes ? ` - ${notes}` : ""}`);
}

function shortlistVoice(rawArgs) {
  const notes = rawArgs.join(" ").trim();
  const state = readState();
  const target = auditionTarget(state);
  const ratings = readRatings();
  if (!ratings.shortlist.some((entry) => entry.voice === target.voice)) {
    ratings.shortlist.push({ at: new Date().toISOString(), ...target, notes });
  }
  writeJson(VOICE_RATINGS_PATH, ratings);
  console.log(`Shortlisted ${target.label}${notes ? ` - ${notes}` : ""}`);
}

function skipVoice(rawArgs) {
  const notes = rawArgs.join(" ").trim();
  const state = readState();
  const target = auditionTarget(state);
  const ratings = readRatings();
  if (!ratings.skipped.some((entry) => entry.voice === target.voice)) {
    ratings.skipped.push({ at: new Date().toISOString(), ...target, notes });
  }
  const oldRotation = state.voice_rotation || [];
  const removedIndex = oldRotation.indexOf(target.voice);
  const newRotation = oldRotation.filter((voice) => voice !== target.voice);
  let nextIndex = Number.isInteger(state.voice_rotation_index) ? state.voice_rotation_index : 0;

  if (removedIndex >= 0 && removedIndex < nextIndex) {
    nextIndex -= 1;
  }
  state.voice_rotation = newRotation;
  state.voice_rotation_index = newRotation.length === 0 ? 0 : ((nextIndex % newRotation.length) + newRotation.length) % newRotation.length;
  writeState(state);
  writeJson(VOICE_RATINGS_PATH, ratings);
  console.log(`Skipped ${target.label}${notes ? ` - ${notes}` : ""}`);
}

function auditionSummary() {
  const ratings = readRatings();
  const state = readState();
  console.log(JSON.stringify({
    rotation_remaining: state.voice_rotation?.length || 0,
    last_voice: state.last_voice || null,
    ratings_count: ratings.ratings.length,
    shortlist: ratings.shortlist,
    skipped: ratings.skipped
  }, null, 2));
}

function setQuiet(minutesRaw) {
  const state = readState();
  const minutes = Number(minutesRaw || 480);
  state.quiet_until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  writeState(state);
  console.log(`Paw voice quiet until ${state.quiet_until}`);
}

function setAuditionMode(mode) {
  if (!["on", "off"].includes(mode)) {
    console.error("Audition mode must be on or off.");
    process.exit(2);
  }
  const state = readState();
  state.audition_mode = mode === "on";
  writeState(state);
  console.log(`Paw voice audition mode ${mode}.`);
}

switch (command) {
  case "status":
    console.log(JSON.stringify(publicStatus(readState()), null, 2));
    break;
  case "on": {
    const state = readState();
    state.enabled = true;
    state.quiet_until = null;
    writeState(state);
    console.log("Paw voice enabled.");
    break;
  }
  case "off": {
    const state = readState();
    state.enabled = false;
    writeState(state);
    console.log("Paw voice disabled.");
    break;
  }
  case "quiet":
    setQuiet(args[1]);
    break;
  case "audition-mode":
    setAuditionMode(args[1]);
    break;
  case "voices":
    listVoices(args.slice(1));
    break;
  case "refresh-voices":
    await refreshVoices();
    break;
  case "current-voice":
    currentVoice();
    break;
  case "set-voice": {
    const voice = args.slice(1).join(" ").trim();
    if (!voice) {
      console.error("Voice name or ID required.");
      process.exit(2);
    }
    const state = readState();
    state.voice = voice;
    state.voice_mode = "fixed";
    state.last_voice = null;
    writeState(state);
    console.log(`Paw voice set to ${voiceLabel(voice)}.`);
    break;
  }
  case "set-alternate-voice": {
    const voice = args.slice(1).join(" ").trim();
    if (!voice) {
      console.error("Voice name or ID required.");
      process.exit(2);
    }
    const state = readState();
    state.alternate_voice = voice;
    writeState(state);
    console.log(`Paw alternate voice set to ${voiceLabel(voice)}.`);
    break;
  }
  case "voice-mode": {
    const mode = args[1];
    if (!["fixed", "rotate"].includes(mode)) {
      console.error("Voice mode must be fixed or rotate.");
      process.exit(2);
    }
    const state = readState();
    state.voice_mode = mode;
    writeState(state);
    console.log(`Paw voice mode set to ${mode}.`);
    break;
  }
  case "set-rotation": {
    const voices = args.slice(1).map((entry) => entry.trim()).filter(Boolean);
    if (voices.length === 0) {
      console.error("At least one rotation voice is required.");
      process.exit(2);
    }
    const state = readState();
    state.voice_rotation = voices;
    state.voice_rotation_index = 0;
    state.voice_mode = "rotate";
    state.last_voice = null;
    writeState(state);
    console.log(`Paw voice rotation set to: ${voices.join(", ")}`);
    break;
  }
  case "set-saved-rotation":
    setSavedRotation();
    break;
  case "set-premade-rotation":
    setPremadeRotation();
    break;
  case "rate-voice":
    rateVoice(args.slice(1));
    break;
  case "shortlist-voice":
    shortlistVoice(args.slice(1));
    break;
  case "skip-voice":
    skipVoice(args.slice(1));
    break;
  case "audition-summary":
    auditionSummary();
    break;
  case "estimate": {
    const text = args.slice(1).join(" ").trim();
    console.log(JSON.stringify(estimateCost(text), null, 2));
    break;
  }
  case "speak":
    speak(args.slice(1));
    break;
  case "speak-result":
    speak(args.slice(1), "result");
    break;
  case "speak-status":
    speak(args.slice(1), "status");
    break;
  case "speak-blocker":
    speak(args.slice(1), "blocker");
    break;
  case "speak-audit":
    speak(args.slice(1), "audit");
    break;
  case "speak-choice":
    speak(args.slice(1), "choice");
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
