import AppKit
import AVFoundation
import Foundation

let environment = ProcessInfo.processInfo.environment
let workspace = environment["OPENCLAW_WORKSPACE"] ?? FileManager.default.currentDirectoryPath
let nodeExecutable = environment["PAW_NODE_BIN"] ?? "/usr/bin/env"
let wrapper = "\(workspace)/tools/paw-push-to-talk.mjs"
let stateDir = "\(workspace)/.openclaw/paw-listen"
let logPath = "/tmp/paw-push-to-talk.log"
let defaultPath = "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

struct Options {
    var mode = "normal"
    var target = "voice"
    var speechMode = ProcessInfo.processInfo.environment["PAW_PUSH_TO_TALK_SPEECH_MODE"] ?? "elevenlabs"
    var duration = 8.0
    var minDuration = envDouble("PAW_NATIVE_MIN_RECORD_SECONDS", 1.2)
    var silenceDuration = envDouble("PAW_NATIVE_SILENCE_SECONDS", 0.55)
    var speechThresholdDb = envDouble("PAW_NATIVE_SPEECH_DB", -36.0)
    var silenceThresholdDb = envDouble("PAW_NATIVE_SILENCE_DB", -40.0)
    var noSound = false
    var noNotify = false
}

struct RecordingResult {
    let duration: Double
    let stopReason: String
    let peakDb: Float
    let lastAverageDb: Float
    let lastPeakDb: Float
    let quietScore: Double
}

struct WrapperResult {
    let status: Int32
    let duration: Double
    let output: String
}

func envDouble(_ name: String, _ fallback: Double) -> Double {
    guard let raw = ProcessInfo.processInfo.environment[name],
          let value = Double(raw) else {
        return fallback
    }
    return value
}

func appendLog(_ message: String) {
    let line = "\(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    let url = URL(fileURLWithPath: logPath)
    if FileManager.default.fileExists(atPath: logPath),
       let handle = try? FileHandle(forWritingTo: url) {
        try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
        try? handle.close()
    } else {
        try? data.write(to: url, options: .atomic)
    }
}

func timestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func parseOptions() -> Options {
    var options = Options()
    let args = Array(CommandLine.arguments.dropFirst())
    var index = 0
    while index < args.count {
        let arg = args[index]
        func value() -> String {
            if index + 1 < args.count {
                index += 1
                return args[index]
            }
            return ""
        }
        switch arg {
        case "--mode":
            options.mode = value()
        case "--target":
            options.target = value()
        case "--speech-mode":
            options.speechMode = value()
        case "--duration":
            options.duration = Double(value()) ?? options.duration
        case "--min-duration":
            options.minDuration = Double(value()) ?? options.minDuration
        case "--silence-duration":
            options.silenceDuration = Double(value()) ?? options.silenceDuration
        case "--speech-db":
            options.speechThresholdDb = Double(value()) ?? options.speechThresholdDb
        case "--silence-db":
            options.silenceThresholdDb = Double(value()) ?? options.silenceThresholdDb
        case "--no-sound":
            options.noSound = true
        case "--no-notify":
            options.noNotify = true
        default:
            break
        }
        index += 1
    }
    return options
}

func playSound(_ name: String) {
    guard !name.isEmpty && name != "none" && name != "off" else { return }
    if let sound = NSSound(named: NSSound.Name(name)) {
        sound.play()
        Thread.sleep(forTimeInterval: min(sound.duration, 0.6))
    }
}

func notify(_ title: String, _ text: String) {
    let script = "display notification \(String(reflecting: text)) with title \(String(reflecting: title))"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", script]
    try? process.run()
}

func requestMicrophoneAccess() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 30)
    return granted
}

func makeAudioURL() throws -> URL {
    try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: stateDir),
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    let safeStamp = timestamp().replacingOccurrences(of: ":", with: "-")
    return URL(fileURLWithPath: "\(stateDir)/paw-native-\(safeStamp)-\(ProcessInfo.processInfo.processIdentifier).wav")
}

