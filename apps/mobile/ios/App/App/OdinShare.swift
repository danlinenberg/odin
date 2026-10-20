import Capacitor
import Photos
import UIKit

/// Images shared to Odin from the share sheet (OdinShareExtension): `take`
/// hands them to the app once, as base64 JPEGs, and clears the pasteboard.
@objc(OdinSharePlugin)
public class OdinSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdinSharePlugin"
    public let jsName = "OdinShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "latestScreenshot", returnType: CAPPluginReturnPromise),
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

    /// The newest screenshot in Photos, as a base64 JPEG: the camera button
    /// by the reply box attaches it with no picker.
    @objc func latestScreenshot(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            guard status == .authorized || status == .limited else {
                return call.reject("Odin can't see your photos. Allow it in Settings, Odin, Photos.")
            }
            let options = PHFetchOptions()
            options.predicate = NSPredicate(
                format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = 1
            guard let asset = PHAsset.fetchAssets(with: .image, options: options).firstObject else {
                return call.reject("No screenshots yet. Take one, then tap the camera.")
            }
            let request = PHImageRequestOptions()
            request.isNetworkAccessAllowed = true
            request.deliveryMode = .highQualityFormat
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: request) { data, _, _, _ in
                guard let data, let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) else {
                    return call.reject("Odin couldn't read the screenshot.")
                }
                call.resolve(["image": jpeg.base64EncodedString()])
            }
        }
    }
}
