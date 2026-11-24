import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @State private var vm: ChatViewModel?
    var route: ChatRoute

    var body: some View {
        Group {
            if let vm { ChatScreen(vm: vm) } else { Palette.bg.ignoresSafeArea() }
        }
        .onAppear {
            guard vm == nil else { return }
            switch route {
            case .chat(let id): vm = ChatViewModel(app: app, chatId: id, projectId: nil, draft: nil)
            case .new(let p, let d, _): vm = ChatViewModel(app: app, chatId: nil, projectId: p, draft: d)
            }
        }
    }
}

/// The main screen: the conversation and the chat bar, nothing else.
private struct ChatScreen: View {
    @Environment(AppModel.self) private var app
    @Bindable var vm: ChatViewModel
    @FocusState private var focused: Bool
    @State private var showModels = false
    @State private var linkingRepo = false
    @State private var showFiles = false

    private static let suggestions: [(String, String)] = [
        ("Turn what we did today into a reusable skill", "lightbulb"),
        ("Schedule a daily summary of my research notes", "clock"),
        ("Review your system prompt and suggest one improvement", "sparkles"),
        ("Write a script that checks if my Ollama server is up", "chevron.left.forwardslash.chevron.right"),
    ]

    var body: some View {
        ScrollViewReader { proxy in conversation(proxy) }
            .background(Backdrop(tint: vm.project.map { Color(hex: $0.color ?? "#9EC7FF") } ?? Palette.accent))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .modifier(ChatSheets(vm: vm, showModels: $showModels, linkingRepo: $linkingRepo, showFiles: $showFiles))
            .task { await vm.load() }
            .onChange(of: app.state?.config.defaults.chatModel) { _, m in if vm.model == nil { vm.model = m } }
            .onChange(of: vm.projectId) { Task { await vm.loadRepos() } }
            .onDisappear { vm.stopWatching() }
    }

    /// Changes whenever something new appears in the conversation, to keep it scrolled to the end.
    private var scrollKey: String {
        let live = vm.live
        let steps = live?.plan?.filter { $0.status == "done" }.count ?? -1
        return "\(vm.turns.count)|\(live?.toolCalls?.count ?? -1)|\(vm.approval?.id ?? "")|\(steps)|\(live?.plan?.count ?? -1)|\(live?.files?.count ?? -1)"
    }

    private func conversation(_ proxy: ScrollViewProxy) -> some View {
            ScrollView { transcript }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(vm.isEmpty ? .top : .bottom)
            .onChange(of: vm.live?.content) { scroll(proxy) }
            .onChange(of: scrollKey) { scroll(proxy, animated: true) }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    }