func recordAudio(to url: URL, options: Options) throws -> RecordingResult {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16000.0,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false
    ]
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.isMeteringEnabled = true
    recorder.prepareToRecord()
    recorder.record()
    let started = Date()
    let maxDuration = max(1.0, min(options.duration, 120.0))
    let minDuration = max(0.2, min(options.minDuration, maxDuration))
    let silenceNeeded = max(0.2, options.silenceDuration)
    var heardSpeech = false
    var quietScore = 0.0
    var peakDb = Float(-160.0)
    var lastAverageDb = Float(-160.0)
    var lastPeakDb = Float(-160.0)
    var stopReason = "max-duration"

    while true {
        Thread.sleep(forTimeInterval: 0.05)
        recorder.updateMeters()
        let average = recorder.averagePower(forChannel: 0)
        let peak = recorder.peakPower(forChannel: 0)
        lastAverageDb = average
        lastPeakDb = peak
        peakDb = max(peakDb, peak)
        let elapsed = Date().timeIntervalSince(started)

        let isSpeech = average >= Float(options.speechThresholdDb) || peak >= Float(options.speechThresholdDb + 6.0)
        let isQuiet = average <= Float(options.silenceThresholdDb)
        let isBelowSpeech = average < Float(options.speechThresholdDb) && peak < Float(options.speechThresholdDb + 6.0)

        if isSpeech {
            heardSpeech = true
            quietScore = 0
        } else if heardSpeech && elapsed >= minDuration && isQuiet {
            quietScore += 0.05
        } else if heardSpeech && elapsed >= minDuration && isBelowSpeech {
            quietScore = max(0, quietScore - 0.015)
        } else {
            quietScore = 0
        }

        if heardSpeech && elapsed >= minDuration && quietScore >= silenceNeeded {
            stopReason = "speech-then-silence"
            break
        }

        if elapsed >= maxDuration {
            stopReason = heardSpeech ? "max-duration-after-speech" : "max-duration-no-speech"
            break
        }
    }
    recorder.stop()
    return RecordingResult(
        duration: Date().timeIntervalSince(started),
        stopReason: stopReason,
        peakDb: peakDb,
        lastAverageDb: lastAverageDb,
        lastPeakDb: lastPeakDb,
        quietScore: quietScore
    )
}

func numberField(_ object: [String: Any], _ key: String) -> Double? {
    if let value = object[key] as? Double { return value }
    if let value = object[key] as? Int { return Double(value) }
    if let value = object[key] as? NSNumber { return value.doubleValue }
    return nil
}

func boolField(_ object: [String: Any], _ key: String) -> Bool? {
    if let value = object[key] as? Bool { return value }
    if let value = object[key] as? NSNumber { return value.boolValue }
    return nil
}

func stringField(_ object: [String: Any], _ key: String) -> String? {
    if let value = object[key] as? String, !value.isEmpty { return value }
    return nil
}

