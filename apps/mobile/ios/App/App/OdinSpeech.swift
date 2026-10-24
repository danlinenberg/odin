import AppIntents
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
    /// What earlier recognitions in this recording heard.
    private var said = ""
    /// The current recognition's text so far.
    private var part = ""
    private var hints: [String] = []
    private var recognizer: SFSpeechRecognizer?
    /// Recognitions in a row that heard nothing: a cap, so one that fails at
    /// once can't spin. A round that hears words resets it, so a long
    /// dictation with many pauses keeps going.
    private var rounds = 0
    private var finished: ((String) -> Void)?
    /// The iOS 26 recording (Transcription), while one runs.
    private var modern: AnyObject?

    /// The Action Button's press (ToggleDictationIntent), handed to the screens,
    /// which start or stop the reply box's mic.
    override public func load() {
        NotificationCenter.default.addObserver(
            forName: .odinToggleDictation, object: nil, queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("action", data: [:])
        }
    }

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
                    let words = call.getArray("words", String.self) ?? []
                    if #available(iOS 26.0, *) {
                        Task { @MainActor in
                            // iOS 26's long-form model, when it has the language;
                            // else the older recognizer below.
                            if let locale = await Transcription.locale() {
                                do {
                                    self.heard = ""
                                    let recording = Transcription()
                                    try await recording.start(
                                        locale: locale,
                                        hints: Array((words + Self.vocabulary).prefix(100))
                                    ) { [weak self] text in
                                        self?.heard = text
                                        self?.notifyListeners("partial", data: ["text": text])
                                    }
                                    self.modern = recording
                                    return call.resolve()
                                } catch {
                                    // Its model couldn't load: the older recognizer still can.
                                }
                            }
                            self.startLegacy(call, words: words)
                        }
                        return
                    }
                    self.startLegacy(call, words: words)
                }
            }
        }
    }

    private func startLegacy(_ call: CAPPluginCall, words: [String]) {
        do {
            try record(words: words)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
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
        said = ""
        part = ""
        rounds = 0
        hints = Array((words + Self.vocabulary).prefix(100))
        self.recognizer = recognizer
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            self.request?.append(buffer)
        }
        engine.prepare()
        try engine.start()
        listen()
    }

    /// One recognition over the running mic. iOS ends one on a pause or after
    /// about a minute; while you're still recording, the next one picks up and
    /// what was said so far stays.
    private func listen() {
        guard let recognizer, rounds < 30 else { return }
        rounds += 1
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        // Apple caps how many hints help; the board's own words come first.
        request.contextualStrings = hints
        if #available(iOS 16, *) { request.addsPunctuation = true }
        // On the phone when it can: faster, and no network round trip.
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                if let result {
                    let part = result.bestTranscription.formattedString
                    if !part.isEmpty { self.rounds = 0 }
                    // After a pause, iOS can start the text over in the same
                    // recognition: keep what came before it.
                    if Self.startedOver(part, after: self.part) {
                        self.said = [self.said, self.part].filter { !$0.isEmpty }.joined(separator: " ")
                    }
                    self.part = part
                    self.heard = [self.said, part].filter { !$0.isEmpty }.joined(separator: " ")
                    self.notifyListeners("partial", data: ["text": self.heard])
                }
                guard error != nil || result?.isFinal == true else { return }
                if self.engine.isRunning && self.finished == nil {
                    self.said = self.heard
                    self.part = ""
                    self.listen()
                } else {
                    self.finish()
                }
            }
        }
    }

    /// A new text that doesn't continue the last one: shorter, and either not
    /// how it began or less than half as long. A revision drops a word or two;
    /// a restart that happens to open with the same word ("I") drops the rest.
    static func startedOver(_ text: String, after last: String) -> Bool {
        guard !text.isEmpty, text.count < last.count else { return false }
        if last.count >= 12 && text.count * 2 < last.count { return true }
        let head = { (s: String) in String(s.lowercased().prefix(6)) }
        return !last.lowercased().hasPrefix(head(text))
    }

    private func finish() {
        DispatchQueue.main.async {
            self.finished?(self.heard)
            self.finished = nil
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if #available(iOS 26.0, *), let recording = self.modern as? Transcription {
                self.modern = nil
                Task { @MainActor in
                    let text = await recording.stop()
                    self.heard = text
                    call.resolve(["text": text])
                }
                return
            }
            guard self.engine.isRunning else { return call.resolve(["text": self.heard]) }
            self.finished = { text in call.resolve(["text": text]) }
            self.engine.stop()
            self.engine.inputNode.removeTap(onBus: 0)
            self.request?.endAudio()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.finish() }
        }
    }
}

