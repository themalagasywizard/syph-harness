import Foundation

/// Talks to a Syph server (`npm start` / Syph.exe) over its HTTP + SSE API.
final class RemoteBackend: SyphBackend, @unchecked Sendable {
    let base: URL
    /// Device token from QR pairing. Not needed from the computer itself (or the Simulator).
    let token: String?
    private let session: URLSession
    private let streamSession: URLSession

    init(base: URL, token: String? = nil) {
        self.base = base
        self.token = token
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
        let s = URLSessionConfiguration.default
        s.timeoutIntervalForRequest = 600
        s.timeoutIntervalForResource = 60 * 60 * 24
        streamSession = URLSession(configuration: s)
    }

    // MARK: Plumbing

    private func url(_ path: String) -> URL {
        URL(string: "/api" + path, relativeTo: base)!.absoluteURL
    }

    private static let decoder = JSONDecoder()

    private func authorize(_ req: inout URLRequest) {
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    }

    /// Trade the one-time code from the desktop's QR for this phone's device token.
    static func pair(base: URL, code: String, name: String) async throws -> String {
        var req = URLRequest(url: URL(string: "/api/pair", relativeTo: base)!.absoluteURL)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(["code": code, "name": name])
        let data: Data, res: URLResponse
        do { (data, res) = try await URLSession.shared.data(for: req) }
        catch { throw SyphError(message: "Can't reach your computer at \(base.host() ?? "?"). Check your phone and computer are on the same Wi-Fi, and Syph is open.") }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw SyphError(message: body?["error"] as? String ?? "Pairing failed (\(http.statusCode)).")
        }
        guard let token = body?["token"] as? String else { throw SyphError(message: "Pairing failed: no token came back.") }
        return token
    }

    @discardableResult
    private func send(_ method: String, _ path: String, _ body: JSONValue? = nil) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data, res: URLResponse
        do {
            (data, res) = try await session.data(for: req)
        } catch {
            throw SyphError(message: "Can't reach Syph at \(base.host() ?? base.absoluteString). Check it's running on your computer.")
        }
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let msg = (try? Self.decoder.decode([String: String].self, from: data))?["error"] ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw SyphError(message: msg)
        }
        return data
    }

    private func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        try decode(await send("GET", path))
    }

    private func call<T: Decodable>(_ method: String, _ path: String, _ body: JSONValue? = nil, as: T.Type = T.self) async throws -> T {
        try decode(await send(method, path, body ?? [:]))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try Self.decoder.decode(T.self, from: data) }
        catch { throw SyphError(message: "Unexpected answer from Syph (\(error.localizedDescription)).") }
    }

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/:"))) ?? s
    }

    // MARK: State & settings

    func state() async throws -> AppState { try await get("/state") }
    func models() async throws -> [ModelInfo] { try await get("/models") }
    func updateSettings(_ patch: JSONValue) async throws { try await send("PUT", "/settings", patch) }
    func profile(_ ref: String) async throws -> Profile { try await get("/profiles/\(enc(ref))") }
    func saveProfile(_ ref: String, _ profile: Profile) async throws {
        let body = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(profile))
        try await send("PUT", "/profiles/\(enc(ref))", body)
    }

    // MARK: Key

    func keyStatus() async throws -> KeyStatus { try await get("/keys/openrouter") }
    func saveKey(_ key: String) async throws -> KeyStatus { try await call("PUT", "/keys/openrouter", ["key": .string(key)]) }
    func checkKey() async throws -> KeyStatus { try await call("POST", "/keys/openrouter/check") }
    func removeKey() async throws -> KeyStatus { try await call("DELETE", "/keys/openrouter") }

    // MARK: Projects

    func project(_ id: String) async throws -> ProjectDetail { try await get("/projects/\(id)") }
    func projectThreads(_ id: String) async throws -> ProjectThreads { try await get("/projects/\(id)/threads") }
    func createProject(name: String, description: String, instructions: String) async throws -> Project {
        try await call("POST", "/projects", ["name": .string(name), "description": .string(description), "instructions": .string(instructions)])
    }
    func updateProject(_ id: String, _ patch: JSONValue) async throws { try await send("PUT", "/projects/\(id)", patch) }
    func deleteProject(_ id: String) async throws { try await send("DELETE", "/projects/\(id)") }

    // MARK: Chats

    func chat(_ id: String) async throws -> Chat { try await get("/chats/\(id)") }
    func createChat(projectId: String?, model: String?) async throws -> Chat {
        try await call("POST", "/chats", ["projectId": .str(projectId), "model": .str(model)])
    }
    func patchChat(_ id: String, _ patch: JSONValue) async throws { try await send("PATCH", "/chats/\(id)", patch) }
    func deleteChat(_ id: String) async throws { try await send("DELETE", "/chats/\(id)") }
    func sendMessage(_ chatId: String, text: String, model: String?) async throws {
        try await send("POST", "/chats/\(chatId)/messages", ["text": .string(text), "model": .str(model)])
    }
    func stopChat(_ id: String) async throws { try await send("POST", "/chats/\(id)/stop", [:]) }
    func rate(chatId: String, turnId: String, rating: String?) async throws {
        try await send("POST", "/chats/\(chatId)/rate", ["turnId": .string(turnId), "rating": .str(rating)])
    }
    func resolveApproval(_ id: String, allow: Bool) async throws { try await send("POST", "/approvals/\(id)", ["allow": .bool(allow)]) }
    func turnIntoEval(runId: String, rating: String, expectation: String?) async throws {
        try await send("POST", "/runs/\(runId)/eval", ["rating": .string(rating), "expectation": .str(expectation)])
    }

    func follow(_ chatId: String) -> AsyncThrowingStream<AgentEvent, Error> {
        sse(url("/chats/\(chatId)/stream"), as: AgentEvent.self)
    }

    func events() -> AsyncStream<ServerEvent> {
        let inner = sse(url("/events"), as: ServerEvent.self)
        return AsyncStream { cont in
            let t = Task {
                do { for try await e in inner { cont.yield(e) } } catch {}
                cont.finish()
            }
            cont.onTermination = { _ in t.cancel() }
        }
    }

    /// Reads a `text/event-stream` and yields each `data:` payload decoded as `T`.
    private func sse<T: Decodable & Sendable>(_ url: URL, as: T.Type) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                do {
                    var req = URLRequest(url: url)
                    req.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    authorize(&req)
                    let (bytes, res) = try await streamSession.bytes(for: req)
                    if let http = res as? HTTPURLResponse, http.statusCode != 200 {
                        throw SyphError(message: "Stream failed: \(http.statusCode)")
                    }
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data: ") else { continue }
                        if let d = line.dropFirst(6).data(using: .utf8), let e = try? Self.decoder.decode(T.self, from: d) {
                            cont.yield(e)
                        }
                    }
                    cont.finish()
                } catch {
                    cont.finish(throwing: error)
                }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Tasks

    func tasks() async throws -> [SyphTask] { try await get("/tasks") }
    func saveTask(_ draft: TaskDraft) async throws { try await send("POST", "/tasks", draft.json) }
    func patchTask(_ id: String, _ patch: JSONValue) async throws { try await send("PATCH", "/tasks/\(id)", patch) }
    func deleteTask(_ id: String) async throws { try await send("DELETE", "/tasks/\(id)") }
    func runTask(_ id: String) async throws { try await send("POST", "/tasks/\(id)/run", [:]) }

    // MARK: Evolve

    func proposals() async throws -> [Proposal] { try await get("/proposals") }
    func decide(_ id: String, decision: String, model: String?) async throws {
        try await send("POST", "/proposals/\(id)/\(decision)", ["model": .str(model)])
    }
    func evals() async throws -> EvalsResponse { try await get("/evals") }
    func runEvals(model: String?) async throws { try await send("POST", "/evals/run", ["model": .str(model)]) }
    func evolve(model: String?) async throws { try await send("POST", "/evolve/run", ["model": .str(model)]) }
    func jobs() async throws -> [Job] { try await get("/jobs") }
    func exportData() async throws -> ExportResult { try await call("POST", "/export") }

    // MARK: Connectors

    func connectors() async throws -> [Connector] { try await get("/connectors") }
    func saveConnectorFields(_ id: String, values: [String: String]) async throws {
        try await send("PUT", "/connectors/\(id)/fields", ["values": .object(values.mapValues { .string($0) })])
    }
    func setConnectorEnabled(_ id: String, enabled: Bool) async throws { try await send("POST", "/connectors/\(id)/enabled", ["enabled": .bool(enabled)]) }
    func signIn(_ id: String) async throws -> URL {
        let r: [String: String] = try await call("POST", "/connectors/\(id)/signin")
        guard let s = r["url"], let u = URL(string: s) else { throw SyphError(message: "No sign-in link came back.") }
        return u
    }
    func disconnect(_ id: String) async throws { try await send("POST", "/connectors/\(id)/disconnect", [:]) }
    func removeConnector(_ id: String) async throws { try await send("DELETE", "/connectors/\(id)") }

    // MARK: Files

    func chatFiles(_ chatId: String) async throws -> [FileRef] { try await get("/chats/\(chatId)/files") }

    func download(_ path: String) async throws -> URL {
        var c = URLComponents(url: url("/files/raw"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 120
        authorize(&req)
        let (tmp, res) = try await streamSession.download(for: req)
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let msg = (try? Self.decoder.decode([String: String].self, from: Data(contentsOf: tmp)))?["error"] ?? "Couldn't download the file (\(http.statusCode))."
            throw SyphError(message: msg)
        }
        // Keep the real name so Quick Look picks the right viewer and sharing saves it as itself.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(Self.fileName(path))
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }

    /// Last part of a Windows or POSIX path.
    static func fileName(_ path: String) -> String {
        String(path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? "file")
    }

    // MARK: GitHub & repos

    private func query(_ path: String, _ items: [String: String?]) -> String {
        var c = URLComponents()
        c.queryItems = items.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        let q = c.percentEncodedQuery ?? ""
        return q.isEmpty ? path : path + "?" + q
    }

    func github() async throws -> GithubState { try await get("/github") }
    func githubRepos(query q: String?) async throws -> [GithubRepo] { try await get(query("/github/repos", ["q": q])) }
    func repos(projectId: String?, chatId: String?) async throws -> [RepoStatus] {
        try await get(query("/repos", ["projectId": projectId, "chatId": chatId]))
    }
    func linkRepo(_ repo: String, scope: String, projectId: String?, chatId: String?) async throws {
        try await send("POST", "/repos/link", ["repo": .string(repo), "scope": .string(scope), "projectId": .str(projectId), "chatId": .str(chatId)])
    }
    func unlinkRepo(_ path: String, projectId: String?, chatId: String?) async throws {
        try await send("POST", "/repos/unlink", ["path": .string(path), "projectId": .str(projectId), "chatId": .str(chatId)])
    }
    func pullRepo(_ path: String) async throws -> RepoActionResult { try await call("POST", "/repos/pull", ["path": .string(path)]) }
    func pushRepo(_ path: String) async throws -> RepoActionResult { try await call("POST", "/repos/push", ["path": .string(path)]) }
    func setActiveRepo(chatId: String, path: String?) async throws { try await send("PUT", "/chats/\(chatId)/active-repo", ["path": .str(path)]) }

    // MARK: Interface

    func uiState() async throws -> UiState { try await get("/ui") }
    func setUiEnabled(_ id: String, enabled: Bool) async throws -> UiState { try await call("POST", "/ui/\(enc(id))/enabled", ["enabled": .bool(enabled)]) }
    func setSafeMode(_ on: Bool) async throws -> UiState { try await call("PUT", "/ui/safe", ["on": .bool(on)]) }
    func removeUi(_ id: String) async throws -> UiState { try await call("DELETE", "/ui/\(enc(id))") }

    // MARK: Newer endpoints (threads, skills, keys, usage, folders, terminal, attachments, search, sync)

    func sendMessage(_ chatId: String, text: String, model: String?, attachments: [Attachment]) async throws {
        var body: [String: JSONValue] = ["text": .string(text), "model": .str(model)]
        if !attachments.isEmpty {
            body["attachments"] = .array(attachments.map { ["name": .string($0.name), "path": .string($0.path), "kind": .string($0.kind), "size": .number($0.size)] })
        }
        try await send("POST", "/chats/\(chatId)/messages", .object(body))
    }
    func queueMessage(_ chatId: String, text: String) async throws { try await send("POST", "/chats/\(chatId)/queue", ["text": .string(text)]) }
    func uploadAttachment(_ chatId: String, name: String, data: Data) async throws -> Attachment {
        try await call("POST", "/chats/\(chatId)/attachments", ["name": .string(name), "data": .string(data.base64EncodedString())])
    }
    func allowAlways(_ approvalId: String) async throws { try await send("POST", "/approvals/\(approvalId)", ["always": true]) }

    func startThread(_ id: String, model: String) async throws { try await send("POST", "/threads/\(id)/start-model", ["model": .string(model)]) }
    func resolveThread(_ id: String, resolved: Bool) async throws { try await send("POST", "/threads/\(id)/resolve", ["resolved": .bool(resolved)]) }
    func stopThread(_ id: String) async throws { try await send("POST", "/threads/\(id)/stop", [:]) }
    func deleteThread(_ id: String) async throws { try await send("DELETE", "/threads/\(id)") }

    func skills() async throws -> SkillsResponse { try await get("/skills") }
    func setSkillActive(_ name: String, active: Bool) async throws { try await send("PUT", "/skills/\(enc(name))", ["active": .bool(active)]) }
    func saveSkill(_ name: String, description: String, body: String) async throws {
        try await send("PUT", "/skills/\(enc(name))", ["description": .string(description), "body": .string(body)])
    }
    func createSkill(_ name: String, description: String, body: String) async throws {
        try await send("POST", "/skills", ["name": .string(name), "description": .string(description), "body": .string(body)])
    }
    func deleteSkill(_ name: String) async throws { try await send("DELETE", "/skills/\(enc(name))") }

    func providerKey(_ provider: String) async throws -> KeyStatus { try await get("/keys/\(provider)") }
    func saveProviderKey(_ provider: String, key: String) async throws -> KeyStatus { try await call("PUT", "/keys/\(provider)", ["key": .string(key)]) }
    func checkProviderKey(_ provider: String) async throws -> KeyStatus { try await call("POST", "/keys/\(provider)/check") }
    func removeProviderKey(_ provider: String) async throws -> KeyStatus { try await call("DELETE", "/keys/\(provider)") }
    func usage(_ provider: String, model: String?, fresh: Bool) async throws -> ProviderUsage {
        try await get(query("/usage/\(provider)", ["model": model, "fresh": fresh ? "1" : nil]))
    }

    func folders(projectId: String?, chatId: String?) async throws -> [FolderLink] {
        try await get(query("/folders", ["projectId": projectId, "chatId": chatId]))
    }
    func linkFolder(_ path: String, access: String, projectId: String?, chatId: String?) async throws {
        try await send("POST", "/folders/link", ["path": .string(path), "access": .string(access), "projectId": .str(projectId), "chatId": .str(chatId)])
    }
    func unlinkFolder(_ path: String, projectId: String?, chatId: String?) async throws {
        try await send("POST", "/folders/unlink", ["path": .string(path), "projectId": .str(projectId), "chatId": .str(chatId)])
    }
    func setFolderAccess(_ path: String, access: String, projectId: String?, chatId: String?) async throws {
        try await send("POST", "/folders/access", ["path": .string(path), "access": .string(access), "projectId": .str(projectId), "chatId": .str(chatId)])
    }
    func terminal(_ chatId: String) async throws -> TerminalState { try await get("/chats/\(chatId)/terminal") }
    func stopCommand(_ id: String) async throws { try await send("POST", "/terminal/\(id)/stop", [:]) }
    func endTerminalSession(_ chatId: String) async throws { try await send("DELETE", "/chats/\(chatId)/terminal/session") }

    func disconnect(_ id: String, account: String?) async throws {
        try await send("POST", "/connectors/\(id)/disconnect", ["account": .str(account)])
    }
    func setDefaultAccount(_ id: String, account: String) async throws {
        try await send("POST", "/connectors/\(id)/default", ["account": .string(account)])
    }

    func searchChats(_ q: String) async throws -> [ChatHit] { try await get(query("/search/chats", ["q": q])) }

    func importChat(phoneId: String, title: String, projectId: String?, model: String?, turns: [Turn]) async throws -> String {
        let list: [JSONValue] = turns.map { t in
            var o: [String: JSONValue] = ["role": .string(t.role.rawValue), "content": .string(t.content)]
            if let m = t.model { o["model"] = .string(m) }
            if let c = t.createdAt { o["createdAt"] = .string(c) }
            if let d = t.durationMs { o["durationMs"] = .number(d) }
            return .object(o)
        }
        let r: [String: String] = try await call("POST", "/chats/import", ["phoneId": .string(phoneId), "title": .string(title), "projectId": .str(projectId), "model": .str(model), "turns": .array(list)])
        guard let id = r["id"] else { throw SyphError(message: "Syncing failed: no chat id came back.") }
        return id
    }
}