    private var transcript: some View {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if vm.isEmpty {
                        hero
                    } else {
                        ForEach(vm.turns) { t in
                            if let u = t.threadUpdate {
                                ThreadUpdateCard(update: u).id(t.id)
                            } else if t.auto == true {
                                Label("Following up on the thread update", systemImage: "arrow.triangle.branch")
                                    .font(.caption).foregroundStyle(Palette.faint).id(t.id)
                            } else if t.role == .user {
                                UserBubble(text: t.content).id(t.id)
                                    .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                            } else {
                                AssistantTurnView(turn: t, chatId: vm.chat?.id, duration: vm.duration(of: t)).id(t.id)
                            }
                        }
                        if let live = vm.live {
                            AssistantTurnView(turn: live, chatId: nil, streaming: true, approval: vm.approval, note: vm.note, onApprove: vm.answer, startedAt: vm.liveStarted)
                                .id("live")
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 16)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Haptic.tap()
                    withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { app.drawerOpen = true }
                } label: {
                    Image(systemName: "line.3.horizontal").font(.body.weight(.semibold))
                }
                .accessibilityLabel("Menu")
            }
            ToolbarItem(placement: .principal) {
                Button { showModels = true } label: {
                    HStack(spacing: 5) {
                        Text(Fmt.model(vm.model).isEmpty ? "Syph" : Fmt.model(vm.model)).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.muted)
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.text)
                    .frame(maxWidth: 220)
                }
                .accessibilityLabel("Model: \(Fmt.model(vm.model))")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { app.newChat(projectId: vm.projectId) } label: {
                    Image(systemName: "square.and.pencil").font(.body.weight(.semibold))
                }
                .accessibilityLabel("New chat")
                .disabled(vm.isEmpty)
            }
    }

    private func scroll(_ proxy: ScrollViewProxy, animated: Bool = false) {
        if animated { withAnimation(.smooth) { proxy.scrollTo("bottom", anchor: .bottom) } }
        else { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    // MARK: Empty state

    private var hero: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(Fmt.greeting())")
                .font(.system(size: 40, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.accentGradient)
            Text("What should we work on?")
                .font(.system(size: 40, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.faint)
            if let p = vm.project {
                HStack(spacing: 6) {
                    Circle().fill(Color(hex: p.color ?? "#888")).frame(width: 8, height: 8)
                    Text("In \(p.name)").font(.subheadline.weight(.medium)).foregroundStyle(Palette.muted)
                }
                .padding(.top, 8)
            }
        }
        .padding(.top, 70)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Chat bar

    private var composer: some View {
        VStack(spacing: 10) {
            if vm.isEmpty && vm.draft.isEmpty && !focused {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.suggestions, id: \.0) { s in
                            Button { Task { await vm.send(s.0) } } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: s.1).foregroundStyle(Palette.accent)
                                    Text(s.0).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
                                }
                                .font(.subheadline.weight(.medium))
                                .frame(width: 210, alignment: .leading)
                                .padding(.horizontal, 14).padding(.vertical, 12)
                                .glass(radius: 20, interactive: true)
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            Group {
                if let e = vm.error { ErrorBanner(text: e).transition(.move(edge: .bottom).combined(with: .opacity)) }
                if vm.noKey {
                    HStack(spacing: 10) {
                        Image(systemName: "key.fill").foregroundStyle(Palette.warn)
                        Text("Add your OpenRouter key in Settings to chat with \(Fmt.model(vm.model)).").font(.footnote)
                        Spacer(minLength: 0)
                        Button("Open") { app.open(.settings) }.font(.footnote.weight(.semibold))
                    }
                    .padding(12)
                    .background(Palette.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
            .padding(.horizontal, 12)

            if !vm.repos.isEmpty { RepoChip(vm: vm) { linkingRepo = true } }

            HStack(alignment: .bottom, spacing: 8) {
                plusMenu
                TextField(vm.project.map { "Ask Syph in \($0.name)" } ?? "Ask Syph", text: $vm.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .font(.body)
                    .padding(.vertical, 9)
                if app.yolo {
                    Image(systemName: "bolt.fill").font(.caption).foregroundStyle(Palette.warn).padding(.bottom, 12)
                        .accessibilityLabel("YOLO is on")
                }
                sendButton
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.vertical, 6)
            .glass(radius: 26)
            .padding(.horizontal, 12)
            if vm.live != nil {
                Text("Keeps running on Syph if you leave this chat.").font(.caption2).foregroundStyle(Palette.faint)
            }
        }
        .padding(.bottom, 6)
        .animation(.smooth, value: vm.error)
        .animation(.smooth, value: vm.live == nil)
        .animation(.smooth, value: focused)
    }

    private var plusMenu: some View {
        Menu {
            Section("Project") {
                Button { vm.projectId = nil } label: { Label("No project", systemImage: vm.projectId == nil ? "checkmark" : "circle") }
                ForEach(app.state?.projects ?? []) { p in
                    Button { vm.projectId = p.id } label: { Label(p.name, systemImage: p.id == vm.projectId ? "checkmark" : "folder") }
                }
            }
            Section("Work on") {
                Button { linkingRepo = true } label: { Label(vm.repos.isEmpty ? "Link a GitHub repo" : "Link another repo", systemImage: "shippingbox") }
                if hasFiles {
                    Button { showFiles = true } label: { Label("Files in this chat", systemImage: "doc.on.doc") }
                }
            }
            Section("Tools") {
                Button(action: vm.toggleYolo) {
                    Label(app.yolo ? "YOLO on: tools run without asking" : "Ask first before running tools", systemImage: app.yolo ? "bolt.fill" : "hand.raised")
                }
            }
            Section {
                Button { showModels = true } label: { Label("Model: \(Fmt.model(vm.model))", systemImage: "cpu") }
            }
        } label: {
            Image(systemName: vm.project == nil ? "plus" : "folder.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(vm.project.map { Color(hex: $0.color ?? "#888") } ?? Palette.text)
                .frame(width: 38, height: 38)
                .background(Palette.surface3.opacity(0.8), in: Circle())
        }
        .accessibilityLabel("Options")
        .simultaneousGesture(TapGesture().onEnded { Haptic.tap() })
    }

    private var hasFiles: Bool { vm.chatId != nil && vm.turns.contains { !($0.files ?? []).isEmpty } }

    private var sendButton: some View {
        let ready = !vm.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return Button {
            if vm.live != nil { vm.stop() } else { Task { await vm.send() } }
        } label: {
            Image(systemName: vm.live != nil ? "stop.fill" : "arrow.up")
                .font(.system(size: vm.live != nil ? 13 : 16, weight: .bold))
                .foregroundStyle(ready || vm.live != nil ? Palette.bg : Palette.muted)
                .frame(width: 38, height: 38)
                .background(ready || vm.live != nil ? Palette.text : Palette.surface3, in: Circle())
                .contentTransition(.symbolEffect(.replace))
        }
        .disabled(!ready && vm.live == nil)
        .animation(.snappy, value: ready)
        .accessibilityLabel(vm.live != nil ? "Stop" : "Send")
    }
}

// MARK: - Turns

/// The chat's sheets, kept apart so the screen's body type-checks quickly.
private struct ChatSheets: ViewModifier {
    var vm: ChatViewModel
    @Binding var showModels: Bool
    @Binding var linkingRepo: Bool
    @Binding var showFiles: Bool

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $linkingRepo) {
                RepoPickerSheet(projectName: vm.project?.name) { repo, scope in try await vm.linkRepo(repo, scope: scope) }
            }
            .sheet(isPresented: $showFiles) {
                if let id = vm.chatId { ChatFilesSheet(chatId: id).presentationDetents([.medium, .large]) }
            }
            .sheet(isPresented: $showModels) {
                ModelPickerSheet(value: vm.model) { vm.model = $0 }.presentationDetents([.medium, .large])
            }
    }
}

struct UserBubble: View {
    var text: String
    var body: some View {
        HStack {
            Spacer(minLength: 50)
            Text(text)
                .font(.body)
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Palette.surface3, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .textSelection(.enabled)
        }
    }
}

struct AssistantTurnView: View {
    @Environment(AppModel.self) private var app
    var turn: Turn
    var chatId: String?
    var streaming = false
    var approval: PendingApproval?
    var note: String?
    var onApprove: ((Bool) -> Void)?
    /// How long the request took (finished turns), or when it started (the live turn).
    var duration: TimeInterval?
    var startedAt: Date?

    @State private var rating: String?
    @State private var copied = false
    @State private var feedback: Feedback = .none
    @State private var expectation = ""

    enum Feedback { case none, open, saved }

    private var loaderMode: CellLoader.Mode {
        if approval != nil { return .idle }
        let toolRunning = turn.toolCalls?.contains { $0.ok == nil } ?? false
        return !turn.content.isEmpty && !toolRunning ? .streaming : .loading
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if streaming { CellLoader(size: 22, mode: loaderMode) } else { SyphMark(size: 18, color: Palette.muted) }
                Text("Syph").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
                if streaming && approval == nil {
                    Text(turn.content.isEmpty ? "Thinking" : "Writing").font(.caption).foregroundStyle(Palette.faint)
                }
            }

            if let plan = turn.plan, !plan.isEmpty {
                PlanChecklist(steps: plan, streaming: streaming)
            }
            if let calls = turn.toolCalls, !calls.isEmpty {
                ToolChain(calls: calls, streaming: streaming, duration: duration, startedAt: startedAt)
            }
            if let note { Text(note).font(.footnote).foregroundStyle(Palette.muted).italic() }
            if let approval { ApprovalCard(approval: approval, onAnswer: { onApprove?($0) }) }

            if !turn.content.isEmpty {
                MarkdownView(text: turn.content + (streaming ? " ▍" : ""))
                    .textSelection(.enabled)
            } else if streaming && approval == nil {
                TypingDots()
            }

            if let files = turn.files, !files.isEmpty { FileCards(files: files) }

            if !streaming { actions }
            if feedback == .open { feedbackBox }
            if feedback == .saved {
                Label("Saved as an eval case. Evolve uses it to measure future changes.", systemImage: "checkmark.seal.fill")
                    .font(.footnote).foregroundStyle(Palette.ok)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { rating = turn.rating }
    }

    private var actions: some View {
        HStack(spacing: 4) {
            iconButton(rating == "up" ? "hand.thumbsup.fill" : "hand.thumbsup", active: rating == "up") { rate("up") }
            iconButton(rating == "down" ? "hand.thumbsdown.fill" : "hand.thumbsdown", active: rating == "down") { rate("down") }
            iconButton(copied ? "checkmark" : "doc.on.doc", active: copied) {
                UIPasteboard.general.string = turn.content
                Haptic.success()
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
            }
            if turn.runId != nil, rating != nil, feedback == .none {
                iconButton("flask", active: false) { feedback = .open }
            }
            Spacer()
            HStack(spacing: 6) {
                if let m = turn.model { Text(Fmt.model(m)).lineLimit(1) }
                if let duration, turn.toolCalls?.isEmpty ?? true {
                    Text("·")
                    Label(Fmt.duration(duration), systemImage: "timer").labelStyle(.titleAndIcon)
                }
            }
            .font(.caption2.weight(.medium))
            .foregroundStyle(Palette.faint)
        }
    }

    private func iconButton(_ icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(active ? Palette.text : Palette.muted)
                .frame(width: 34, height: 34)
                .contentTransition(.symbolEffect(.replace))
        }
    }

    private var feedbackBox: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Turn into an eval case").font(.subheadline.weight(.semibold))
            TextField(rating == "up" ? "Optional: what made this good?" : "What should a good answer do? (Syph drafts it if blank)", text: $expectation, axis: .vertical)
                .lineLimit(1...4)
                .padding(12)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            HStack {
                Button("Skip") { withAnimation { feedback = .none } }.buttonStyle(.tonalCompact)
                Spacer()
                Button { toEval() } label: { Label("Turn into eval", systemImage: "flask.fill") }.buttonStyle(.primaryCompact)
            }
        }
        .card(padding: 14, radius: 20)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func rate(_ r: String) {
        let next = rating == r ? nil : r
        Haptic.tap()
        withAnimation(.snappy) { rating = next }
        if let chatId { Task { try? await app.backend.rate(chatId: chatId, turnId: turn.id, rating: next) } }
        if next == "down" { withAnimation { feedback = .open } }
    }

    private func toEval() {
        guard let runId = turn.runId else { return }
        let exp = expectation.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            try? await app.backend.turnIntoEval(runId: runId, rating: rating ?? "down", expectation: exp.isEmpty ? nil : exp)
            Haptic.success()
            withAnimation { feedback = .saved }
        }
    }
}

/// All of a turn's tool calls behind one collapsible summary, e.g.
/// "Used 3 tools · list_files, read_file · 21 ms in tools · 4.2 s total".
struct ToolChain: View {
    var calls: [ToolCallView]
    var streaming: Bool
    var duration: TimeInterval?
    var startedAt: Date?
    @State private var open = CommandLine.arguments.contains("-syphOpenTools")

    private var running: ToolCallView? { calls.last { $0.ok == nil } }
    private var failed: Int { calls.filter { $0.ok == false }.count }
    private var toolMs: Double { calls.compactMap(\.ms).reduce(0, +) }
    private var names: String {
        var seen: [String] = []
        for c in calls where !seen.contains(c.name) { seen.append(c.name) }
        return seen.prefix(3).joined(separator: ", ") + (seen.count > 3 ? " +\(seen.count - 3)" : "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptic.tap()
                withAnimation(.snappy(duration: 0.28)) { open.toggle() }
            } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Palette.surface3)
                        if running != nil { ProgressView().controlSize(.mini) }
                        else { Image(systemName: failed > 0 ? "exclamationmark" : "checkmark").font(.caption.weight(.bold)).foregroundStyle(failed > 0 ? Palette.warn : Palette.ok) }
                    }
                    .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                        Text(summary).font(.caption).foregroundStyle(Palette.muted).lineLimit(1).monospacedDigit()
                    }
                    Spacer(minLength: 4)
                    elapsedLabel
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Palette.faint)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title). \(open ? "Hide" : "Show") tool calls")

            if open {
                VStack(spacing: 0) {
                    ForEach(Array(calls.enumerated()), id: \.element.id) { i, c in
                        ToolCallRow(call: c, step: i + 1, last: i == calls.count - 1)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Palette.surface2.opacity(0.75), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Palette.stroke))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var title: String {
        if let r = running { return "Running \(r.name)…" }
        let n = calls.count
        return "Used \(n) tool\(n == 1 ? "" : "s")" + (failed > 0 ? " · \(failed) failed" : "")
    }

    /// "list_files, read_file · 21 ms in tools".
    private var summary: String {
        toolMs > 0 ? "\(names) · \(Fmt.duration(toolMs / 1000)) in tools" : names
    }

    /// Total time for the request, ticking while it runs.
    @ViewBuilder private var elapsedLabel: some View {
        Group {
            if streaming, let startedAt {
                TimelineView(.periodic(from: .now, by: 0.1)) { tl in Text(Fmt.duration(tl.date.timeIntervalSince(startedAt))) }
            } else if let duration {
                Text(Fmt.duration(duration))
            }
        }
        .font(.footnote.weight(.semibold).monospacedDigit())
        .foregroundStyle(Palette.text)
        .fixedSize()
    }
}

