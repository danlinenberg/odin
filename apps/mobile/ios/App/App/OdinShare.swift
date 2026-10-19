import Capacitor
import UIKit

/// Images shared to Odin from the share sheet (OdinShareExtension): `take`
/// hands them to the app once, as base64 JPEGs, and clears the pasteboard.
@objc(OdinSharePlugin)
public class OdinSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdinSharePlugin"
    public let jsName = "OdinShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    /// Also in ShareViewController.swift.
    private static let pasteboard = "odin.shared-images"

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let board = UIPasteboard(name: .init(Self.pasteboard), create: false) else {
                return call.resolve(["images": []])
            }
            let images = board.items.compactMap { $0["public.jpeg"] as? Data }
                .map { $0.base64EncodedString() }
            board.items = []
            call.resolve(["images": images])
        }
    }
}
