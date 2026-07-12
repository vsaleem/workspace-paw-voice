import Carbon
import Foundation
import AppKit

let logPath = "/tmp/paw-push-to-talk-hotkey.log"
let environment = ProcessInfo.processInfo.environment
let workspace = environment["OPENCLAW_WORKSPACE"] ?? FileManager.default.currentDirectoryPath
let nativeApp = environment["PAW_NATIVE_APP"] ?? "\(workspace)/tools/Paw Push To Talk Native.app"
let app = NSApplication.shared
let mode = environment["PAW_PUSH_TO_TALK_MODE"] ?? "normal"
let target = environment["PAW_PUSH_TO_TALK_TARGET"] ?? "voice"
let speechMode = environment["PAW_PUSH_TO_TALK_SPEECH_MODE"] ?? "elevenlabs"

func appendLog(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logPath),
           let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) {
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: logPath), options: .atomic)
        }
    }
}

func fourCharCode(_ string: String) -> OSType {
    var result: OSType = 0
    for scalar in string.unicodeScalars.prefix(4) {
        result = (result << 8) + OSType(scalar.value)
    }
    return result
}

func shellQuote(_ value: String) -> String {
    return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

func appleScriptString(_ value: String) -> String {
    let escaped = value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
}

func launchPawPushToTalk() {
    appendLog("hotkey pressed")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [
        "-n",
        nativeApp,
        "--args",
        "--mode",
        mode,
        "--target",
        target,
        "--speech-mode",
        speechMode
    ]
    do {
        appendLog("opening native app=\(nativeApp) mode=\(mode) target=\(target) speech_mode=\(speechMode)")
        try process.run()
    } catch {
        appendLog("launch failed: \(error.localizedDescription)")
    }
}

let eventHandler: EventHandlerUPP = { _, event, _ in
    guard let event else { return noErr }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    if status == noErr && hotKeyID.id == 1 {
        launchPawPushToTalk()
    }
    return noErr
}

var eventType = EventTypeSpec(
    eventClass: OSType(kEventClassKeyboard),
    eventKind: UInt32(kEventHotKeyPressed)
)

let installStatus = InstallEventHandler(
    GetApplicationEventTarget(),
    eventHandler,
    1,
    &eventType,
    nil,
    nil
)

if installStatus != noErr {
    appendLog("failed to install event handler: \(installStatus)")
    exit(1)
}

var hotKeyRef: EventHotKeyRef?
var hotKeyID = EventHotKeyID(signature: fourCharCode("PPTK"), id: 1)
let registerStatus = RegisterEventHotKey(
    UInt32(kVK_Space),
    UInt32(controlKey),
    hotKeyID,
    GetApplicationEventTarget(),
    0,
    &hotKeyRef
)

if registerStatus != noErr {
    appendLog("failed to register control-space: \(registerStatus)")
    exit(2)
}

app.setActivationPolicy(.accessory)
appendLog("listener started: Control+Space")
app.run()
