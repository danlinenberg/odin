import UIKit
import UniformTypeIdentifiers

/// "Odin" in the share sheet: takes the screenshots or photos you shared and
/// leaves them on a pasteboard only Odin's own apps can read (the same team).
/// Odin picks them up when it opens and asks which session they're for
/// (OdinShare.swift, renderer/mobile/share.tsx). Nothing leaves the phone here.
class ShareViewController: UIViewController {
    /// Also in OdinShare.swift: the pasteboard both sides use.
    static let pasteboard = "odin.shared-images"

    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.055, green: 0.055, blue: 0.067, alpha: 1)
        label.text = "Adding to Odin…"
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .headline)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await share() }
    }

    private func share() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        var images: [Data] = []
        for provider in providers.prefix(5) {
            if let data = await imageData(provider) { images.append(data) }
        }
        guard !images.isEmpty, let board = UIPasteboard(name: .init(Self.pasteboard), create: true) else {
            return finish("Odin couldn't read that image.")
        }
        board.items = images.map { ["public.jpeg": $0] }
        finish("Added. Open Odin to choose the session.")
    }

    /// The image as JPEG: a screenshot arrives as a file URL, a UIImage or data.
    private func imageData(_ provider: NSItemProvider) async -> Data? {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else {
            return nil
        }
        let image: UIImage?
        switch item {
        case let url as URL: image = UIImage(contentsOfFile: url.path)
        case let picture as UIImage: image = picture
        case let data as Data: image = UIImage(data: data)
        default: image = nil
        }
        return image?.jpegData(compressionQuality: 0.85)
    }

    private func finish(_ message: String) {
        DispatchQueue.main.async {
            self.label.text = message
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }
}
