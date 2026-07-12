#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(WORKSPACE, ".openclaw", "gng-model-council");
const DEFAULT_AGENT = process.env.GNG_COUNCIL_AGENT || "main";
const DEFAULT_TIMEOUT = process.env.GNG_COUNCIL_TIMEOUT || "180";
const DEFAULT_MODELS = ["openai/gpt-5.5", "sonnet"];
const DEFAULT_CHAIR = "openai/gpt-5.5";

const args = process.argv.slice(2);
const command = args[0] || "help";

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function usage() {
  console.log(`GNG Model Council

Usage:
  node tools/gng-model-council.mjs status
  node tools/gng-model-council.mjs benchmark --prompt "Question" [--models openai/gpt-5.5,sonnet] [--json]
  node tools/gng-model-council.mjs council --prompt "Question" [--models openai/gpt-5.5,sonnet] [--chair openai/gpt-5.5] [--rank] [--json]
  node tools/gng-model-council.mjs smoke

Rules:
  - Use only vetted/configured models.
  - Treat unavailable models as skipped, not fatal, unless every model fails.
  - Use council mode sparingly for high-stakes GNG decisions.
  - Do not include secrets, client private data, legal details, pricing details, or deploy credentials in prompts.
`);
}

function parseOptions(rawArgs) {
  const options = {
    prompt: "",
    models: DEFAULT_MODELS,
    chair: DEFAULT_CHAIR,
    agent: DEFAULT_AGENT,
    timeout: DEFAULT_TIMEOUT,
    rank: false,
    json: false
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--prompt") {
      options.prompt = rawArgs[++i] || "";
    } else if (arg === "--models") {
      options.models = (rawArgs[++i] || "").split(",").map((model) => model.trim()).filter(Boolean);
    } else if (arg === "--chair") {
      options.chair = rawArgs[++i] || DEFAULT_CHAIR;
    } else if (arg === "--agent") {
      options.agent = rawArgs[++i] || DEFAULT_AGENT;
    } else if (arg === "--timeout") {
      options.timeout = rawArgs[++i] || DEFAULT_TIMEOUT;
    } else if (arg === "--rank") {
      options.rank = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  return options;
}

function haveOpenClaw() {
  return spawnSync("which", ["openclaw"], { encoding: "utf8" }).status === 0;
}

function extractReply(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed?.result?.meta?.finalAssistantVisibleText ||
    parsed?.result?.payloads?.map((payload) => payload.text).filter(Boolean).join("\n").trim() ||
    "";
}

function runModel(model, prompt, options) {
  const started = Date.now();
  const cliArgs = [
    "agent",
    "--agent", options.agent,
    "--model", model,
    "--json",
    "--timeout", String(options.timeout),
    "--message", prompt
  ];
  const result = spawnSync("openclaw", cliArgs, { encoding: "utf8" });
  const durationMs = Date.now() - started;

  if (result.status !== 0) {
    return {
      model,
      ok: false,
      duration_ms: durationMs,
      error: (result.stderr || result.stdout || "model failed").trim()
    };
  }

  return {
    model,
    ok: true,
    duration_ms: durationMs,
    response: extractReply(result.stdout)
  };
}

function status() {
  const models = spawnSync("openclaw", ["models", "status"], { encoding: "utf8" });
  console.log(JSON.stringify({
    ok: haveOpenClaw() && models.status === 0,
    workspace: WORKSPACE,
    state_dir: STATE_DIR,
    default_agent: DEFAULT_AGENT,
    default_models: DEFAULT_MODELS,
    default_chair: DEFAULT_CHAIR,
    models_status: models.stdout || models.stderr || ""
  }, null, 2));
}

function requirePrompt(options) {
  if (!options.prompt.trim()) {
    console.error("Provide --prompt.");
    process.exit(2);
  }
}

function benchmark(rawArgs) {
  const options = parseOptions(rawArgs);
  requirePrompt(options);
  ensureStateDir();
  const results = options.models.map((model) => runModel(model, options.prompt, options));
  const summary = {
    ok: results.some((result) => result.ok),
    prompt_chars: [...options.prompt].length,
    results
  };
  if (!summary.ok) process.exitCode = 1;
  printResult(summary, options);
}

function anonymizedResponses(results) {
  return results.map((result, index) => ({
    label: `Response ${String.fromCharCode(65 + index)}`,
    model: result.model,
    response: result.response
  }));
}

function rankPrompt(originalPrompt, successful) {
  const responses = anonymizedResponses(successful);
  const responseText = responses.map((entry) => `${entry.label}:\n${entry.response}`).join("\n\n");
  return `You are evaluating anonymized responses to this GNG question:\n\n${originalPrompt}\n\n${responseText}\n\nEvaluate each response for accuracy, insight, operational usefulness, privacy/safety, and completeness. End with a FINAL RANKING list from best to worst using only labels like "1. Response A".`;
}

function synthesisPrompt(originalPrompt, successful, rankings) {
  const responseText = successful.map((result) => `Model: ${result.model}\nResponse:\n${result.response}`).join("\n\n");
  const rankingText = rankings.length
    ? rankings.map((result) => `Reviewer: ${result.model}\nRanking:\n${result.response || result.error}`).join("\n\n")
    : "No peer ranking stage was run.";

  return `You are Paw chairing a GNG model council. Synthesize the model responses into one concise recommendation.\n\nOriginal question:\n${originalPrompt}\n\nModel responses:\n${responseText}\n\nPeer rankings:\n${rankingText}\n\nFinal answer requirements:\n- State the recommendation.\n- Note consensus and dissent.\n- Call out risks and assumptions.\n- Keep sensitive/private details out unless explicitly present and necessary.\n- Do not pretend the council had more successful models than it did.`;
}

function council(rawArgs) {
  const options = parseOptions(rawArgs);
  requirePrompt(options);
  ensureStateDir();

  const stage1 = options.models.map((model) => runModel(model, options.prompt, options));
  const successful = stage1.filter((result) => result.ok);
  const skipped = stage1.filter((result) => !result.ok);

  if (successful.length === 0) {
    printResult({ ok: false, stage1, error: "All models failed." }, options);
    process.exit(1);
  }

  const rankings = options.rank && successful.length > 1
    ? successful.map((result) => runModel(result.model, rankPrompt(options.prompt, successful), options))
    : [];

  const final = successful.length > 1
    ? runModel(options.chair, synthesisPrompt(options.prompt, successful, rankings), options)
    : {
        model: options.chair,
        ok: true,
        duration_ms: 0,
        response: `Only one model succeeded, so council synthesis was skipped.\n\n${successful[0].response}`
      };

  const output = {
    ok: final.ok,
    prompt_chars: [...options.prompt].length,
    models_requested: options.models,
    successful_count: successful.length,
    skipped_count: skipped.length,
    stage1,
    rankings,
    final
  };
  if (!final.ok) process.exitCode = 1;
  printResult(output, options);
}

function smoke() {
  const options = {
    prompt: "Reply with exactly: GNG_COUNCIL_SMOKE_OK",
    models: ["openai/gpt-5.5"],
    chair: DEFAULT_CHAIR,
    agent: DEFAULT_AGENT,
    timeout: "90",
    rank: false,
    json: true
  };
  const result = runModel("openai/gpt-5.5", options.prompt, options);
  printResult({ ok: result.ok, result }, options);
  if (!result.ok) process.exit(1);
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.final) {
    console.log(result.final.response || result.final.error);
    if (result.skipped_count) {
      console.error(`Skipped ${result.skipped_count} unavailable model(s).`);
    }
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

switch (command) {
  case "status":
    status();
    break;
  case "benchmark":
    benchmark(args.slice(1));
    break;
  case "council":
    council(args.slice(1));
    break;
  case "smoke":
    smoke();
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
