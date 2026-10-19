import AVFoundation
import Capacitor
import Speech

/// The app's bridge, with Odin's own plugins registered on it.
class OdinViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(OdinSpeechPlugin())
        bridge?.registerPluginInstance(OdinKeychainPlugin())
        bridge?.registerPluginInstance(OdinSharePlugin())
    }
}

/// The reply box's mic: iOS speech recognition, on the phone. `start` records,
/// `stop` ends it and answers with what was heard. No server, no account.
@objc(OdinSpeechPlugin)
public class OdinSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdinSpeechPlugin"
    public let jsName = "OdinSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var heard = ""
    private var finished: ((String) -> Void)?

    @objc func start(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                return call.reject("Speech recognition is off for Odin: Settings > Odin.")
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    return call.reject("The microphone is off for Odin: Settings > Odin.")
                }
                DispatchQueue.main.async {
                    do {
                        try self.record(words: call.getArray("words", String.self) ?? [])
                        call.resolve()
                    } catch {
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    /// Words the recognizer gets wrong without a hint: names and tech terms.
    /// The app adds the ones on the board (titles, repos, people).
    private static let vocabulary = [
        "Odin", "Claude", "Claude Code", "Huginn", "EC2", "GraphQL", "PR",
        "pull request", "Terraform", "SSM", "AWS", "S3", "Jira", "Slack",
        "Notion", "GitHub", "CI", "API", "repo", "worktree", "TypeScript",
        "TestFlight", "relay", "brief", "TL;DR",
    ]

    private func record(words: [String]) throws {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw NSError(domain: "OdinSpeech", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognition isn't available right now.",
            ])
        }
        task?.cancel()
        heard = ""
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        // Apple caps how many hints help; the board's own words come first.
        request.contextualStrings = Array((words + Self.vocabulary).prefix(100))
        if #available(iOS 16, *) { request.addsPunctuation = true }
        self.request = request
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()
        task = recognizer.recognitionTask(with: request) { result, error in
            if let result { self.heard = result.bestTranscription.formattedString }
            if error != nil || result?.isFinal == true { self.finish() }
        }
    }

    private func finish() {
        DispatchQueue.main.async {
            self.finished?(self.heard)
            self.finished = nil
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.engine.isRunning else { return call.resolve(["text": self.heard]) }
            self.finished = { text in call.resolve(["text": text]) }
            self.engine.stop()
            self.engine.inputNode.removeTap(onBus: 0)
            self.request?.endAudio()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.finish() }
        }
    }
}