/// One recording on iOS 26's SpeechAnalyzer: the long-form model Notes and
/// Voice Memos use, on the phone, far closer than SFSpeechRecognizer on long
/// dictation. It keeps going through pauses on its own; finished phrases add
/// up, and the one still being heard is shown live after them.
@available(iOS 26.0, *)
@MainActor
final class Transcription {
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var reader: Task<Void, Never>?
    private var done = ""
    private var volatile = ""

    var text: String { (done + volatile).trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The phone's language, if the model has it.
    static func locale() async -> Locale? {
        guard SpeechTranscriber.isAvailable else { return nil }
        return await SpeechTranscriber.supportedLocale(equivalentTo: .current)
    }

    func start(locale: Locale, hints: [String], onText: @escaping (String) -> Void) async throws {
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        // The language's model, once per phone: a download the first time.
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await install.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "OdinSpeech", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognition can't use the microphone's audio.",
            ])
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let context = AnalysisContext()
        context.contextualStrings[.general] = hints
        try? await analyzer.setContext(context)
        let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        self.input = input
        reader = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let words = String(result.text.characters)
                    if result.isFinal {
                        self.done += words
                        self.volatile = ""
                    } else {
                        self.volatile = words
                    }
                    onText(self.text)
                }
            } catch {}
        }
        try await analyzer.start(inputSequence: stream)

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let node = engine.inputNode
        let micFormat = node.outputFormat(forBus: 0)
        let converter = AVAudioConverter(from: micFormat, to: format)
        node.removeTap(onBus: 0)
        node.installTap(onBus: 0, bufferSize: 4096, format: micFormat, block: Self.feed(input, converter, format))
        engine.prepare()
        try engine.start()
    }

    /// The mic's buffers in the model's format, off the main thread.
    private nonisolated static func feed(
        _ input: AsyncStream<AnalyzerInput>.Continuation,
        _ converter: AVAudioConverter?,
        _ format: AVAudioFormat
    ) -> AVAudioNodeTapBlock {
        return { buffer, _ in
            guard let converter else {
                input.yield(AnalyzerInput(buffer: buffer))
                return
            }
            let ratio = format.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
        }
    }

    /// Stops the mic and waits for the last phrase - at most 2s, so a stuck
    /// model can't hold the reply box.
    func stop() async -> String {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        input?.finish()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        let reader = self.reader
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await reader?.value }
            group.addTask { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            await group.next()
            group.cancelAll()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return text
    }
}

extension Notification.Name {
    static let odinToggleDictation = Notification.Name("OdinToggleDictation")
}

/// What the Action Button runs once you pick it there (Settings > Action
/// Button > Shortcut > Odin): starts or stops dictation in the reply box.
/// Only while Odin is on screen - iOS gives the button to one action for the
/// whole phone, and a press anywhere else does nothing.
@available(iOS 16.0, *)
struct ToggleDictationIntent: AppIntent {
    static var title: LocalizedStringResource = "Start or stop dictation"
    static var description = IntentDescription(
        "Starts or stops dictation in Odin's reply box. Does nothing when Odin isn't open."
    )
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult {
        let onScreen = UIApplication.shared.connectedScenes.contains {
            $0.activationState == .foregroundActive
                || $0.activationState == .foregroundInactive
        }
        if onScreen {
            NotificationCenter.default.post(name: .odinToggleDictation, object: nil)
        }
        return .result()
    }
}

/// Lists the action in Shortcuts and the Action Button's picker, no setup needed.
@available(iOS 16.0, *)
struct OdinShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ToggleDictationIntent(),
            phrases: ["Dictate in \(.applicationName)"],
            shortTitle: "Dictate",
            systemImageName: "mic"
        )
    }
}
