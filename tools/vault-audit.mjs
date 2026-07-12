#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "Obsidian Vault");
const DEFAULT_WORKSPACE = process.cwd();
const DEFAULT_OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const vaultRoot = path.resolve(positionalArgs[0] || process.env.OBSIDIAN_VAULT || DEFAULT_VAULT);
const workspaceRoot = path.resolve(process.env.OPENCLAW_WORKSPACE || DEFAULT_WORKSPACE);
const openclawConfigPath = path.resolve(process.env.OPENCLAW_CONFIG_PATH || DEFAULT_OPENCLAW_CONFIG);
const today = formatLocalDate(new Date());

const requiredFrontmatter = ["type", "owner", "status", "last_verified"];
const requiredOverviewSections = [
  "## 1. Folder Purpose",
  "## 2. Folder Scope",
  "## 3. File Index",
  "## 4. Key Decisions",
  "## 5. Current Operating Instructions",
  "## 6. Related Folders",
  "## 7. Maintenance Notes"
];
const workspaceLeakPatterns = [
  /Vic values memory, depth, and execution/i,
  /GNG Business Manager was updated/i,
  /Slack low-risk internal send channels/i,
  /Live Slack delivery for GNG Business Manager/i,
  /Paw posted a `?#gng-project-launch-trio`? recovery checkpoint/i,
  /Geek is intended to be a future agent/i
];

const issues = [];
const warnings = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function isHiddenOrConfig(filePath) {
  const rel = path.relative(vaultRoot, filePath);
  return rel.split(path.sep).some((part) => part.startsWith("."));
}

function isMarkdown(filePath) {
  return filePath.endsWith(".md");
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { data: {}, raw: "", body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, raw: "", body: text };
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4);
  const data = {};
  let currentKey = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue) {
      currentKey = keyValue[1];
      data[currentKey] = keyValue[2].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (currentKey && /^\s+-\s+/.test(line)) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      if (!Array.isArray(data[currentKey])) data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
      data[currentKey].push(value);
    }
  }
  return { data, raw, body };
}

function wikiTargets(text) {
  const targets = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(text))) targets.push(match[1].trim());
  return targets;
}

function canonicalNoteName(filePath) {
  return path.basename(filePath, ".md");
}

function noteExists(target, markdownFiles, fromFile) {
  const normalized = target.replace(/\\/g, "/").replace(/\.md$/i, "");
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const fromDir = path.dirname(fromFile);
    const resolved = path.resolve(fromDir, normalized);
    if (markdownFiles.includes(`${resolved}.md`) || markdownFiles.includes(resolved)) return true;
  }
  for (const file of markdownFiles) {
    const relNoExt = path.relative(vaultRoot, file).replace(/\\/g, "/").replace(/\.md$/i, "");
    const base = canonicalNoteName(file);
    if (relNoExt === normalized || base === normalized || relNoExt.endsWith(`/${normalized}`)) return true;
  }
  return false;
}

function folderHasMarkdown(folder, markdownFiles) {
  return markdownFiles.some((file) => path.dirname(file) === folder);
}

function folderContainsMarkdownDeep(folder, markdownFiles) {
  return markdownFiles.some((file) => file.startsWith(folder + path.sep));
}

