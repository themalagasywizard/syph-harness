import SwiftUI

/// How a thread's state reads: a coloured dot and a short label.
struct ThreadStateBadge: View {
    var state: String
    private var info: (String, Color) {
        switch state {
        case "queued": return ("Queued", Palette.faint)
        case "working": return ("Working", Palette.accent)
        case "blocked": return ("Needs you", Palette.warn)
        case "review_ready": return ("Ready for review", Palette.ok)
        case "failed": return ("Failed", Palette.err)
        case "stopped": return ("Stopped", Palette.faint)
        default: return ("Done", Palette.ok)
        }
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(info.1).frame(width: 7, height: 7)
            Text(info.0).font(.caption.weight(.medium)).foregroundStyle(state == "blocked" ? Palette.warn : Palette.muted)
        }
        .fixedSize()
    }
}

/// The card a coordinator chat shows when one of its threads ends or needs you. Tap to open the thread.
struct ThreadUpdateCard: View {
    @Environment(AppModel.self) private var app
    var update: ThreadUpdate
    var body: some View {
        Button { Haptic.tap(); app.openChat(update.threadId) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.triangle.branch").font(.footnote).foregroundStyle(Palette.muted)
                    Text(update.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                    Spacer(minLength: 6)
                    ThreadStateBadge(state: update.state)
                }
                Text(update.summary).font(.subheadline).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
                if let n = update.needs, n != update.summary {
                    Text(n).font(.footnote).foregroundStyle(Palette.warn).multilineTextAlignment(.leading)
                }
                HStack(spacing: 12) {
                    if let f = update.filesChanged, f > 0 { Label("\(f) file\(f == 1 ? "" : "s")", systemImage: "doc") }
                    Spacer(minLength: 0)
                    Text("Open thread").fontWeight(.semibold).foregroundStyle(Palette.accent)
                }
                .font(.caption).foregroundStyle(Palette.faint)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.stroke))
        }
        .buttonStyle(.pressable)
    }
}
