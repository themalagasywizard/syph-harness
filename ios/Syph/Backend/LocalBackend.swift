import Foundation

// Syph on the phone alone. When the computer can't be reached (or was never paired), the app still
// works: chats run straight against the model provider with a key kept in this phone's Keychain and
// are saved on the phone. What the app last saw from the computer (its chats, projects and settings)
// stays readable from a mirror. When the computer is back, phone chats are synced to it and the app
// switches over, so both show the same chats.

/// A copy of what the computer last showed, kept on the phone so it can be read offline.
enum Mirror {
    private static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("syph", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static var stateURL: URL { dir.appendingPathComponent("mirror-state.json") }
    private static func chatURL(_ id: String) -> URL {
        let safe = id.replacingOccurrences(of: "/", with: "_")
        let d = dir.appendingPathComponent("mirror-chats", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.appendingPathComponent("\(safe).json")
    }

    static func save(state: AppState) {
        if let d = try? JSONEncoder().encode(state) { try? d.write(to: stateURL, options: .atomic) }
    }
    static func state() -> AppState? {
        (try? Data(contentsOf: stateURL)).flatMap { try? JSONDecoder().decode(AppState.self, from: $0) }
    }
    static func save(chat: Chat) {
        var c = chat
        c.running = false
        if let d = try? JSONEncoder().encode(c) { try? d.write(to: chatURL(c.id), options: .atomic) }
    }
    static func chat(_ id: String) -> Chat? {
        (try? Data(contentsOf: chatURL(id))).flatMap { try? JSONDecoder().decode(Chat.self, from: $0) }
    }
    static var lastSynced: Date? {
        (try? FileManager.default.attributesOfItem(atPath: stateURL.path))?[.modificationDate] as? Date
    }
}

/// Model provider keys kept on this phone for standalone chats.
enum PhoneKeys {
    static let providers = ["openrouter", "minimax", "gemini"]
    private static func account(_ p: String) -> String { "phone-key-\(p)" }
    static func key(_ p: String) -> String? { Keychain.get(account(p)) }
    static func set(_ p: String, _ key: String?) { Keychain.set(key, for: account(p)) }
    static var any: Bool { providers.contains { key($0) != nil } }

    static func baseURL(_ p: String) -> URL {
        switch p {
        case "minimax": return URL(string: "https://api.minimax.io/v1")!
        case "gemini": return URL(string: "https://generativelanguage.googleapis.com/v1beta/openai")!
        default: return URL(string: "https://openrouter.ai/api/v1")!
        }
    }

    /// "minimax:MiniMax-M3.1-Flash" → ("minimax", "MiniMax-M3.1-Flash"). A bare id is OpenRouter's.
    static func split(_ ref: String) -> (provider: String, model: String) {
        if let i = ref.firstIndex(of: ":") { return (String(ref[..<i]), String(ref[ref.index(after: i)...])) }
        return ("openrouter", ref)
    }

    static func masked(_ k: String) -> String { k.count > 10 ? "\(k.prefix(6))…\(k.suffix(4))" : "••••" }
}

final class LocalBackend: SyphBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var chats: [Chat]
    private var live: [String: LiveRun] = [:]
    private var feed: [UUID: AsyncStream<ServerEvent>.Continuation] = [:]
    private var settings: Settings

    struct Settings: Codable {
        var chatModel: String?
        var effort: String?
    }

    private final class LiveRun {
        var events: [AgentEvent] = []
        var watchers: [UUID: AsyncThrowingStream<AgentEvent, Error>.Continuation] = [:]
        var task: Task<Void, Never>?
        var done = false
    }

    private static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("syph", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static var chatsURL: URL { dir.appendingPathComponent("phone-chats.json") }
    private static var settingsURL: URL { dir.appendingPathComponent("phone-settings.json") }

    var capabilities: BackendCapabilities { .phoneOnly }

    init() {
        chats = (try? Data(contentsOf: Self.chatsURL)).flatMap { try? JSONDecoder().decode([Chat].self, from: $0) } ?? []
        settings = (try? Data(contentsOf: Self.settingsURL)).flatMap { try? JSONDecoder().decode(Settings.self, from: $0) } ?? Settings()
    }

    /// Chats made on the phone that the computer doesn't have yet.
    static func pendingChats() -> [Chat] {
        ((try? Data(contentsOf: chatsURL)).flatMap { try? JSONDecoder().decode([Chat].self, from: $0) } ?? []).filter { !$0.turns.isEmpty }
    }

    /// After a sync: drop the phone chats the computer now has.
    static func removeSynced(_ ids: Set<String>) {
        let left = ((try? Data(contentsOf: chatsURL)).flatMap { try? JSONDecoder().decode([Chat].self, from: $0) } ?? []).filter { !ids.contains($0.id) }
        if let d = try? JSONEncoder().encode(left) { try? d.write(to: chatsURL, options: .atomic) }
    }

    private func sync<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    private func persist() {
        let snapshot = sync { chats }
        if let d = try? JSONEncoder().encode(snapshot) { try? d.write(to: Self.chatsURL, options: .atomic) }
    }
    private func persistSettings() {
        if let d = try? JSONEncoder().encode(sync({ settings })) { try? d.write(to: Self.settingsURL, options: .atomic) }
    }

    private func emit(_ type: String) {
        let conts = sync { Array(feed.values) }
        for c in conts { c.yield(ServerEvent(type: type)) }
    }

    private var defaultModel: String {
        if let m = sync({ settings.chatModel }) { return m }
        if let m = Mirror.state()?.config.defaults.chatModel, PhoneKeys.key(PhoneKeys.split(m).provider) != nil { return m }
        if PhoneKeys.key("minimax") != nil { return "minimax:MiniMax-M3.1-Flash" }
        if PhoneKeys.key("gemini") != nil { return "gemini:gemini-3.8-flash" }
        return Mirror.state()?.config.defaults.chatModel ?? "openrouter:deepseek/deepseek-chat-v3.1"
    }

    // MARK: State

    func state() async throws -> AppState {
        let mirror = Mirror.state()
        let mine = sync { chats }.map { c in
            ChatSummary(id: c.id, title: c.title, projectId: c.projectId, model: c.model, updatedAt: c.updatedAt,
                        status: sync { live[c.id].map { $0.done ? nil : "running" } ?? nil })
        }
        let fromComputer = (mirror?.chats ?? []).filter { $0.role != "thread" }
        var cfg = mirror?.config ?? Config(
            providers: [], defaults: Defaults(chatModel: defaultModel, taskModel: defaultModel, reflectorModel: defaultModel, judgeModel: defaultModel),
            budgets: Budgets(dailyUsd: .init(chat: 0, tasks: 0, evolve: 0)), approval: Approval(autoAccept: .init(memory: false, skill: false)),
            evolve: EvolveConfig(samplesPerCase: 1), killSwitch: false, hasOpenRouterKey: false)
        cfg.defaults.chatModel = defaultModel
        cfg.defaults.effort = sync { settings.effort } ?? cfg.defaults.effort
        cfg.hasOpenRouterKey = PhoneKeys.key("openrouter") != nil
        cfg.hasMiniMaxKey = PhoneKeys.key("minimax") != nil
        cfg.hasGeminiKey = PhoneKeys.key("gemini") != nil
        let all = (mine + fromComputer).sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        return AppState(config: cfg, projects: mirror?.projects ?? [], chats: all, pendingProposals: 0,
                        spend: Spend(chat: 0, tasks: 0, evolve: 0), strategies: mirror?.strategies ?? [], skills: mirror?.skills ?? [],
                        extensions: [], mcp: [], homePath: "this iPhone", workspacePath: nil, github: nil)
    }

    func models() async throws -> [ModelInfo] {
        var out: [ModelInfo] = []
        if PhoneKeys.key("minimax") != nil {
            out += [("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash"), ("MiniMax-M3.1", "MiniMax M3.1")].map {
                ModelInfo(ref: "minimax:\($0.0)", label: $0.1, provider: "minimax", contextWindow: 1_000_000, tools: true)
            }
        }
        if PhoneKeys.key("gemini") != nil {
            out += [("gemini-4-neon", "Gemini 4 Neon"), ("gemini-4-argon", "Gemini 4 Argon"), ("gemini-3.8-flash", "Gemini 3.8 Flash")].map {
                ModelInfo(ref: "gemini:\($0.0)", label: $0.1, provider: "gemini", contextWindow: 1_048_576, tools: true)
            }
        }
        if PhoneKeys.key("openrouter") != nil {
            var refs = ["openrouter:deepseek/deepseek-chat-v3.1", "openrouter:anthropic/claude-sonnet-4.5", "openrouter:openai/gpt-5", "openrouter:google/gemini-2.5-flash", "openrouter:qwen/qwen3-235b-a22b"]
            if let m = Mirror.state()?.config.defaults.chatModel, m.hasPrefix("openrouter:"), !refs.contains(m) { refs.insert(m, at: 0) }
            if let key = PhoneKeys.key("openrouter"), let listed = try? await Self.openRouterModels(key: key), !listed.isEmpty {
                out += listed
            } else {
                out += refs.map { ModelInfo(ref: $0, label: Fmt.model($0), provider: "openrouter") }
            }
        }
        return out
    }

    private static func openRouterModels(key: String) async throws -> [ModelInfo] {
        var req = URLRequest(url: PhoneKeys.baseURL("openrouter").appendingPathComponent("models"))
        req.setValue("Bearer \(key)", forHTTPHeaderField: "authorization")
        req.timeoutInterval = 15
        let (data, _) = try await URLSession.shared.data(for: req)
        struct List: Decodable { struct M: Decodable { var id: String; var name: String?; var context_length: Int? }; var data: [M] }
        let list = try JSONDecoder().decode(List.self, from: data)
        return list.data.prefix(400).map { ModelInfo(ref: "openrouter:\($0.id)", label: $0.name ?? $0.id, provider: "openrouter", contextWindow: $0.context_length) }
    }

    func updateSettings(_ patch: JSONValue) async throws {
        if let m = patch["defaults"]?["chatModel"]?.string { sync { settings.chatModel = m } }
        if let e = patch["defaults"]?["effort"]?.string { sync { settings.effort = e } }
        persistSettings()
    }
    func profile(_ ref: String) async throws -> Profile { Profile(id: ref, contextWindow: 128_000, nativeTools: true, strategy: "direct", fewShot: 0) }
    func saveProfile(_ ref: String, _ profile: Profile) async throws {}

    // MARK: Keys (kept on this phone)

    private func status(_ p: String) -> KeyStatus {
        let k = PhoneKeys.key(p)
        return KeyStatus(set: k != nil, source: k == nil ? nil : "this iPhone", masked: k.map(PhoneKeys.masked))
    }
    func keyStatus() async throws -> KeyStatus { status("openrouter") }
    func saveKey(_ key: String) async throws -> KeyStatus { try await saveProviderKey("openrouter", key: key) }
    func checkKey() async throws -> KeyStatus { try await checkProviderKey("openrouter") }
    func removeKey() async throws -> KeyStatus { try await removeProviderKey("openrouter") }
    func providerKey(_ provider: String) async throws -> KeyStatus { status(provider) }
    func saveProviderKey(_ provider: String, key: String) async throws -> KeyStatus {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard k.count > 8 else { throw SyphError(message: "That key looks too short.") }
        PhoneKeys.set(provider, k)
        var s = try await checkProviderKey(provider)
        if s.check?.rejected == true {
            PhoneKeys.set(provider, nil)
            throw SyphError(message: s.check?.error ?? "The provider turned that key down.")
        }
        s.set = true
        emit("chats")
        return s
    }
    func checkProviderKey(_ provider: String) async throws -> KeyStatus {
        guard let key = PhoneKeys.key(provider) else { throw SyphError(message: "No key saved on this phone yet.") }
        var s = status(provider)
        var req = URLRequest(url: PhoneKeys.baseURL(provider).appendingPathComponent("models"))
        req.setValue("Bearer \(key)", forHTTPHeaderField: "authorization")
        req.timeoutInterval = 15
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            let code = (res as? HTTPURLResponse)?.statusCode ?? 0
            s.check = KeyCheck(ok: (200..<300).contains(code), rejected: code == 401 || code == 403, error: (200..<300).contains(code) ? nil : "The provider answered \(code).")
        } catch {
            s.check = KeyCheck(ok: false, error: "Couldn't reach the provider: \(error.localizedDescription)")
        }
        return s
    }
    func removeProviderKey(_ provider: String) async throws -> KeyStatus {
        PhoneKeys.set(provider, nil)
        emit("chats")
        return status(provider)
    }

    // MARK: Projects (read from the mirror)

    func project(_ id: String) async throws -> ProjectDetail {
        guard let p = Mirror.state()?.projects.first(where: { $0.id == id }) else { throw SyphError.needsComputer("This project") }
        let cs = (Mirror.state()?.chats ?? []).filter { $0.projectId == id }
        return ProjectDetail(id: p.id, name: p.name, description: p.description, color: p.color, updatedAt: p.updatedAt, folder: p.folder, repos: p.repos, instructions: "", files: [], chats: cs, tasks: [])
    }
    func createProject(name: String, description: String, instructions: String) async throws -> Project { throw SyphError.needsComputer("Making projects") }
    func updateProject(_ id: String, _ patch: JSONValue) async throws { throw SyphError.needsComputer("Changing projects") }
    func deleteProject(_ id: String) async throws { throw SyphError.needsComputer("Deleting projects") }
    func projectThreads(_ id: String) async throws -> ProjectThreads {
        let cs = Mirror.state()?.chats ?? []
        guard let coord = cs.first(where: { $0.projectId == id && $0.role == "coordinator" }) else { throw SyphError.needsComputer("Threads") }
        let threads = cs.filter { $0.parentId == coord.id }.map {
            ThreadSummary(id: $0.id, title: $0.title, updatedAt: $0.updatedAt, status: nil, threadState: $0.threadState, summary: $0.summary, resolved: $0.resolved)
        }
        return ProjectThreads(coordinatorId: coord.id, threads: threads)
    }

    // MARK: Chats

    func chat(_ id: String) async throws -> Chat {
        if let c = sync({ chats.first { $0.id == id } }) {
            var c = c
            c.running = sync { live[id].map { !$0.done } ?? false }
            return c
        }
        if let m = Mirror.chat(id) { return m }
        throw SyphError(message: "This chat is on your computer and hasn't been opened on the phone yet. Reconnect to read it.")
    }

    func createChat(projectId: String?, model: String?) async throws -> Chat {
        let c = Chat(id: "phone-\(UUID().uuidString.lowercased())", title: "New chat", projectId: nil, model: model ?? defaultModel, updatedAt: iso(Date()), turns: [])
        sync { chats.insert(c, at: 0) }
        persist()
        emit("chats")
        return c
    }
    func patchChat(_ id: String, _ patch: JSONValue) async throws {
        sync {
            guard let i = chats.firstIndex(where: { $0.id == id }) else { return }
            if let t = patch["title"]?.string { chats[i].title = t }
            if let m = patch["model"]?.string { chats[i].model = m }
        }
        persist()
    }
    func deleteChat(_ id: String) async throws {
        guard sync({ chats.contains { $0.id == id } }) else { throw SyphError.needsComputer("Deleting a chat from your computer") }
        sync { chats.removeAll { $0.id == id } }
        persist()
        emit("chats")
    }

    /// Whether a chat is one this phone made (others are read-only copies from the computer).
    func isPhoneChat(_ id: String) -> Bool { sync { chats.contains { $0.id == id } } }

    /// Start a phone chat that carries on from a chat read from the computer's mirror.
    func continueFromMirror(_ id: String) async throws -> Chat {
        guard let m = Mirror.chat(id) else { throw SyphError(message: "That chat isn't on this phone.") }
        var c = try await createChat(projectId: nil, model: m.model)
        c.title = m.title
        c.turns = m.turns.filter { $0.threadUpdate == nil && !$0.content.isEmpty }.map { var t = $0; t.toolCalls = nil; t.files = nil; t.plan = nil; return t }
        let saved = c
        sync { if let i = chats.firstIndex(where: { $0.id == saved.id }) { chats[i] = saved } }
        persist()
        return c
    }

    func sendMessage(_ chatId: String, text: String, model: String?) async throws {
        guard var c = sync({ chats.first { $0.id == chatId } }) else {
            throw SyphError(message: "This chat lives on your computer. Continue it on the phone to reply, or reconnect.")
        }
        let ref = model ?? c.model ?? defaultModel
        let (provider, _) = PhoneKeys.split(ref)
        guard PhoneKeys.key(provider) != nil else {
            throw SyphError(message: "Add a \(Fmt.providerLabel(provider)) key in Settings to chat on this phone with \(Fmt.model(ref)).")
        }
        let user = Turn(id: "u-\(UUID().uuidString.prefix(8))", role: .user, content: text, createdAt: iso(Date()), local: true)
        c.turns.append(user)
        c.model = ref
        if c.title == "New chat" { c.title = Self.titleFrom(text) }
        c.updatedAt = iso(Date())
        let snapshot = c
        sync { if let i = chats.firstIndex(where: { $0.id == chatId }) { chats[i] = snapshot } }
        persist()

        let run = LiveRun()
        sync { live[chatId] = run }
        emit("chats")
        run.task = Task { [weak self] in await self?.run(chatId: chatId, model: ref, history: snapshot.turns, run: run) }
    }

    /// The answer without <think>…</think> blocks (an unclosed one hides the rest for now).
    static func withoutThinking(_ raw: String) -> String {
        var out = ""
        var rest = Substring(raw)
        while let open = rest.range(of: "<think>") {
            out += rest[..<open.lowerBound]
            guard let close = rest[open.upperBound...].range(of: "</think>") else { return String(out.drop { $0.isNewline }) }
            rest = rest[close.upperBound...]
        }
        out += rest
        return String(out.drop { $0.isNewline })
    }

    private static func titleFrom(_ text: String) -> String {
        let one = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return one.count > 48 ? String(one.prefix(46)) + "…" : one
    }

    private func push(_ e: AgentEvent, _ run: LiveRun) {
        let ws: [AsyncThrowingStream<AgentEvent, Error>.Continuation] = sync {
            run.events.append(e)
            return Array(run.watchers.values)
        }
        for w in ws { w.yield(e) }
    }

    private static let systemPrompt = """
    You are Syph, the user's assistant, running in the Syph iPhone app while their computer is out of reach. \
    You have no tools here: no files, terminal, web or connectors. Answer from what you know and what the user tells you, \
    and say plainly when something needs their computer. Lead with the answer. Keep it brief for a phone screen. \
    Never invent links, file contents or numbers.
    """

    private func run(chatId: String, model ref: String, history: [Turn], run: LiveRun) async {
        let started = Date()
        let runId = "phone-run-\(UUID().uuidString.prefix(8))"
        var e = AgentEvent(type: "run_start"); e.runId = runId; e.model = ref; e.at = started.timeIntervalSince1970 * 1000
        push(e, run)

        let (provider, model) = PhoneKeys.split(ref)
        var content = ""
        var failure: TurnFailure?
        var errorText: String?
        do {
            var msgs: [[String: Any]] = [["role": "system", "content": Self.systemPrompt]]
            for t in history.suffix(40) where !t.content.isEmpty && t.threadUpdate == nil {
                msgs.append(["role": t.role.rawValue, "content": t.content])
            }
            var body: [String: Any] = ["model": model, "messages": msgs, "stream": true]
            if let eff = sync({ settings.effort }), eff != "auto", provider == "openrouter" { body["reasoning"] = ["effort": eff == "xhigh" || eff == "max" ? "high" : eff] }
            var req = URLRequest(url: PhoneKeys.baseURL(provider).appendingPathComponent("chat/completions"))
            req.httpMethod = "POST"
            req.timeoutInterval = 300
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.setValue("Bearer \(PhoneKeys.key(provider) ?? "")", forHTTPHeaderField: "authorization")
            if provider == "openrouter" {
                req.setValue("https://syph.app", forHTTPHeaderField: "HTTP-Referer")
                req.setValue("Syph", forHTTPHeaderField: "X-Title")
            }
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, res) = try await URLSession.shared.bytes(for: req)
            let code = (res as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(code) {
                var raw = ""
                for try await line in bytes.lines { raw += line; if raw.count > 4000 { break } }
                if code == 402 || raw.localizedCaseInsensitiveContains("insufficient") || raw.localizedCaseInsensitiveContains("credit") || raw.localizedCaseInsensitiveContains("balance") {
                    failure = TurnFailure(kind: "credits", provider: provider)
                } else {
                    let msg = ((try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]).flatMap { ($0["error"] as? [String: Any])?["message"] as? String }
                    errorText = msg ?? "\(Fmt.providerLabel(provider)) answered \(code)."
                }
            } else {
                var raw = ""
                var shown = 0
                for try await line in bytes.lines {
                    if Task.isCancelled { break }
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { break }
                    guard let obj = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any],
                          let choice = (obj["choices"] as? [[String: Any]])?.first,
                          let delta = choice["delta"] as? [String: Any],
                          let piece = delta["content"] as? String, !piece.isEmpty else { continue }
                    raw += piece
                    // Some models (MiniMax) think inside <think>…</think>: keep that out of the answer.
                    let visible = Self.withoutThinking(raw)
                    guard visible.count > shown else { continue }
                    let fresh = String(visible.dropFirst(shown))
                    shown = visible.count
                    content += fresh
                    var t = AgentEvent(type: "token"); t.text = fresh
                    push(t, run)
                }
            }
        } catch {
            if !Task.isCancelled { errorText = "Couldn't reach \(Fmt.providerLabel(provider)): \(error.localizedDescription)" }
        }

        if let errorText {
            var ev = AgentEvent(type: "error"); ev.error = errorText
            push(ev, run)
        }
        let answer = Turn(id: "a-\(UUID().uuidString.prefix(8))", role: .assistant, content: content.isEmpty && failure == nil ? (errorText ?? "Stopped.") : content,
                          runId: runId, model: ref, durationMs: Date().timeIntervalSince(started) * 1000, createdAt: iso(Date()), failure: failure, local: true)
        sync {
            if let i = chats.firstIndex(where: { $0.id == chatId }) {
                chats[i].turns.append(answer)
                chats[i].updatedAt = iso(Date())
            }
        }
        persist()
        var end = AgentEvent(type: "run_end"); end.runId = runId; end.content = content; end.status = errorText == nil ? "ok" : "error"
        push(end, run)
        let ws: [AsyncThrowingStream<AgentEvent, Error>.Continuation] = sync {
            run.done = true
            live[chatId] = nil
            let w = Array(run.watchers.values)
            run.watchers = [:]
            return w
        }
        for w in ws { w.finish() }
        emit("chats")
    }

