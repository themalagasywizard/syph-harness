import SwiftUI
import Observation

struct PendingApproval: Equatable {
    var id: String
    var tool: String
    var args: JSONValue?
}

/// One open chat. Watching a run, not owning it: leaving the screen only stops watching;
/// the run carries on on the server (same model as the desktop ChatView).
@MainActor @Observable
final class ChatViewModel {
    let app: AppModel
    var chat: Chat?
    var chatId: String?
    var draft: String
    var model: String?
    var projectId: String?
    var live: Turn?
    var note: String?
    var approval: PendingApproval?
    var pendingUser: Turn?
    var error: String?
    var sending = false
    /// When the running request started (for the live timer).
    var liveStarted: Date?
    /// Files attached to the next message (already uploaded to the computer).
    var attachments: [Attachment] = []
    var uploading = false
    /// Messages sent while the run worked: the agent reads them at its next step.
    var steered: [String] = []
    /// The answer that just finished, so its mark springs back into shape once.
    var justFinished: String?
    /// The project's threads, when this is its coordinator chat.
    var threads: ProjectThreads?
    /// Folders on the computer this chat (or its project) works in.
    var folders: [FolderLink] = []
    private var watch: Task<Void, Never>?

    init(app: AppModel, chatId: String?, projectId: String?, draft: String?) {
        self.app = app
        self.chatId = chatId
        self.projectId = projectId
        self.draft = draft ?? ""
        self.model = app.state?.config.defaults.chatModel
    }

    var turns: [Turn] { (chat?.turns ?? []) + (pendingUser.map { [$0] } ?? []) }
    var isEmpty: Bool { turns.isEmpty && live == nil }
    var project: Project? { app.project(projectId) }
    /// The chosen model's provider has no key (on the computer, or on this phone when standalone).
    var noKey: Bool {
        guard let cfg = app.state?.config else { return false }
        let provider = PhoneKeys.split(model ?? "").provider
        switch provider {
        case "openrouter": return !cfg.hasOpenRouterKey
        case "minimax": return cfg.hasMiniMaxKey == false
        case "gemini": return cfg.hasGeminiKey == false
        default: return app.isStandalone
        }
    }
    var keyProvider: String { PhoneKeys.split(model ?? "").provider }

    var isCoordinator: Bool { chat?.role == "coordinator" || (chatId != nil && threads?.coordinatorId == chatId) }
    var isThread: Bool { chat?.role == "thread" }
    /// Standalone, a chat copied from the computer can be read but not answered: continue it on the phone instead.
    var readOnly: Bool {
        guard app.isStandalone, let id = chatId, let local = app.backend as? LocalBackend else { return false }
        return !local.isPhoneChat(id)
    }
    /// The streamed text's length: each change makes the living mark beat.
    var beat: Int { live?.content.count ?? 0 }

    /// Repos this chat works on (its own and its project's), with live git status.
    var repos: [RepoStatus] = []
    var activeRepo: RepoStatus? { repos.first { $0.active == true } ?? repos.first }

    /// How long an answer took. Newer servers record it; for older answers, the gap since the question.
    func duration(of turn: Turn) -> TimeInterval? {
        if let ms = turn.durationMs, ms > 0 { return ms / 1000 }
        let all = chat?.turns ?? []
        guard let i = all.firstIndex(where: { $0.id == turn.id }), i > 0,
              let asked = all[..<i].last(where: { $0.role == .user }).flatMap({ Fmt.date($0.createdAt) }),
              let answered = Fmt.date(turn.createdAt) else { return nil }
        let d = answered.timeIntervalSince(asked)
        return d > 0 && d < 86_400 ? d : nil
    }

    func load() async {
        if model == nil { model = app.state?.config.defaults.chatModel }
        guard let id = chatId else { return }
        do {
            let c = try await app.backend.chat(id)
            chat = c
            projectId = c.projectId
            if let m = c.model { model = m }
            if c.running == true { follow(id) }
            if case .remote = app.connection { Mirror.save(chat: c) }
        } catch {
            self.error = error.localizedDescription
        }
        await loadRepos()
        await loadThreads()
        await loadFolders()
    }

    func loadThreads() async {
        guard let pid = projectId ?? chat?.projectId, app.capabilities.projects || app.isStandalone else { threads = nil; return }
        if let t = try? await app.backend.projectThreads(pid) { withAnimation(.smooth) { threads = t } }
    }

    func loadFolders() async {
        guard app.capabilities.computer, chatId != nil || projectId != nil else { folders = []; return }
        if let f = try? await app.backend.folders(projectId: projectId, chatId: chatId) { withAnimation(.smooth) { folders = f } }
    }

    /// Standalone: carry on a chat read from the computer as a new chat on the phone.
    func continueOnPhone() async {
        guard let id = chatId, let local = app.backend as? LocalBackend else { return }
        do {
            let c = try await local.continueFromMirror(id)
            await app.refresh()
            app.openChat(c.id)
        } catch { self.error = error.localizedDescription }
    }

