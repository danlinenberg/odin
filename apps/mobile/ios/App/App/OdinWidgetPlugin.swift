import Capacitor
import UIKit

/// The lock screen widget's side of the screens (renderer/mobile/widget.ts):
/// `update` saves the end times the board shows for the widget, and
/// `pushToken` hands back this phone's APNs token and bundle ID, which the
/// screens send Odin so it can push new counts with the phone locked.
@objc(OdinWidgetPlugin)
public class OdinWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdinWidgetPlugin"
    public let jsName = "OdinWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushToken", returnType: CAPPluginReturnPromise),
    ]

    @objc func update(_ call: CAPPluginCall) {
        let ended = (call.getArray("ended") ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }
        EndedStore.save(ended)
        call.resolve()
    }

    @objc func pushToken(_ call: CAPPluginCall) {
        PushToken.request { result in
            switch result {
            case .success(let token):
                call.resolve(["token": token, "topic": Bundle.main.bundleIdentifier ?? ""])
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }
    }
}

/// The APNs token, asked for once per launch. Silent pushes need no
/// permission prompt; the AppDelegate reports what iOS answers.
enum PushToken {
    private static var token: String?
    private static var waiting: [(Result<String, Error>) -> Void] = []

    static func request(_ done: @escaping (Result<String, Error>) -> Void) {
        DispatchQueue.main.async {
            if let token { return done(.success(token)) }
            waiting.append(done)
            if waiting.count == 1 { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    static func finish(_ result: Result<String, Error>) {
        DispatchQueue.main.async {
            if case .success(let value) = result { token = value }
            let callbacks = waiting
            waiting = []
            callbacks.forEach { $0(result) }
        }
    }
}
