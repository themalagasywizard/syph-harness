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
    var noKey: Bool { app.state.map { !$0.config.hasOpenRouterKey && (model ?? "").hasPrefix("openrouter:") } ?? false }

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
        } catch {
            self.error = error.localizedDescription
        }
        await loadRepos()
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
                self.live = nil
                self.pendingUser = nil
                self.approval = nil
                self.note = nil
            }
            self.watch = nil
            Haptic.soft()
            await self.loadRepos()
            await self.app.refresh()
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
            if !t.content.isEmpty, case .array(let calls)? = e.message?["tool_calls"], !calls.isEmpty { t.content = "" }
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
        guard !text.isEmpty, live == nil, !sending else { return }
        sending = true
        defer { sending = false }
        error = nil
        draft = ""
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
            withAnimation(.smooth) { pendingUser = Turn(id: "pending", role: .user, content: text, createdAt: iso(Date())) }
            try await b.sendMessage(id!, text: text, model: model)
            if let c = try? await b.chat(id!) {
                chat = c
                pendingUser = nil
            }
            follow(id!)
            await app.refresh()
        } catch {
            pendingUser = nil
            draft = text
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

    func toggleYolo() {
        Haptic.tap()
        Task { await app.patchSettings(["approval": ["yolo": .bool(!app.yolo)]]) }
    }
}
