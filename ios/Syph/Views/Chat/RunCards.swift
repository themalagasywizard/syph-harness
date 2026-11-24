import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// Cards a run can end with, mirroring the desktop's RunCards: out of credit, a question for you,
// a stop reason with a way to continue, the messages you sent while it worked, and attachments.

enum Billing {
    static func name(_ provider: String) -> String { Fmt.providerLabel(provider) }
    static func url(_ provider: String) -> URL? {
        switch provider {
        case "openrouter": return URL(string: "https://openrouter.ai/settings/credits")
        case "minimax": return URL(string: "https://platform.minimax.io/console/plan")
        case "gemini": return URL(string: "https://aistudio.google.com/usage")
        default: return nil
        }
    }
}

/// The provider ran out of credit: say so plainly, link to top up, offer a retry.
struct CreditsCard: View {
    @Environment(AppModel.self) private var app
    var failure: TurnFailure
    var onRetry: (() -> Void)?
    @State private var usage: ProviderUsage?

    /// A MiniMax plan that hit its window comes back on its own: say when rather than "add credits".
    private var spent: UsageMeter? {
        usage?.meters.filter { $0.total > 0 && $0.used >= $0.total }.max { ($0.resetsAt ?? 0) < ($1.resetsAt ?? 0) }
    }

    var body: some View {
        let name = Billing.name(failure.provider)
        HStack(alignment: .top, spacing: 12) {
            IconTile(system: "creditcard.fill", color: Palette.warn, size: 36)
            VStack(alignment: .leading, spacing: 6) {
                if let spent {
                    Text("You've reached your MiniMax plan limit").font(.subheadline.weight(.semibold))
                    Text("The \(spent.label.lowercased()) is used up\(spent.resetsAt.map { " and resets \(Fmt.resetsIn($0))" } ?? ""). Try again then, or add credits to keep going now. Your message is kept.")
                        .font(.footnote).foregroundStyle(Palette.muted)
                } else {
                    Text("You're out of \(name) credits").font(.subheadline.weight(.semibold))
                    Text((failure.affordable ?? 0) > 0
                         ? "What's left covers about \(Int(failure.affordable!).formatted()) tokens, which isn't enough for a reply. Top up your \(name) account, then try again. Your message is kept."
                         : "There isn't enough balance left for a reply. Top up your \(name) account, then try again. Your message is kept.")
                        .font(.footnote).foregroundStyle(Palette.muted)
                }
                HStack(spacing: 8) {
                    if let u = Billing.url(failure.provider) {
                        Link(destination: u) { Label("Add credits", systemImage: "arrow.up.right.square") }.buttonStyle(.primaryCompact)
                    }
                    if let onRetry {
                        Button { onRetry() } label: { Label("Try again", systemImage: "arrow.counterclockwise") }.buttonStyle(.tonalCompact)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.warn.opacity(0.08), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.warn.opacity(0.3)))
        .task { if failure.provider == "minimax" { usage = try? await app.backend.usage("minimax", model: nil, fresh: false) } }
    }
}

/// The agent stopped to ask you something. Tap an option, or type your own answer below.
/// A "model" question picks the model a thread starts (or carries on) with.
struct QuestionCard: View {
    @Environment(AppModel.self) private var app
    var question: UserQuestion
    var disabled: Bool
    var onAnswer: (String) -> Void
    var onPickModel: (String, Bool) -> Void
    @State private var selected: String?
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: question.kind == "model" ? "cpu" : "questionmark.bubble.fill").foregroundStyle(Palette.accent)
                Text(question.question).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
            }
            if question.kind == "model" { modelOptions } else { choiceOptions }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.accent.opacity(0.28)))
        .sheet(isPresented: $picking) {
            ModelPickerSheet(value: current) { selected = $0 }.presentationDetents([.medium, .large])
        }
    }

    private var choiceOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            FlowLayout(spacing: 8) {
                ForEach(question.options, id: \.self) { o in
                    Button { Haptic.tap(); onAnswer(o) } label: { Text(o).multilineTextAlignment(.leading) }
                        .buttonStyle(.tonalCompact)
                        .disabled(disabled)
                }
            }
            Text("Or type your own answer below.").font(.caption).foregroundStyle(Palette.faint)
        }
    }

    private var current: String {
        selected ?? question.recommendedModel ?? question.options.first { $0.contains(":") } ?? app.state?.config.defaults.chatModel ?? ""
    }

    private var modelOptions: some View {
        let d = app.state?.config.defaults
        var quick: [String] = []
        for r in question.options.filter({ $0.contains(":") }) + [d?.chatModel, d?.frontendModel].compactMap({ $0 }) where !quick.contains(r) { quick.append(r) }
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(quick, id: \.self) { ref in
                Button { Haptic.tap(); selected = ref } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(Fmt.model(ref)).font(.subheadline.weight(.medium)).foregroundStyle(Palette.text)
                            Text(ref == d?.frontendModel ? "Frontend design" : ref == d?.chatModel ? "Default · fast" : PhoneKeys.split(ref).provider)
                                .font(.caption).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        if current == ref { Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.accent) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(current == ref ? Palette.surface3 : Palette.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.pressable)
                .disabled(disabled)
            }
            HStack {
                Button("Other model…") { picking = true }.font(.footnote.weight(.semibold))
                Spacer()
                Button {
                    Haptic.success()
                    onPickModel(current, question.pendingStart == true)
                } label: {
                    Label("\(question.pendingStart == true ? "Start" : "Continue") with \(Fmt.model(current))", systemImage: "play.fill")
                }
                .buttonStyle(.primaryCompact)
                .disabled(disabled || current.isEmpty)
            }
        }
    }
}

