import Foundation

/// Everything the app can ask of Syph. `RemoteBackend` talks to the Syph server on a computer
/// (the same API the desktop UI uses); `DemoBackend` is a self-contained stand-in for trying the app.
protocol SyphBackend: AnyObject, Sendable {
    // State & settings
    func state() async throws -> AppState
    func models() async throws -> [ModelInfo]
    func updateSettings(_ patch: JSONValue) async throws
    func profile(_ ref: String) async throws -> Profile
    func saveProfile(_ ref: String, _ profile: Profile) async throws

    // OpenRouter key
    func keyStatus() async throws -> KeyStatus
    func saveKey(_ key: String) async throws -> KeyStatus
    func checkKey() async throws -> KeyStatus
    func removeKey() async throws -> KeyStatus

    // Projects
    func project(_ id: String) async throws -> ProjectDetail
    func createProject(name: String, description: String, instructions: String) async throws -> Project
    func updateProject(_ id: String, _ patch: JSONValue) async throws
    func deleteProject(_ id: String) async throws
    /// The project's coordinator chat (made on first use) and its threads.
    func projectThreads(_ id: String) async throws -> ProjectThreads

    // Chats
    func chat(_ id: String) async throws -> Chat
    func createChat(projectId: String?, model: String?) async throws -> Chat
    func patchChat(_ id: String, _ patch: JSONValue) async throws
    func deleteChat(_ id: String) async throws
    func sendMessage(_ chatId: String, text: String, model: String?) async throws
    /// Follows a chat's current run: replays it from the start, then streams until it ends.
    func follow(_ chatId: String) -> AsyncThrowingStream<AgentEvent, Error>
    func stopChat(_ id: String) async throws
    func rate(chatId: String, turnId: String, rating: String?) async throws
    func resolveApproval(_ id: String, allow: Bool) async throws
    func turnIntoEval(runId: String, rating: String, expectation: String?) async throws

    // Tasks
    func tasks() async throws -> [SyphTask]
    func saveTask(_ draft: TaskDraft) async throws
    func patchTask(_ id: String, _ patch: JSONValue) async throws
    func deleteTask(_ id: String) async throws
    func runTask(_ id: String) async throws

    // Evolve
    func proposals() async throws -> [Proposal]
    func decide(_ id: String, decision: String, model: String?) async throws
    func evals() async throws -> EvalsResponse
    func runEvals(model: String?) async throws
    func evolve(model: String?) async throws
    func jobs() async throws -> [Job]
    func exportData() async throws -> ExportResult

    // Connectors
    func connectors() async throws -> [Connector]
    func saveConnectorFields(_ id: String, values: [String: String]) async throws
    func setConnectorEnabled(_ id: String, enabled: Bool) async throws
    func signIn(_ id: String) async throws -> URL
    func disconnect(_ id: String) async throws
    func removeConnector(_ id: String) async throws

    // Files Syph made
    func chatFiles(_ chatId: String) async throws -> [FileRef]
    /// Downloads a file from the computer into a temporary file on the phone (for Quick Look and sharing).
    func download(_ path: String) async throws -> URL

    // GitHub and linked repos
    func github() async throws -> GithubState
    func githubRepos(query: String?) async throws -> [GithubRepo]
    func repos(projectId: String?, chatId: String?) async throws -> [RepoStatus]
    func linkRepo(_ repo: String, scope: String, projectId: String?, chatId: String?) async throws
    func unlinkRepo(_ path: String, projectId: String?, chatId: String?) async throws
    func pullRepo(_ path: String) async throws -> RepoActionResult
    func pushRepo(_ path: String) async throws -> RepoActionResult
    func setActiveRepo(chatId: String, path: String?) async throws

    // Interface changes Syph made
    func uiState() async throws -> UiState
    func setUiEnabled(_ id: String, enabled: Bool) async throws -> UiState
    func setSafeMode(_ on: Bool) async throws -> UiState
    func removeUi(_ id: String) async throws -> UiState

    /// App-wide change feed: jobs, chats, tasks, proposals, connectors.
    func events() -> AsyncStream<ServerEvent>

    // Newer endpoints, with defaults in the extension below.
    var capabilities: BackendCapabilities { get }
    func sendMessage(_ chatId: String, text: String, model: String?, attachments: [Attachment]) async throws
    func queueMessage(_ chatId: String, text: String) async throws
    func uploadAttachment(_ chatId: String, name: String, data: Data) async throws -> Attachment
    func allowAlways(_ approvalId: String) async throws
    func startThread(_ id: String, model: String) async throws
    func resolveThread(_ id: String, resolved: Bool) async throws
    func stopThread(_ id: String) async throws
    func deleteThread(_ id: String) async throws
    func skills() async throws -> SkillsResponse
    func setSkillActive(_ name: String, active: Bool) async throws
    func saveSkill(_ name: String, description: String, body: String) async throws
    func createSkill(_ name: String, description: String, body: String) async throws
    func deleteSkill(_ name: String) async throws
    func providerKey(_ provider: String) async throws -> KeyStatus
    func saveProviderKey(_ provider: String, key: String) async throws -> KeyStatus
    func checkProviderKey(_ provider: String) async throws -> KeyStatus
    func removeProviderKey(_ provider: String) async throws -> KeyStatus
    func usage(_ provider: String, model: String?, fresh: Bool) async throws -> ProviderUsage
    func folders(projectId: String?, chatId: String?) async throws -> [FolderLink]
    func linkFolder(_ path: String, access: String, projectId: String?, chatId: String?) async throws
    func unlinkFolder(_ path: String, projectId: String?, chatId: String?) async throws
    func setFolderAccess(_ path: String, access: String, projectId: String?, chatId: String?) async throws
    func terminal(_ chatId: String) async throws -> TerminalState
    func stopCommand(_ id: String) async throws
    func endTerminalSession(_ chatId: String) async throws
    func disconnect(_ id: String, account: String?) async throws
    func setDefaultAccount(_ id: String, account: String) async throws
    func searchChats(_ query: String) async throws -> [ChatHit]
    func importChat(phoneId: String, title: String, projectId: String?, model: String?, turns: [Turn]) async throws -> String
}

