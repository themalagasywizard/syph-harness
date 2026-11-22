import SwiftUI
import Charts

struct EvolveView: View {
    @Environment(AppModel.self) private var app
    @State private var items: [Proposal] = []
    @State private var evals = EvalsResponse(cases: [], history: [])
    @State private var filter = Filter.pending
    @State private var model: String?
    @State private var busy: String?
    @State private var error: String?
    @State private var showModels = false

    enum Filter: Hashable { case pending, history }

    private var jobList: [Job] { app.jobs.values.sorted { $0.startedAt > $1.startedAt } }
    private var running: Job? { jobList.first { $0.status == "running" } }
    private var history: [EvalSummary] { evals.history.filter { activeModel == nil || $0.model == activeModel } }
    /// The model being improved: the one picked here, else the default chat model.
    private var activeModel: String? { model ?? app.state?.config.defaults.chatModel }

    var body: some View {
        let pending = items.filter { $0.status == "pending" }
        let decided = items.filter { $0.status != "pending" }
        let shown = filter == .pending ? pending : decided
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Syph proposes changes to its own skills, memory, prompts and code. Each one is measured on evals, and nothing changes until you accept it.")
                    .font(.subheadline).foregroundStyle(Palette.muted)

                ScoreCard(history: Array(history.suffix(12)), model: activeModel) { showModels = true }

                HStack(spacing: 10) {
                    Button { run("evals") } label: { Label("Run evals", systemImage: "flask.fill").frame(maxWidth: .infinity) }
                        .buttonStyle(.tonal)
                    Button { run("evolve") } label: { Label("Improve now", systemImage: "sparkles").frame(maxWidth: .infinity) }
                        .buttonStyle(.primary)
                }
                .disabled(running != nil)

                if let j = jobList.first { JobCard(job: j).transition(.move(edge: .top).combined(with: .opacity)) }
                if let error { ErrorBanner(text: error) }

                HStack(spacing: 10) {
                    MiniStat(value: "\(evals.cases.count)", label: "Eval cases", sub: "\(evals.cases.filter { $0.heldOut == true }.count) held out", icon: "checklist", color: Palette.accent)
                    MiniStat(value: "\(items.filter { $0.status == "accepted" }.count)", label: "Accepted", sub: "\(items.filter { $0.status == "rolled_back" }.count) rolled back", icon: "checkmark.seal.fill", color: Palette.ok)
                    MiniStat(value: Fmt.usd(app.state?.spend.evolve ?? 0), label: "Today", sub: "on evolve", icon: "dollarsign.circle.fill", color: Palette.accent2)
                }

                Picker("Filter", selection: $filter) {
                    Text("Waiting for you (\(pending.count))").tag(Filter.pending)
                    Text("History (\(decided.count))").tag(Filter.history)
                }
                .pickerStyle(.segmented)
                .onChange(of: filter) { Haptic.tap() }

                if shown.isEmpty {
                    EmptyState(icon: filter == .pending ? "sparkles" : "clock", title: filter == .pending ? "Nothing waiting" : "No decisions yet", message: filter == .pending ? "Rate answers in chat, then press Improve now." : "Accepted and rejected changes show up here.").card()
                }
                ForEach(shown) { p in
                    ProposalCard(p: p, busy: busy == p.id, measuring: running != nil) { decide(p.id, $0) }
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
            .animation(.smooth, value: items)
            .animation(.smooth, value: jobList.first)
        }
        .background(Backdrop(tint: Palette.accent2))
        .navigationTitle("Evolve")
        .refreshable { await load() }
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(title: "Improving", value: activeModel) { model = $0 }.presentationDetents([.medium, .large])
        }
        .task(id: app.tick) { await load() }
        .onChange(of: jobList.first?.status) { _, s in if s != "running" { Task { await load() } } }
        .onAppear { if model == nil { model = app.state?.config.defaults.chatModel } }
    }

    private func load() async {
        let b = app.backend
        if let p = try? await b.proposals() { items = p }
        if let e = try? await b.evals() { evals = e }
        if let jobs = try? await b.jobs() { for j in jobs where app.jobs[j.id] == nil { app.jobs[j.id] = j } }
    }

    private func run(_ what: String) {
        Haptic.tap()
        error = nil
        Task {
            do {
                if what == "evals" { try await app.backend.runEvals(model: activeModel) } else { try await app.backend.evolve(model: activeModel) }
            } catch { self.error = error.localizedDescription }
        }
    }

    private func decide(_ id: String, _ decision: String) {
        busy = id
        decision == "accept" ? Haptic.success() : Haptic.tap()
        Task {
            do { try await app.backend.decide(id, decision: decision, model: activeModel) }
            catch { self.error = error.localizedDescription; Haptic.warning() }
            busy = nil
            await load()
            await app.refresh()
        }
    }
}