    func follow(_ chatId: String) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { cont in
            let id = UUID()
            let replay: [AgentEvent]? = sync {
                guard let run = live[chatId], !run.done else { return nil }
                run.watchers[id] = cont
                return run.events
            }
            guard let replay else { cont.finish(); return }
            for e in replay { cont.yield(e) }
            cont.onTermination = { [weak self] _ in self?.sync { self?.live[chatId]?.watchers[id] = nil } }
        }
    }

    func stopChat(_ id: String) async throws { sync { live[id]?.task }?.cancel() }
    func rate(chatId: String, turnId: String, rating: String?) async throws {
        sync { if let i = chats.firstIndex(where: { $0.id == chatId }), let j = chats[i].turns.firstIndex(where: { $0.id == turnId }) { chats[i].turns[j].rating = rating } }
        persist()
    }
    func resolveApproval(_ id: String, allow: Bool) async throws {}
    func turnIntoEval(runId: String, rating: String, expectation: String?) async throws { throw SyphError.needsComputer("Eval cases") }

    func searchChats(_ query: String) async throws -> [ChatHit] {
        let q = query.lowercased()
        return sync { chats }.filter { c in c.title.lowercased().contains(q) || c.turns.contains { $0.content.lowercased().contains(q) } }
            .map { ChatHit(id: $0.id, title: $0.title, updatedAt: $0.updatedAt ?? "") }
    }

    // MARK: Everything that lives on the computer

    func tasks() async throws -> [SyphTask] { throw SyphError.needsComputer("Scheduled tasks") }
    func saveTask(_ draft: TaskDraft) async throws { throw SyphError.needsComputer("Scheduled tasks") }
    func patchTask(_ id: String, _ patch: JSONValue) async throws { throw SyphError.needsComputer("Scheduled tasks") }
    func deleteTask(_ id: String) async throws { throw SyphError.needsComputer("Scheduled tasks") }
    func runTask(_ id: String) async throws { throw SyphError.needsComputer("Scheduled tasks") }
    func proposals() async throws -> [Proposal] { throw SyphError.needsComputer("Evolve") }
    func decide(_ id: String, decision: String, model: String?) async throws { throw SyphError.needsComputer("Evolve") }
    func evals() async throws -> EvalsResponse { throw SyphError.needsComputer("Evolve") }
    func runEvals(model: String?) async throws { throw SyphError.needsComputer("Evolve") }
    func evolve(model: String?) async throws { throw SyphError.needsComputer("Evolve") }
    func jobs() async throws -> [Job] { [] }
    func exportData() async throws -> ExportResult { throw SyphError.needsComputer("Exporting") }
    func connectors() async throws -> [Connector] { throw SyphError.needsComputer("Connectors") }
    func saveConnectorFields(_ id: String, values: [String: String]) async throws { throw SyphError.needsComputer("Connectors") }
    func setConnectorEnabled(_ id: String, enabled: Bool) async throws { throw SyphError.needsComputer("Connectors") }
    func signIn(_ id: String) async throws -> URL { throw SyphError.needsComputer("Connectors") }
    func disconnect(_ id: String) async throws { throw SyphError.needsComputer("Connectors") }
    func removeConnector(_ id: String) async throws { throw SyphError.needsComputer("Connectors") }
    func chatFiles(_ chatId: String) async throws -> [FileRef] { [] }
    func download(_ path: String) async throws -> URL { throw SyphError.needsComputer("Opening files on your computer") }
    func github() async throws -> GithubState { GithubState(connected: false, state: "needs_computer") }
    func githubRepos(query: String?) async throws -> [GithubRepo] { throw SyphError.needsComputer("GitHub") }
    func repos(projectId: String?, chatId: String?) async throws -> [RepoStatus] { [] }
    func linkRepo(_ repo: String, scope: String, projectId: String?, chatId: String?) async throws { throw SyphError.needsComputer("Linking repos") }
    func unlinkRepo(_ path: String, projectId: String?, chatId: String?) async throws { throw SyphError.needsComputer("Linking repos") }
    func pullRepo(_ path: String) async throws -> RepoActionResult { throw SyphError.needsComputer("Git") }
    func pushRepo(_ path: String) async throws -> RepoActionResult { throw SyphError.needsComputer("Git") }
    func setActiveRepo(chatId: String, path: String?) async throws {}
    func uiState() async throws -> UiState { throw SyphError.needsComputer("Interface changes") }
    func setUiEnabled(_ id: String, enabled: Bool) async throws -> UiState { throw SyphError.needsComputer("Interface changes") }
    func setSafeMode(_ on: Bool) async throws -> UiState { throw SyphError.needsComputer("Interface changes") }
    func removeUi(_ id: String) async throws -> UiState { throw SyphError.needsComputer("Interface changes") }

    func events() -> AsyncStream<ServerEvent> {
        AsyncStream { cont in
            let id = UUID()
            sync { feed[id] = cont }
            cont.onTermination = { [weak self] _ in self?.sync { self?.feed[id] = nil } }
        }
    }
}