/// What a backend can do. The phone on its own (standalone) has no computer: no folders, terminal,
/// repos, files on disk, tasks, Evolve or connectors. Screens hide or explain what isn't there.
struct BackendCapabilities: Equatable, Sendable {
    /// Runs on Syph on a computer (folders, terminal, repos, files, tasks, Evolve, connectors, threads).
    var computer: Bool
    var projects: Bool
    var skills: Bool

    static let full = BackendCapabilities(computer: true, projects: true, skills: true)
    static let phoneOnly = BackendCapabilities(computer: false, projects: false, skills: false)
}

/// Newer endpoints (the desktop's threads, skills, usage, keys, folders, terminal, attachments, search and
/// phone sync). Backends that can't do one fall back to these defaults, which explain why.
extension SyphBackend {
    var capabilities: BackendCapabilities { .full }

    func sendMessage(_ chatId: String, text: String, model: String?, attachments: [Attachment]) async throws {
        try await sendMessage(chatId, text: text, model: model)
    }
    /// A message sent while the chat works: the agent reads it at its next step.
    func queueMessage(_ chatId: String, text: String) async throws { throw SyphError.needsComputer("Sending while Syph works") }
    func uploadAttachment(_ chatId: String, name: String, data: Data) async throws -> Attachment { throw SyphError.needsComputer("Attaching files") }
    func allowAlways(_ approvalId: String) async throws { try await resolveApproval(approvalId, allow: true) }

    // Threads
    func startThread(_ id: String, model: String) async throws { throw SyphError.needsComputer("Threads") }
    func resolveThread(_ id: String, resolved: Bool) async throws { throw SyphError.needsComputer("Threads") }
    func stopThread(_ id: String) async throws { throw SyphError.needsComputer("Threads") }
    func deleteThread(_ id: String) async throws { try await deleteChat(id) }

    // Skills
    func skills() async throws -> SkillsResponse { throw SyphError.needsComputer("Skills") }
    func setSkillActive(_ name: String, active: Bool) async throws { throw SyphError.needsComputer("Skills") }
    func saveSkill(_ name: String, description: String, body: String) async throws { throw SyphError.needsComputer("Skills") }
    func createSkill(_ name: String, description: String, body: String) async throws { throw SyphError.needsComputer("Skills") }
    func deleteSkill(_ name: String) async throws { throw SyphError.needsComputer("Skills") }

    // Provider keys and usage. provider: openrouter, minimax or gemini.
    func providerKey(_ provider: String) async throws -> KeyStatus {
        if provider == "openrouter" { return try await keyStatus() }
        return KeyStatus(set: false)
    }
    func saveProviderKey(_ provider: String, key: String) async throws -> KeyStatus {
        if provider == "openrouter" { return try await saveKey(key) }
        throw SyphError.needsComputer("This provider")
    }
    func checkProviderKey(_ provider: String) async throws -> KeyStatus {
        if provider == "openrouter" { return try await checkKey() }
        throw SyphError.needsComputer("This provider")
    }
    func removeProviderKey(_ provider: String) async throws -> KeyStatus {
        if provider == "openrouter" { return try await removeKey() }
        throw SyphError.needsComputer("This provider")
    }
    func usage(_ provider: String, model: String?, fresh: Bool) async throws -> ProviderUsage {
        ProviderUsage(provider: provider, meters: [], error: "No usage to show.")
    }

    // Folders and terminal on the computer
    func folders(projectId: String?, chatId: String?) async throws -> [FolderLink] { [] }
    func linkFolder(_ path: String, access: String, projectId: String?, chatId: String?) async throws { throw SyphError.needsComputer("Linking folders") }
    func unlinkFolder(_ path: String, projectId: String?, chatId: String?) async throws { throw SyphError.needsComputer("Linking folders") }
    func setFolderAccess(_ path: String, access: String, projectId: String?, chatId: String?) async throws { throw SyphError.needsComputer("Linking folders") }
    func terminal(_ chatId: String) async throws -> TerminalState { throw SyphError.needsComputer("The terminal") }
    func stopCommand(_ id: String) async throws { throw SyphError.needsComputer("The terminal") }
    func endTerminalSession(_ chatId: String) async throws { throw SyphError.needsComputer("The terminal") }

    // Connectors with several accounts
    func disconnect(_ id: String, account: String?) async throws { try await disconnect(id) }
    func setDefaultAccount(_ id: String, account: String) async throws { throw SyphError.needsComputer("Accounts") }

    // Search and sync
    func searchChats(_ query: String) async throws -> [ChatHit] { [] }
    /// Bring in a chat made on the phone while it ran on its own. Returns the chat's id on the computer.
    func importChat(phoneId: String, title: String, projectId: String?, model: String?, turns: [Turn]) async throws -> String {
        throw SyphError.needsComputer("Syncing")
    }
}

struct SyphError: LocalizedError {
    var message: String
    var errorDescription: String? { message }

    static func needsComputer(_ what: String) -> SyphError {
        SyphError(message: "\(what) needs Syph on your computer. Pair your phone in Settings, or open Syph on the computer.")
    }
}
