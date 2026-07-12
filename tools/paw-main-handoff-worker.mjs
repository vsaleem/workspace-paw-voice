#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [
  openclawBin,
  agent,
  sessionKey,
  thinking,
  timeout,
  messagePath,
  stdoutPath,
  stderrPath,
  statusPath,
  tasksPath,
  taskId,
  pawVoicePath,
  speakCompletion
] = process.argv.slice(2);

function writeStatus(status) {
  fs.writeFileSync(statusPath, `${JSON.stringify({
    ...status,
    ended_at: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  if (!filePath) return;
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function finalText(stdout) {
  try {
    const parsed = JSON.parse(stdout || "{}");
    return parsed?.result?.meta?.finalAssistantVisibleText ||
      parsed?.result?.payloads?.map((payload) => payload.text).filter(Boolean).join("\n").trim() ||
      "";
  } catch {
    return "";
  }
}

function errorPreview(stderr, error) {
  const raw = String(error?.message || stderr || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (/usage limit|subscription usage limit|rate.limit|rate limit/i.test(raw)) {
    return "Model usage limit reached.";
  }
  if (/timed out|timeout/i.test(raw)) return "Task timed out.";
  return raw.slice(0, 240);
}

function updateTask(patch) {
  if (!tasksPath || !taskId) return;
  const state = readJson(tasksPath, { tasks: [] });
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return;
  tasks[index] = {
    ...tasks[index],
    ...patch,
    updated_at: new Date().toISOString()
  };
  writeJson(tasksPath, { tasks: tasks.slice(-50) });
}

function speak(text) {
  if (speakCompletion !== "1" || !pawVoicePath || !text) return;
  spawnSync(process.execPath, [pawVoicePath, "speak", "--force", text], {
    stdio: "ignore",
    timeout: 30000
  });
}

try {
  const result = spawnSync(openclawBin, [
    "agent",
    "--agent", agent,
    "--session-key", sessionKey,
    "--thinking", thinking,
    "--timeout", timeout,
    "--message-file", messagePath,
    "--json"
  ], { encoding: "utf8" });

  fs.writeFileSync(stdoutPath, result.stdout || "", { mode: 0o600 });
  fs.writeFileSync(stderrPath, result.stderr || "", { mode: 0o600 });
  const text = finalText(result.stdout);
  const ok = result.status === 0 && !result.error;
  updateTask({
    status: ok ? "complete" : "failed",
    exit_status: result.status,
    signal: result.signal,
    error: ok ? null : errorPreview(result.stderr, result.error),
    completed_at: new Date().toISOString(),
    result_preview: text ? text.slice(0, 500) : null
  });
  if (ok) speak("Voice task finished.");
  else speak("Voice task failed.");
  writeStatus({
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : null
  });
  fs.rmSync(messagePath, { force: true });
  process.exit(result.status || 0);
} catch (error) {
  fs.writeFileSync(stderrPath, String(error?.stack || error || "unknown error"), { mode: 0o600 });
  updateTask({
    status: "failed",
    exit_status: 1,
    signal: null,
    error: String(error?.message || error || "unknown error"),
    completed_at: new Date().toISOString()
  });
  speak("Voice task failed.");
  writeStatus({
    status: 1,
    signal: null,
    error: String(error?.message || error || "unknown error")
  });
  process.exit(1);
}