struct ToolCallRow: View {
    var call: ToolCallView
    var step: Int = 1
    var last = true
    @State private var open = false

    private var status: String { call.ok == nil ? "running" : call.ok! ? "ok" : "error" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Timeline rail
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(Palette.bg.opacity(0.6))
                    if call.ok == nil { ProgressView().controlSize(.mini) }
                    else { Text("\(step)").font(.caption2.weight(.bold).monospacedDigit()).foregroundStyle(call.ok == false ? Palette.err : Palette.muted) }
                }
                .frame(width: 22, height: 22)
                if !last { Rectangle().fill(Palette.stroke).frame(width: 1.5).frame(maxHeight: .infinity) }
            }
            .frame(width: 22)

            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Haptic.tap()
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Text(call.name).font(.system(.footnote, design: .monospaced).weight(.semibold)).foregroundStyle(Palette.text)
                        Text(call.args?.inlineSummary ?? "").font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(1)
                        Spacer(minLength: 4)
                        if let ms = call.ms { Text(Fmt.duration(ms / 1000)).font(.caption2.monospacedDigit()).foregroundStyle(Palette.faint) }
                        if call.ok == false { StatusDot(status: "error") }
                    }
                    .frame(minHeight: 22)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(call.result ?? "…")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Palette.muted)
                            .textSelection(.enabled)
                            .padding(10)
                    }
                    .frame(maxHeight: 220)
                    .background(Palette.bg.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .transition(.opacity)
                }
            }
            .padding(.bottom, last ? 2 : 10)
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
    }
}

struct ApprovalCard: View {
    var approval: PendingApproval
    var onAnswer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                IconTile(system: "hand.raised.fill", color: Palette.warn, size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Allow \(approval.tool)?").font(.headline)
                    Text("Syph wants to run a tool that asks first.").font(.caption).foregroundStyle(Palette.muted)
                }
            }
            if let args = approval.args {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(args.pretty).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.text).padding(12)
                }
                .frame(maxHeight: 160)
                .background(Palette.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            HStack(spacing: 10) {
                Button { onAnswer(false) } label: { Text("Deny").frame(maxWidth: .infinity) }.buttonStyle(.tonalCompact)
                Button { onAnswer(true) } label: { Text("Allow").frame(maxWidth: .infinity) }.buttonStyle(.primaryCompact)
            }
        }
        .padding(16)
        .background(Palette.warn.opacity(0.08), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.warn.opacity(0.35)))
        .transition(.scale(scale: 0.96).combined(with: .opacity))
    }
}

struct TypingDots: View {
    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(Palette.muted)
                        .frame(width: 7, height: 7)
                        .opacity(0.35 + 0.65 * max(0, sin(t * 5 - Double(i) * 0.7)))
                }
            }
        }
        .padding(.vertical, 6)
    }
}
