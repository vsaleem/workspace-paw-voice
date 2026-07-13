#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const SERVICE_NAME = "Paw Push To Talk";
const WORKFLOW_BUNDLE_ID = process.env.PAW_WORKFLOW_BUNDLE_ID || "dev.openclaw.paw.push-to-talk.workflow";
const SERVICE_KEY = `${WORKFLOW_BUNDLE_ID} - Paw Push To Talk - runWorkflowAsService`;
const SERVICES_DIR = path.join(os.homedir(), "Library", "Services");
const WORKFLOW_DIR = path.join(SERVICES_DIR, `${SERVICE_NAME}.workflow`);
const CONTENTS_DIR = path.join(WORKFLOW_DIR, "Contents");
const INFO_PLIST = path.join(CONTENTS_DIR, "Info.plist");
const DOCUMENT_WFLOW = path.join(CONTENTS_DIR, "document.wflow");
const LAUNCHER = path.join(WORKSPACE, "tools", "paw-push-to-talk.command");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(WORKFLOW_BUNDLE_ID)}</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(SERVICE_NAME)}</string>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${xmlEscape(SERVICE_NAME)}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict/>
    </dict>
  </array>
</dict>
</plist>
`;
}

function documentWorkflow() {
  const command = `${LAUNCHER} >> /tmp/paw-push-to-talk.log 2>&1 &`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict/>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>${xmlEscape(command)}</string>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>inputMethod</key>
          <integer>0</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
      </dict>
      <key>isViewVisible</key>
      <true/>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>applicationBundleIDsByPath</key>
    <dict/>
    <key>inputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>outputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>presentationMode</key>
    <integer>15</integer>
    <key>processesInput</key>
    <false/>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

function runPlutil(file) {
  const result = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

function shortcutStatus() {
  const result = spawnSync("defaults", ["read", "pbs", "NSServicesStatus"], { encoding: "utf8" });
  const text = result.status === 0 ? result.stdout : "";
  const serviceStart = text.indexOf(`"${SERVICE_KEY}"`);
  if (serviceStart === -1) {
    return {
      service_key: SERVICE_KEY,
      hotkey_set: false,
      key_equivalent: null,
      enabled_services_menu: false
    };
  }

  const serviceEnd = text.indexOf("\n    };", serviceStart);
  const block = text.slice(serviceStart, serviceEnd === -1 ? undefined : serviceEnd);
  const keyMatch = block.match(/"key_equivalent" = "([^"]*)";/);
  const enabledMatch = block.match(/"enabled_services_menu" = ([01]);/);

  return {
    service_key: SERVICE_KEY,
    hotkey_set: Boolean(keyMatch?.[1]),
    key_equivalent: keyMatch?.[1] || null,
    enabled_services_menu: enabledMatch?.[1] === "1"
  };
}

function setControlSpace() {
  const result = spawnSync("defaults", [
    "write",
    "pbs",
    "NSServicesStatus",
    "-dict-add",
    SERVICE_KEY,
    "{ enabled_services_menu = 1; key_equivalent = \"^ \"; }"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }

  spawnSync("/System/Library/CoreServices/pbs", ["-flush"], { stdio: "ignore" });
  console.log(JSON.stringify({
    ok: true,
    service_name: SERVICE_NAME,
    hotkey: "Control + Space",
    ...shortcutStatus()
  }, null, 2));
}

function install() {
  if (!fs.existsSync(LAUNCHER)) {
    console.error(`Missing launcher: ${LAUNCHER}`);
    process.exit(2);
  }

  fs.mkdirSync(CONTENTS_DIR, { recursive: true });
  fs.writeFileSync(INFO_PLIST, infoPlist());
  fs.writeFileSync(DOCUMENT_WFLOW, documentWorkflow());
  runPlutil(INFO_PLIST);
  runPlutil(DOCUMENT_WFLOW);

  console.log(JSON.stringify({
    ok: true,
    service_name: SERVICE_NAME,
    workflow: WORKFLOW_DIR,
    launcher: LAUNCHER,
    ...shortcutStatus(),
    next_step: "Assign a keyboard shortcut in System Settings > Keyboard > Keyboard Shortcuts > Services > General."
  }, null, 2));
}

function status() {
  const exists = fs.existsSync(INFO_PLIST) && fs.existsSync(DOCUMENT_WFLOW);
  console.log(JSON.stringify({
    ok: exists,
    service_name: SERVICE_NAME,
    workflow: WORKFLOW_DIR,
    info_plist: INFO_PLIST,
    document_wflow: DOCUMENT_WFLOW,
    launcher: LAUNCHER,
    ...shortcutStatus()
  }, null, 2));
  process.exit(exists ? 0 : 1);
}

const command = process.argv[2] || "install";
if (command === "install") {
  install();
} else if (command === "set-control-space") {
  setControlSpace();
} else if (command === "status") {
  status();
} else {
  console.error("Usage: node tools/install-paw-push-to-talk-trigger.mjs [install|status|set-control-space]");
  process.exit(2);
}