func logWrapperTimings(_ output: String, wrapperDuration: Double, nativeRecordDuration: Double) {
    guard let data = output.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        appendLog("[\(timestamp())] paw-push-to-talk-native timings wrapper_ms=\(Int(wrapperDuration * 1000)) parse=unavailable")
        return
    }

    let transcriptionMs = numberField(parsed, "transcription_duration_ms")
    let agentMs = numberField(parsed, "agent_duration_ms")
    let speechMs = numberField(parsed, "speech_duration_ms")
    let pipelineMs = numberField(parsed, "total_duration_ms")
    let words = numberField(parsed, "transcription_words")
    let confidence = numberField(parsed, "transcription_confidence")
    let fastReply = boolField(parsed, "fast_reply") ?? false
    let leanCommand = stringField(parsed, "lean_command") ?? "none"
    let instantAck = boolField(parsed, "instant_ack") ?? false
    let nativeRecordMs = nativeRecordDuration * 1000
    let nativeTotalMs = nativeRecordMs + (pipelineMs ?? wrapperDuration * 1000)

    let parts = [
        "native_record_ms=\(Int(nativeRecordMs.rounded()))",
        "stt_ms=\(transcriptionMs.map { String(Int($0.rounded())) } ?? "null")",
        "agent_ms=\(agentMs.map { String(Int($0.rounded())) } ?? "null")",
        "tts_ms=\(speechMs.map { String(Int($0.rounded())) } ?? "null")",
        "pipeline_ms=\(pipelineMs.map { String(Int($0.rounded())) } ?? "null")",
        "wrapper_ms=\(Int((wrapperDuration * 1000).rounded()))",
        "native_total_ms=\(Int(nativeTotalMs.rounded()))",
        "words=\(words.map { String(Int($0.rounded())) } ?? "null")",
        "confidence=\(confidence.map { String(format: "%.3f", $0) } ?? "null")",
        "fast_reply=\(fastReply)",
        "lean_command=\(leanCommand)",
        "instant_ack=\(instantAck)"
    ].joined(separator: " ")
    appendLog("[\(timestamp())] paw-push-to-talk-native timings \(parts)")
}

func runPawPushToTalk(file: URL, options: Options) -> WrapperResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodeExecutable)
    process.currentDirectoryURL = URL(fileURLWithPath: workspace)
    process.environment = ProcessInfo.processInfo.environment.merging([
        "OPENCLAW_WORKSPACE": workspace,
        "OPENCLAW_BIN": environment["OPENCLAW_BIN"] ?? "openclaw",
        "PATH": environment["PATH"] ?? defaultPath
    ]) { _, new in new }
    var arguments = [
        wrapper,
        "--file", file.path,
        "--mode", options.mode,
        "--target", options.target,
        "--speech-mode", options.speechMode,
        "--no-sound",
        "--json"
    ]
    if nodeExecutable == "/usr/bin/env" {
        arguments.insert("node", at: 0)
    }
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    let started = Date()
    do {
        try process.run()
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 && !output.isEmpty {
            appendLog(output.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return WrapperResult(
            status: process.terminationStatus,
            duration: Date().timeIntervalSince(started),
            output: output
        )
    } catch {
        appendLog("Paw native app failed to run wrapper: \(error.localizedDescription)")
        return WrapperResult(
            status: 1,
            duration: Date().timeIntervalSince(started),
            output: ""
        )
    }
}

let options = parseOptions()
appendLog("[\(timestamp())] paw-push-to-talk-native start mode=\(options.mode) target=\(options.target) speech_mode=\(options.speechMode)")

if !requestMicrophoneAccess() {
    appendLog("Paw native app microphone access denied.")
    if !options.noNotify { notify("Paw could not record", "Microphone access was denied.") }
    exit(3)
}

do {
    if !options.noSound { playSound("Glass") }
    Thread.sleep(forTimeInterval: 0.35)
    let audioURL = try makeAudioURL()
    let recording = try recordAudio(to: audioURL, options: options)
    appendLog("[\(timestamp())] paw-push-to-talk-native recorded duration=\(String(format: "%.2f", recording.duration))s reason=\(recording.stopReason) peak_db=\(String(format: "%.1f", recording.peakDb)) last_avg_db=\(String(format: "%.1f", recording.lastAverageDb)) last_peak_db=\(String(format: "%.1f", recording.lastPeakDb)) quiet_score=\(String(format: "%.2f", recording.quietScore))")
    let wrapper = runPawPushToTalk(file: audioURL, options: options)
    if wrapper.status == 0 {
        logWrapperTimings(wrapper.output, wrapperDuration: wrapper.duration, nativeRecordDuration: recording.duration)
    }
    try? FileManager.default.removeItem(at: audioURL)
    appendLog("[\(timestamp())] paw-push-to-talk-native exit \(wrapper.status)")
    exit(wrapper.status)
} catch {
    appendLog("Paw native app failed: \(error.localizedDescription)")
    if !options.noNotify { notify("Paw could not record", error.localizedDescription) }
    exit(1)
}
