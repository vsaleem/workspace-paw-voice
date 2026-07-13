#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(SCRIPT_DIR, "..");
const SOURCE = path.join(WORKSPACE, "tools", "paw-push-to-talk-app.swift");
const APP = path.join(WORKSPACE, "tools", "Paw Push To Talk Native.app");
const CONTENTS = path.join(APP, "Contents");
const MACOS = path.join(CONTENTS, "MacOS");
const EXECUTABLE = path.join(MACOS, "PawPushToTalk");
const PLIST = path.join(CONTENTS, "Info.plist");
const BUNDLE_ID = process.env.PAW_NATIVE_BUNDLE_ID || "dev.openclaw.paw.push-to-talk.native";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${command} failed\n`);
    process.exit(result.status || 1);
  }
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>PawPushToTalk</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Paw Push To Talk Native</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Paw records your spoken push-to-talk request so it can transcribe and answer it.</string>
</dict>
</plist>
`;
}

fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(MACOS, { recursive: true });
fs.writeFileSync(PLIST, plist());
run("swiftc", [
  SOURCE,
  "-framework", "AppKit",
  "-framework", "AVFoundation",
  "-o", EXECUTABLE
]);
fs.chmodSync(EXECUTABLE, 0o755);
run("plutil", ["-lint", PLIST]);
run("codesign", ["--force", "--sign", "-", APP]);

console.log(JSON.stringify({ ok: true, app: APP, executable: EXECUTABLE }, null, 2));