/// Why a long run paused, with the message that carries it on.
struct StopCard: View {
    var reason: String
    var disabled: Bool
    var onContinue: (String) -> Void

    private var copy: (title: String, text: String, action: String, message: String)? {
        switch reason {
        case "budget": return ("Paused at the run budget", "Progress is saved. Continue to pick up where it stopped.", "Continue", "Continue from where you stopped. Check the progress notes first.")
        case "repeated_error": return ("Stopped: the same error came back", "Another identical attempt wouldn't help. Answer what it needs, or let it try a different way.", "Try a different approach", "Try a different approach to the error you hit. Don't repeat the same fix.")
        case "checks_failed": return ("Checks still failing", "Syph tried to fix them and stopped.", "Keep fixing", "The done-when checks are still failing. Keep fixing the cause.")
        default: return nil
        }
    }

    var body: some View {
        if let c = copy {
            VStack(alignment: .leading, spacing: 8) {
                Label(c.title, systemImage: "pause.circle.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.warn)
                Text(c.text).font(.footnote).foregroundStyle(Palette.muted)
                Button(c.action) { Haptic.tap(); onContinue(c.message) }.buttonStyle(.tonalCompact).disabled(disabled)
            }
            .card(padding: 14, radius: 20)
        }
    }
}

/// What you told it while it worked.
struct SteeringList: View {
    var items: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, t in
                Label { Text("You, while it worked: \(t)") } icon: { Image(systemName: "arrow.turn.down.right") }
                    .font(.footnote).foregroundStyle(Palette.muted)
            }
        }
    }
}

/// Files attached to a message, as small chips.
struct AttachmentChips: View {
    var items: [Attachment]
    var onRemove: ((Attachment) -> Void)?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { a in
                    HStack(spacing: 6) {
                        Image(systemName: a.kind == "image" ? "photo" : a.kind == "document" ? "doc.richtext" : "doc")
                            .font(.caption).foregroundStyle(Palette.accent)
                        Text(a.name).font(.caption.weight(.medium)).lineLimit(1).frame(maxWidth: 150)
                        if let onRemove {
                            Button { onRemove(a) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }
                                .accessibilityLabel("Remove \(a.name)")
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Palette.surface2, in: Capsule())
                    .overlay(Capsule().strokeBorder(Palette.stroke))
                }
            }
        }
    }
}

/// How much of the provider account is left, as on the desktop's usage bar.
struct UsageBar: View {
    var usage: ProviderUsage
    var compact = false

    private func tone(_ f: Double) -> Color { f >= 0.95 ? Palette.err : f >= 0.8 ? Palette.warn : Palette.ok }

    var body: some View {
        if let e = usage.error, usage.meters.isEmpty {
            if !compact { Text(e).font(.footnote).foregroundStyle(Palette.muted) }
        } else if compact, let m = usage.tightest {
            HStack(spacing: 6) {
                Capsule().fill(Palette.surface3).frame(width: 34, height: 5)
                    .overlay(alignment: .leading) { Capsule().fill(tone(m.fraction)).frame(width: 34 * m.fraction, height: 5) }
                Text(m.left).font(.caption2.monospacedDigit()).foregroundStyle(Palette.muted)
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(usage.meters, id: \.label) { m in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(m.label).font(.subheadline.weight(.medium))
                            Spacer()
                            Text("\(Int((m.fraction * 100).rounded()))% used").font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
                        }
                        ProgressView(value: m.fraction).tint(tone(m.fraction))
                        HStack {
                            Text(m.left)
                            Spacer()
                            if let r = m.resetsAt { Text("Resets \(Fmt.resetsIn(r))") }
                        }
                        .font(.caption).foregroundStyle(Palette.faint)
                    }
                }
            }
        }
    }
}

/// Wraps its children onto new lines, like the desktop's option buttons.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.init(width: width, height: nil))
            if x > 0 && x + s.width > width { y += row + spacing; x = 0; row = 0 }
            x += s.width + spacing
            row = max(row, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.init(width: bounds.width, height: nil))
            if x > bounds.minX && x + s.width > bounds.maxX { y += row + spacing; x = bounds.minX; row = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: .init(s))
            x += s.width + spacing
            row = max(row, s.height)
        }
    }
}

/// Picks photos or files and hands back their bytes for upload.
struct AttachPickers: ViewModifier {
    @Binding var photos: Bool
    @Binding var files: Bool
    var onPick: (String, Data) -> Void
    @State private var items: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $photos, selection: $items, maxSelectionCount: 5, matching: .images)
            .onChange(of: items) { _, picked in
                guard !picked.isEmpty else { return }
                let list = picked
                items = []
                Task {
                    for (i, item) in list.enumerated() {
                        guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                        // Send photos as JPEG: HEIC isn't read by every model.
                        let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
                        let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false)).replacingOccurrences(of: ":", with: "-")
                        onPick("photo-\(stamp)\(list.count > 1 ? "-\(i + 1)" : "").jpg", jpeg)
                    }
                }
            }
            .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                for u in urls {
                    let ok = u.startAccessingSecurityScopedResource()
                    defer { if ok { u.stopAccessingSecurityScopedResource() } }
                    if let d = try? Data(contentsOf: u), d.count < 25_000_000 { onPick(u.lastPathComponent, d) }
                }
            }
    }
}