/// The hero: current eval score as a big number with its trend, like a balance card.
struct ScoreCard: View {
    var history: [EvalSummary]
    var model: String?
    var pickModel: () -> Void

    var body: some View {
        let latest = history.last
        let first = history.first
        let delta = (latest?.score ?? 0) - (first?.score ?? 0)
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Eval score").font(.subheadline.weight(.medium)).foregroundStyle(Palette.muted)
                Spacer()
                Button(action: pickModel) {
                    HStack(spacing: 4) {
                        Text(Fmt.model(model)).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.text)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .glassCapsule()
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(latest.map { Fmt.pct($0.score) } ?? "—")
                    .font(.system(size: 56, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                if let latest, let first, latest.id != first.id {
                    Label("\(delta >= 0 ? "+" : "")\(Int((delta * 100).rounded())) pts", systemImage: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(delta >= 0 ? Palette.ok : Palette.err)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background((delta >= 0 ? Palette.ok : Palette.err).opacity(0.14), in: Capsule())
                }
            }
            if history.count >= 2 {
                Chart(Array(history.enumerated()), id: \.offset) { i, e in
                    AreaMark(x: .value("Run", i), yStart: .value("Min", (history.map(\.score).min() ?? 0) - 0.03), yEnd: .value("Score", e.score))
                        .foregroundStyle(LinearGradient(colors: [Palette.accent.opacity(0.35), Palette.accent.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.catmullRom)
                    LineMark(x: .value("Run", i), y: .value("Score", e.score))
                        .foregroundStyle(Palette.accentGradient)
                        .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .interpolationMethod(.catmullRom)
                    if i == history.count - 1 {
                        PointMark(x: .value("Run", i), y: .value("Score", e.score)).foregroundStyle(Palette.text).symbolSize(50)
                    }
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartYScale(domain: ((history.map(\.score).min() ?? 0) - 0.03)...((history.map(\.score).max() ?? 1) + 0.02))
                .frame(height: 96)
            } else {
                Text("Run evals twice to see a trend.").font(.footnote).foregroundStyle(Palette.muted).frame(height: 40)
            }
            if let latest {
                Text("Held-out \(Fmt.pct(latest.heldOutScore)) · \(Fmt.rel(latest.startedAt)) · last \(history.count) runs")
                    .font(.caption).foregroundStyle(Palette.muted)
            }
        }
        .padding(20)
        .glass(radius: 28)
    }
}

struct MiniStat: View {
    var value: String
    var label: String
    var sub: String
    var icon: String
    var color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(systemName: icon).font(.footnote.weight(.semibold)).foregroundStyle(color)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption.weight(.medium))
            Text(sub).font(.caption2).foregroundStyle(Palette.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12, radius: 20)
    }
}

struct JobCard: View {
    var job: Job
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if job.status == "running" { CellLoader(size: 22, mode: .loading) } else { StatusDot(status: job.status == "done" ? "ok" : "error") }
                Text(job.title).font(.subheadline.weight(.semibold))
                Spacer()
                Text(job.status == "running" ? "Running…" : job.status == "done" ? "Done" : "Failed").font(.caption).foregroundStyle(Palette.muted)
            }
            Text(job.log.suffix(8).joined(separator: "\n").isEmpty ? "Starting…" : job.log.suffix(8).joined(separator: "\n"))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Palette.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentTransition(.opacity)
        }
        .card(padding: 14, radius: 22)
    }
}

struct ProposalCard: View {
    var p: Proposal
    var busy: Bool
    var measuring: Bool
    var decide: (String) -> Void
    @State private var showDiff = true