    /// Make sure there is a chat to attach to or link to (a new chat gets one on first use).
    private func ensureChat() async throws -> String {
        if let chatId { return chatId }
        let c = try await app.backend.createChat(projectId: projectId, model: model)
        chatId = c.id
        chat = c
        app.activeChatId = c.id
        return c.id
    }

    /// Upload a photo or file for the next message.
    func attach(name: String, data: Data) async {
        uploading = true
        defer { uploading = false }
        do {
            let id = try await ensureChat()
            let a = try await app.backend.uploadAttachment(id, name: name, data: data)
            withAnimation(.smooth) { attachments.append(a) }
            Haptic.tap()
        } catch {
            self.error = error.localizedDescription
            Haptic.warning()
        }
    }

    func removeAttachment(_ a: Attachment) { withAnimation(.smooth) { attachments.removeAll { $0.path == a.path } } }

    /// While it works: tell it something it reads at its next step.
    func steer() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let id = chatId else { return }
        draft = ""
        Haptic.tap()
        do {
            try await app.backend.queueMessage(id, text: text)
            withAnimation(.smooth) { steered.append(text) }
        } catch {
            draft = text
            self.error = error.localizedDescription
        }
    }

    /// Send the last message again (after running out of credit, say).
    func retry() async {
        guard let last = chat?.turns.last(where: { $0.role == .user }) else { return }
        await send(last.content)
    }

    /// A question card asked which model a thread should start (or continue) with.
    func pickModel(_ picked: String, pendingStart: Bool) async {
        model = picked
        error = nil
        if pendingStart, let id = chatId {
            do {
                try await app.backend.startThread(id, model: picked)
                if let c = try? await app.backend.chat(id) {
                    chat = c
                    if c.running == true { follow(id) }
                }
                await app.refresh()
            } catch { self.error = error.localizedDescription }
            return
        }
        await send("Use \(Fmt.model(picked)) and continue.")
    }

    func loadRepos() async {
        guard chatId != nil || projectId != nil else { repos = []; return }
        if let r = try? await app.backend.repos(projectId: projectId, chatId: chatId) {
            withAnimation(.smooth) { repos = r }
        }
    }

    func setActiveRepo(_ r: RepoStatus) {
        guard let id = chatId else { return }
        Haptic.tap()
        repos = repos.map { var x = $0; x.active = x.path == r.path; return x }
        Task { try? await app.backend.setActiveRepo(chatId: id, path: r.path) }
    }

    /// Link a repo to this chat (or its project). A new chat is created first so there's something to link to.
    func linkRepo(_ repo: String, scope: String) async throws {
        if chatId == nil {
            let c = try await app.backend.createChat(projectId: projectId, model: model)
            chatId = c.id
            chat = c
            app.activeChatId = c.id
        }
        try await app.backend.linkRepo(repo, scope: scope, projectId: projectId, chatId: chatId)
        await loadRepos()
        await app.refresh()
    }

    func stopWatching() { watch?.cancel(); watch = nil }

    /// Show the chat's current run, replayed from its start, until it ends.
    func follow(_ id: String) {
        watch?.cancel()
        live = Turn(id: "live", role: .assistant, content: "", toolCalls: [], createdAt: iso(Date()))
        steered = []
        // A run picked up mid-way started when its question was asked.
        liveStarted = turns.last(where: { $0.role == .user }).flatMap { Fmt.date($0.createdAt) }.map { min($0, Date()) } ?? Date()
        note = nil
        approval = nil
        let backend = app.backend
        watch = Task { [weak self] in
            do {
                for try await e in backend.follow(id) {
                    guard let self, !Task.isCancelled else { return }
                    self.apply(e)
                }
            } catch {
                // Stopped watching, or the connection dropped: the saved chat is the source of truth.
            }
            guard let self, !Task.isCancelled else { return }
            let fresh = try? await backend.chat(id)
            withAnimation(.smooth) {
                if let fresh { self.chat = fresh }
                self.justFinished = fresh?.turns.last(where: { $0.role == .assistant })?.id
                self.live = nil
                self.steered = []
                self.pendingUser = nil
                self.approval = nil
                self.note = nil
            }
            self.watch = nil
            Haptic.soft()
            await self.loadRepos()
            await self.loadThreads()
            await self.app.refresh()
            if let fresh, case .remote = self.app.connection { Mirror.save(chat: fresh) }
            if fresh?.running == true { self.follow(id) }
        }
    }

    private func apply(_ e: AgentEvent) {
        guard var t = live else { return }
        switch e.type {
        case "run_start":
            t.model = e.model
            if let at = e.at { liveStarted = Date(timeIntervalSince1970: at / 1000) }
        case "token": t.content += e.text ?? ""
        case "tool_call":
            t.toolCalls = (t.toolCalls ?? []) + [ToolCallView(id: e.id ?? UUID().uuidString, name: e.name ?? "tool", args: e.args)]
        case "tool_result":
            t.toolCalls = t.toolCalls?.map { c in
                guard c.id == e.id else { return c }
                var c = c
                c.ok = e.ok; c.result = e.result; c.ms = e.ms
                return c
            }
        case "note":
            if e.reset == true { t.content = "" }
            if let text = e.text, !text.isEmpty { note = text }
        case "message":
            // A new step with tool calls replaces the text so far, unless it only asks you something (ask_user).
            if !t.content.isEmpty, case .array(let calls)? = e.message?["tool_calls"],
               calls.contains(where: { $0["function"]?["name"]?.string != "ask_user" }) { t.content = "" }
        case "steer":
            if let text = e.text, !steered.contains(text) { steered.append(text) }
        case "approval_request":
            approval = PendingApproval(id: e.id ?? "", tool: e.tool ?? "tool", args: e.args)
            Haptic.warning()
        case "approval_done":
            if approval?.id == e.id { approval = nil }
        case "plan":
            t.plan = e.steps
        case "files":
            // Each event carries the run's files so far; keep the latest copy of each path.
            var all = t.files ?? []
            for f in e.files ?? [] {
                if let i = all.firstIndex(where: { $0.path == f.path }) { all[i] = f } else { all.append(f) }
            }
            t.files = all
        case "error":
            error = e.error
        default: break
        }
        if e.type == "tool_result" { approval = nil }
        live = t
    }

    func send(_ text: String? = nil) async {
        let text = (text ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty, live == nil, !sending else { return }
        let files = attachments
        sending = true
        defer { sending = false }
        error = nil
        draft = ""
        attachments = []
        justFinished = nil
        Haptic.tap()
        let b = app.backend
        do {
            var id = chatId
            if id == nil {
                let c = try await b.createChat(projectId: projectId, model: model)
                id = c.id
                chatId = c.id
                chat = c
                app.activeChatId = c.id
            } else if let chat, chat.projectId != projectId || chat.model != model {
                try await b.patchChat(chat.id, ["projectId": .str(projectId), "model": .str(model)])
            }
            withAnimation(.smooth) { pendingUser = Turn(id: "pending", role: .user, content: text, createdAt: iso(Date()), attachments: files.isEmpty ? nil : files) }
            try await b.sendMessage(id!, text: text, model: model, attachments: files)
            pushRecentModel(model)
            if let c = try? await b.chat(id!) {
                chat = c
                pendingUser = nil
            }
            follow(id!)
            await app.refresh()
        } catch {
            pendingUser = nil
            draft = text
            attachments = files
            self.error = error.localizedDescription
            Haptic.warning()
        }
    }

    func stop() {
        guard let id = chatId else { return }
        Haptic.tap()
        Task { try? await app.backend.stopChat(id) }
    }

    func answer(_ allow: Bool) {
        guard let a = approval else { return }
        allow ? Haptic.success() : Haptic.tap()
        withAnimation(.smooth) { approval = nil }
        Task { try? await app.backend.resolveApproval(a.id, allow: allow) }
    }

    /// "Always allow": this tool (or this exact command) runs without asking from now on.
    func allowAlways() {
        guard let a = approval else { return }
        Haptic.success()
        withAnimation(.smooth) { approval = nil }
        Task { try? await app.backend.allowAlways(a.id) }
    }

    func toggleYolo() {
        Haptic.tap()
        Task { await app.patchSettings(["approval": ["yolo": .bool(!app.yolo)]]) }
    }
}

