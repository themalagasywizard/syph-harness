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
}

struct SyphError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}