    private var kindColor: Color {
        switch p.kind {
        case "memory": return Palette.ok
        case "skill": return Palette.accent
        case "prompt": return Palette.accent2
        case "profile", "strategy": return Palette.warn
        default: return Palette.err
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Tag(text: p.kind.capitalized, color: kindColor)
                if p.status != "pending" {
                    Tag(text: p.status.replacingOccurrences(of: "_", with: " ").capitalized, color: p.status == "accepted" ? Palette.ok : p.status == "rolled_back" ? Palette.warn : Palette.muted)
                }
                Spacer()
                Text("\(p.source == "reflector" ? "Reflector" : p.source == "agent" ? "From a chat" : "You") · \(Fmt.rel(p.createdAt))")
                    .font(.caption).foregroundStyle(Palette.faint).lineLimit(1)
            }
            Text(p.title).font(.system(.subheadline, design: .monospaced).weight(.semibold))
            Text(p.reason).font(.subheadline).foregroundStyle(Palette.muted)

            Button { withAnimation(.snappy) { showDiff.toggle() } } label: {
                Label(showDiff ? "Hide changes" : "Show changes", systemImage: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .labelStyle(DiffToggleLabel(open: showDiff))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.muted)
            if showDiff { DiffView(text: p.diff) }

            GateLine(gate: p.gate)
            if let notes = p.gate?.notes, !notes.isEmpty {
                Text(notes.joined(separator: " ")).font(.caption).foregroundStyle(Palette.muted)
            }

            if p.status == "pending" {
                HStack(spacing: 8) {
                    if p.gate == nil {
                        Button { decide("gate") } label: { Label("Measure", systemImage: "gauge.with.dots.needle.67percent") }
                            .buttonStyle(.tonalCompact).disabled(measuring || busy)
                    }
                    Spacer()
                    Button { decide("reject") } label: { Label("Reject", systemImage: "xmark") }.buttonStyle(.tonalCompact).disabled(busy)
                    Button { decide("accept") } label: {
                        HStack(spacing: 6) {
                            if busy { ProgressView().controlSize(.mini).tint(Palette.bg) } else { Image(systemName: "checkmark") }
                            Text("Accept")
                        }
                    }
                    .buttonStyle(.primaryCompact).disabled(busy)
                }
            } else if p.status == "accepted" {
                HStack {
                    Spacer()
                    Button { decide("rollback") } label: { Label("Roll back", systemImage: "arrow.uturn.backward") }.buttonStyle(.tonalCompact).disabled(busy)
                }
            }
        }
        .padding(18)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Palette.stroke))
    }
}

private struct DiffToggleLabel: LabelStyle {
    var open: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.rotationEffect(.degrees(open ? 90 : 0))
            configuration.title
        }
    }
}

struct GateLine: View {
    var gate: GateResult?
    var body: some View {
        if let g = gate {
            let d = (g.delta * 1000).rounded() / 10
            HStack(spacing: 6) {
                Image(systemName: g.passed ? "chart.line.uptrend.xyaxis" : "exclamationmark.triangle.fill")
                Text("\(Fmt.pct(g.baseline)) → \(Fmt.pct(g.candidate)) (\(d >= 0 ? "+" : "")\(d.formatted()) pts)\(g.regressions.isEmpty ? "" : ", \(g.regressions.count) regressed")\(g.passed ? "" : " · did not pass")")
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(g.passed ? Palette.ok : Palette.err)
        } else {
            Label("Not measured yet", systemImage: "gauge.with.dots.needle.0percent").font(.footnote.weight(.medium)).foregroundStyle(Palette.faint)
        }
    }
}

struct DiffView: View {
    var text: String
    var body: some View {
        let lines = text.components(separatedBy: "\n").filter { l in !(l.hasPrefix("---") || l.hasPrefix("+++") || l.hasPrefix("Index:") || (!l.isEmpty && l.allSatisfy { $0 == "=" })) }
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                    Text(l.isEmpty ? " " : l)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(l.hasPrefix("+") ? Palette.ok : l.hasPrefix("-") ? Palette.err : l.hasPrefix("@@") ? Palette.accent : Palette.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 1.5)
                        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                        .background(l.hasPrefix("+") ? Palette.addBg : l.hasPrefix("-") ? Palette.delBg : .clear)
                }
            }
            .padding(.vertical, 8)
        }
        .frame(maxHeight: 280)
        .background(Palette.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