// MARK: - Recent models (the model menu opens on these, like the desktop's)

enum RecentModels {
    private static let key = "syph.recentModels"
    static var list: [String] { UserDefaults.standard.stringArray(forKey: key) ?? [] }
    static func push(_ ref: String) {
        UserDefaults.standard.set(([ref] + list.filter { $0 != ref }).prefix(5).map { $0 }, forKey: key)
    }
}

func pushRecentModel(_ ref: String?) { if let ref, !ref.isEmpty { RecentModels.push(ref) } }

/// Effort levels a model's provider understands (local models have none), as on the desktop.
enum Effort {
    static func levels(_ ref: String?) -> [String] {
        switch PhoneKeys.split(ref ?? "").provider {
        case "minimax": return ["auto", "low", "medium", "high", "xhigh", "max"]
        case "openrouter", "gemini": return ["auto", "low", "medium", "high"]
        default: return []
        }
    }
    static func label(_ e: String) -> String {
        ["auto": "Auto", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max"][e] ?? e.capitalized
    }
    static func hint(_ e: String) -> String {
        switch e {
        case "auto": return "The model decides how long to think."
        case "low": return "Faster and cheaper, less thinking."
        case "max", "xhigh": return "Thinks longest. Slower and costs more."
        default: return "More thinking for harder work."
        }
    }
}
