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
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
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

    /// A picture of Odin's screen as it is now, as a base64 JPEG: the + menu
    /// attaches it to the reply.
    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                return call.reject("Odin couldn't take the screenshot.")
            }
            let target = view.window ?? view
            let image = UIGraphicsImageRenderer(bounds: target.bounds).image { _ in
                target.drawHierarchy(in: target.bounds, afterScreenUpdates: true)
            }
            guard let jpeg = image.jpegData(compressionQuality: 0.85) else {
                return call.reject("Odin couldn't take the screenshot.")
            }
            call.resolve(["image": jpeg.base64EncodedString()])
        }
    }
}
