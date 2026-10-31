import Foundation
import WidgetKit

/// The lock screen widget's data, in the App Group the app and the widget
/// share: the end times (ms) of the sessions whose turn ended in the last hour
/// and still wait on you (shared/recently-ended.ts). The app writes it from
/// the board it loads (OdinWidgetPlugin.swift) and from Odin's silent push
/// (AppDelegate.swift); the widget only reads it. In both targets.
enum EndedStore {
    /// RECENTLY_ENDED_MS in shared/recently-ended.ts.
    static let window: TimeInterval = 60 * 60
    static let kind = "OdinEnded"

    /// group.$(ODIN_BUNDLE_ID), from each target's Info.plist.
    private static var defaults: UserDefaults? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "OdinAppGroup") as? String else {
            return nil
        }
        return UserDefaults(suiteName: group)
    }

    static func save(_ ended: [Double]) {
        defaults?.set(ended, forKey: "ended")
        WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }

    static func load() -> [Date] {
        (defaults?.array(forKey: "ended") as? [Double] ?? [])
            .map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// How many are still inside the hour at `date`.
    static func count(_ ended: [Date], at date: Date) -> Int {
        ended.filter { date.timeIntervalSince($0) < window }.count
    }
}
