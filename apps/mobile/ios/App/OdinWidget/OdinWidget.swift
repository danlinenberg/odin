import SwiftUI
import WidgetKit

/// The Odin widget on the lock screen: how many sessions ended in the last
/// hour and wait on you. A tap opens the app on that list (odin://ended).
@main
struct OdinWidgetBundle: WidgetBundle {
    var body: some Widget {
        EndedWidget()
    }
}

struct EndedEntry: TimelineEntry {
    let date: Date
    let count: Int
}

struct EndedProvider: TimelineProvider {
    func placeholder(in context: Context) -> EndedEntry {
        EndedEntry(date: Date(), count: 2)
    }

    func getSnapshot(in context: Context, completion: @escaping (EndedEntry) -> Void) {
        let now = Date()
        completion(EndedEntry(date: now, count: EndedStore.count(EndedStore.load(), at: now)))
    }

    /// An entry now, then one as each session passes the hour and drops off,
    /// so the count goes down with no app or push. A new end reloads it.
    func getTimeline(in context: Context, completion: @escaping (Timeline<EndedEntry>) -> Void) {
        let now = Date()
        let ended = EndedStore.load()
        let drops = ended.map { $0.addingTimeInterval(EndedStore.window) }
            .filter { $0 > now }
            .sorted()
        let entries = ([now] + drops).map {
            EndedEntry(date: $0, count: EndedStore.count(ended, at: $0))
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

struct EndedView: View {
    @Environment(\.widgetFamily) private var family
    let entry: EndedEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            Text(entry.count == 1 ? "1 session ended" : "\(entry.count) sessions ended")
        default:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                    Text("\(entry.count)")
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .minimumScaleFactor(0.6)
                }
            }
            .accessibilityLabel(
                entry.count == 1 ? "1 Odin session ended" : "\(entry.count) Odin sessions ended"
            )
        }
    }
}

struct EndedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: EndedStore.kind, provider: EndedProvider()) { entry in
            EndedView(entry: entry)
                .containerBackground(.clear, for: .widget)
                .widgetURL(URL(string: "odin://ended"))
        }
        .configurationDisplayName("Recently ended")
        .description("Odin sessions that ended in the last hour and wait on you.")
        .supportedFamilies([.accessoryCircular, .accessoryInline])
    }
}