function isStale(notePath, overviewPath) {
  const noteDay = formatLocalDate(new Date(fs.statSync(notePath).mtimeMs));
  const overview = parseFrontmatter(read(overviewPath)).data;
  const lastVerified = String(overview.last_verified || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(lastVerified) && noteDay > lastVerified;
}

function auditVault() {
  if (!fs.existsSync(vaultRoot)) {
    issues.push(`Vault does not exist: ${vaultRoot}`);
    return;
  }

  const allFiles = walk(vaultRoot);
  const markdownFiles = allFiles.filter((file) => isMarkdown(file) && !isHiddenOrConfig(file));
  const markdownSet = new Set(markdownFiles);
  const rootOverview = path.join(vaultRoot, "Paw Memory Overview.md");
  if (!fs.existsSync(rootOverview)) issues.push("Missing root Paw Memory Overview.md");

  for (const file of markdownFiles) {
    const rel = path.relative(vaultRoot, file);
    const text = read(file);
    const { data } = parseFrontmatter(text);
    for (const key of requiredFrontmatter) {
      if (!data[key]) issues.push(`${rel}: missing frontmatter key '${key}'`);
    }
    if (data.status && !["active", "draft", "archived", "reference"].includes(String(data.status))) {
      warnings.push(`${rel}: unusual status '${data.status}'`);
    }
    if (data.last_verified && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.last_verified))) {
      issues.push(`${rel}: last_verified must be YYYY-MM-DD`);
    }
    for (const target of wikiTargets(text)) {
      if (!noteExists(target, markdownFiles, file)) issues.push(`${rel}: broken wiki link [[${target}]]`);
    }
  }

  const dirs = new Set(markdownFiles.map((file) => path.dirname(file)));
  for (const dir of dirs) {
    if (dir === vaultRoot) continue;
    if (!folderHasMarkdown(dir, markdownFiles)) continue;
    const overviewPath = path.join(dir, "_Overview.md");
    const relDir = path.relative(vaultRoot, dir);
    if (!fs.existsSync(overviewPath)) {
      issues.push(`${relDir}: missing _Overview.md`);
      continue;
    }
    const overviewText = read(overviewPath);
    for (const section of requiredOverviewSections) {
      if (!overviewText.includes(section)) issues.push(`${path.relative(vaultRoot, overviewPath)}: missing section '${section}'`);
    }
    const siblingNotes = markdownFiles.filter((file) => path.dirname(file) === dir && path.basename(file) !== "_Overview.md");
    for (const note of siblingNotes) {
      const name = canonicalNoteName(note);
      if (!overviewText.includes(`[[${name}`) && !overviewText.includes(name)) {
        issues.push(`${path.relative(vaultRoot, overviewPath)}: missing File Index entry for '${name}'`);
      }
      if (isStale(note, overviewPath)) {
        issues.push(`${path.relative(vaultRoot, overviewPath)}: stale; '${name}' modified after overview last_verified`);
      }
    }
  }

  const topLevelDirs = fs.readdirSync(vaultRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(vaultRoot, entry.name));
  for (const dir of topLevelDirs) {
    if (!folderContainsMarkdownDeep(dir, markdownFiles)) continue;
    const overview = path.join(dir, "_Overview.md");
    if (!fs.existsSync(overview)) issues.push(`${path.relative(vaultRoot, dir)}: top-level folder missing _Overview.md`);
  }

  const rootText = fs.existsSync(rootOverview) ? read(rootOverview) : "";
  for (const dir of topLevelDirs) {
    if (!folderContainsMarkdownDeep(dir, markdownFiles)) continue;
    const name = path.basename(dir);
    if (!rootText.includes(`[[${name}/_Overview`) && !rootText.includes(`${name}/_Overview`)) {
      issues.push(`Paw Memory Overview.md: missing folder index entry for '${name}'`);
    }
  }
}

function auditWorkspace() {
  const candidates = ["MEMORY.md", "SLACK.md", "USER.md", "AGENTS.md"].map((file) => path.join(workspaceRoot, file));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const rel = path.relative(workspaceRoot, file);
    const text = read(file);
    if (!text.includes("Obsidian") && rel !== "AGENTS.md") {
      issues.push(`${rel}: workspace pointer does not identify Obsidian as canonical`);
    }
    for (const pattern of workspaceLeakPatterns) {
      if (pattern.test(text)) issues.push(`${rel}: contains durable memory-like content that belongs in Obsidian`);
    }
  }
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    issues.push("workspace .gitignore missing");
  } else {
    const gitignore = read(gitignorePath);
    for (const required of ["MEMORY.md", "memory/", "SLACK.md", "GNG_BUSINESS_MANAGER_AUDIT.md", "obsidian-export/"]) {
      if (!gitignore.includes(required)) issues.push(`workspace .gitignore missing '${required}'`);
    }
  }
}

function auditOpenClawConfig() {
  if (!fs.existsSync(openclawConfigPath)) {
    warnings.push(`OpenClaw config not found: ${openclawConfigPath}`);
    return;
  }
  let config;
  try {
    config = JSON.parse(read(openclawConfigPath));
  } catch (error) {
    issues.push(`OpenClaw config is not valid JSON: ${openclawConfigPath}`);
    return;
  }
  const memorySearch = config.agents?.defaults?.memorySearch;
  const extraPaths = Array.isArray(memorySearch?.extraPaths) ? memorySearch.extraPaths : [];
  const normalizedExtraPaths = extraPaths
    .filter((entry) => typeof entry === "string")
    .map((entry) => path.resolve(entry.replace(/^~(?=$|\/)/, process.env.HOME || "")));
  if (!normalizedExtraPaths.includes(vaultRoot)) {
    issues.push(`OpenClaw memorySearch.extraPaths must include Obsidian vault: ${vaultRoot}`);
  }
  if (memorySearch?.provider !== "local") {
    warnings.push("OpenClaw memorySearch.provider is not 'local'; memory search may depend on external billing/quota");
  }
}

auditVault();
auditWorkspace();
auditOpenClawConfig();

const result = {
  ok: issues.length === 0,
  checked_at: today,
  vault: vaultRoot,
  workspace: workspaceRoot,
  openclaw_config: openclawConfigPath,
  issues,
  warnings
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Vault audit: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`Vault: ${vaultRoot}`);
  console.log(`Workspace: ${workspaceRoot}`);
  if (issues.length) {
    console.log("\nIssues:");
    for (const issue of issues) console.log(`- ${issue}`);
  }
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

process.exit(result.ok ? 0 : 1);
