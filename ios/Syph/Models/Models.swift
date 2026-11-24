import Foundation

// Shapes mirror ui/src/api.ts (and @syph/core types) so the phone speaks the same API as the desktop.
// Decoding is forgiving: unknown fields are ignored and most fields are optional.

// MARK: - Free-form JSON

enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? { if case .string(let s) = self { return s }; return nil }

    /// Compact one-line form, like the desktop's `k=v` tool summaries.
    var inlineSummary: String {
        switch self {
        case .object(let o):
            return o.keys.sorted().map { "\($0)=\(o[$0]!.compact)" }.joined(separator: " ")
        default: return compact
        }
    }

    var compact: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .string(let s): return "\"\(s)\""
        case .array(let a): return "[" + a.map(\.compact).joined(separator: ",") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\"\($0)\":\(o[$0]!.compact)" }.joined(separator: ",") + "}"
        }
    }

    var pretty: String {
        guard let data = try? JSONEncoder.pretty.encode(self), let s = String(data: data, encoding: .utf8) else { return compact }
        return s
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral, ExpressibleByIntegerLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    init(stringLiteral v: String) { self = .string(v) }
    init(booleanLiteral v: Bool) { self = .bool(v) }
    init(floatLiteral v: Double) { self = .number(v) }
    init(integerLiteral v: Int) { self = .number(Double(v)) }
    init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(nilLiteral: ()) { self = .null }
    static func str(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
}

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }()
}

// MARK: - Chats

enum Role: String, Codable, Sendable { case user, assistant }

struct ToolCallView: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var args: JSONValue?
    var result: String?
    var ok: Bool?
    var ms: Double?
}

struct Turn: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var role: Role
    var content: String
    var runId: String?
    var model: String?
    var toolCalls: [ToolCallView]?
    var rating: String?
    /// Files this answer created or changed, with their full path on the computer.
    var files: [FileRef]?
    /// The checklist the agent kept for a multi-step task, as it ended.
    var plan: [PlanStep]?
    /// How long the answer took, start to finish.
    var durationMs: Double?
    var createdAt: String?
    /// In a coordinator chat: a card about one of its threads.
    var threadUpdate: ThreadUpdate?
    /// A turn Syph started for the coordinator after a thread update (not typed by the user).
    var auto: Bool?
    /// The agent stopped to ask you something (ask_user): answer with a choice or in your own words.
    var question: UserQuestion?
    /// The run failed for a reason with its own card (the provider ran out of credit).
    var failure: TurnFailure?
    /// Files sent with this message.
    var attachments: [Attachment]?
    /// Messages you sent while it worked.
    var steering: [String]?
    /// Why a long run stopped: done, budget, repeated_error, question or checks_failed.
    var stopReason: String?
    var usage: TurnUsage?
    /// Written on this phone while it had no computer, and not synced yet.
    var local: Bool?
}

struct UserQuestion: Codable, Hashable, Sendable {
    var question: String
    var options: [String]
    /// "choice" (default) or "model": pick the model a thread should start with.
    var kind: String?
    var recommendedModel: String?
    var pendingStart: Bool?
}

struct TurnFailure: Codable, Hashable, Sendable {
    /// "credits".
    var kind: String
    var provider: String
    var affordable: Double?
}

struct TurnUsage: Codable, Hashable, Sendable {
    var promptTokens: Double?
    var completionTokens: Double?
    var costUsd: Double?
}

struct Attachment: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var path: String
    /// image, document, text or other.
    var kind: String
    var size: Double
    var id: String { path }
}

/// A card Syph posts in a project's coordinator chat when one of its threads ends or needs you.
struct ThreadUpdate: Codable, Hashable, Sendable {
    var threadId: String
    var title: String
    /// queued, working, blocked, review_ready, done, failed or stopped.
    var state: String
    var summary: String
    var needs: String?
    var costUsd: Double?
    var filesChanged: Int?
}

/// One of a project's threads, as `/api/projects/:id/threads` lists it.
struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var updatedAt: String?
    var status: String?
    var threadState: String?
    var summary: String?
    var resolved: Bool?
    var costUsd: Double?
}

struct ProjectThreads: Codable, Hashable, Sendable {
    var coordinatorId: String
    var coordinatorStatus: String?
    var threads: [ThreadSummary]
}

struct PlanStep: Codable, Hashable, Sendable {
    var text: String
    /// "pending", "in_progress" or "done".
    var status: String
}

struct FileRef: Codable, Hashable, Sendable, Identifiable {
    /// Absolute path on the computer.
    var path: String
    var name: String
    /// "created" or "modified".
    var action: String
    var size: Double
    var rel: String?
    var exists: Bool?
    var id: String { path }
}

struct ChatSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var projectId: String?
    var model: String?
    var updatedAt: String?
    /// "running" while working on the server, "waiting" when it needs an approval.
    var status: String?
    /// "coordinator" for a project's main chat, "thread" for a chat it started.
    var role: String?
    var parentId: String?
    /// Who started a thread: coordinator, user or task.
    var origin: String?
    var threadState: String?
    var summary: String?
    var resolved: Bool?
}

struct Chat: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var projectId: String?
    var model: String?
    var updatedAt: String?
    var turns: [Turn]
    var repos: [RepoLink]?
    var activeRepo: String?
    var running: Bool?
    var role: String?
    var parentId: String?
    var threadState: String?
}

// MARK: - Repos & GitHub

struct RepoLink: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var url: String
    /// Folder of the clone on the computer.
    var path: String
    var connector: String?
    var connectedAt: String?
    var id: String { path }
}

struct RepoStatus: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var url: String
    var path: String
    var connectedAt: String?
    /// "project" or "chat".
    var scope: String
    var exists: Bool
    var branch: String?
    var dirty: Int?
    var ahead: Int?
    var behind: Int?
    var upstream: String?
    var active: Bool?
    var error: String?
    var id: String { path }
}

struct GithubState: Codable, Hashable, Sendable {
    var connected: Bool
    var account: String?
    var state: String
    var error: String?
}

struct GithubRepo: Codable, Hashable, Sendable, Identifiable {
    var full_name: String
    var name: String
    var owner: String
    var `private`: Bool
    var description: String?
    var default_branch: String?
    var html_url: String
    var pushed_at: String?
    var fork: Bool?
    var archived: Bool?
    var id: String { full_name }
}

struct RepoActionResult: Codable, Sendable {
    var ok: Bool
    var output: String?
    var status: RepoStatus?
}

// MARK: - Interface changes Syph made

struct UiItem: Codable, Hashable, Sendable, Identifiable {
    struct Spec: Codable, Hashable, Sendable {
        var name: String?
        var description: String?
    }
    var id: String
    var file: String
    var enabled: Bool
    var spec: Spec?
    var error: String?
}

struct UiState: Codable, Sendable {
    var safeMode: Bool
    var items: [UiItem]
}

// MARK: - Projects

struct Project: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var description: String?
    var color: String?
    var updatedAt: String?
    var chatCount: Int?
    var taskCount: Int?
    var folder: String?
    var repos: [RepoLink]?
    var coordinatorChatId: String?
    var coordinatorWake: Bool?
}

struct ProjectDetail: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var description: String?
    var color: String?
    var updatedAt: String?
    var folder: String?
    var repos: [RepoLink]?
    var instructions: String
    var files: [String]
    var chats: [ChatSummary]
    var tasks: [SyphTask]
    var spend: ProjectSpend?
    var coordinatorWake: Bool?
}

struct ProjectSpend: Codable, Hashable, Sendable { var today: Double; var total: Double }

// MARK: - Tasks

struct SyphTask: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var prompt: String
    var schedule: String
    var projectId: String?
    var model: String?
    var enabled: Bool
    var lastRun: String?
    var lastStatus: String?
    var lastChatId: String?
    var nextRun: String?
    var scheduleText: String?
}

/// Editable copy of a task (a new one has no id yet).
struct TaskDraft: Hashable {
    var id: String?
    var name = ""
    var prompt = ""
    var schedule = "0 8 * * *"
    var projectId: String?
    var model: String?
    var enabled = true

    init() {}
    init(_ t: SyphTask) {
        id = t.id; name = t.name; prompt = t.prompt; schedule = t.schedule
        projectId = t.projectId; model = t.model; enabled = t.enabled
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["name": .string(name), "prompt": .string(prompt), "schedule": .string(schedule), "enabled": .bool(enabled)]
        if let id { o["id"] = .string(id) }
        if let projectId { o["projectId"] = .string(projectId) }
        if let model { o["model"] = .string(model) }
        return .object(o)
    }
}

// MARK: - Evolve

struct GateResult: Codable, Hashable, Sendable {
    var baseline: Double
    var candidate: Double
    var delta: Double
    var targetedBaseline: Double?
    var targetedCandidate: Double?
    var heldOutBaseline: Double?
    var heldOutCandidate: Double?
    var regressions: [String]
    var passed: Bool
    var notes: [String]
    var model: String?
}

struct Proposal: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var kind: String
    var title: String
    var reason: String
    var diff: String
    var source: String
    var gate: GateResult?
    var status: String
    var createdAt: String?
    var decidedAt: String?
}

struct Job: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var kind: String
    var title: String
    var status: String
    var log: [String]
    var startedAt: String
}

struct EvalCaseResult: Codable, Hashable, Sendable {
    var id: String
    var score: Double
    var heldOut: Bool?
}

struct EvalSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var model: String
    var startedAt: String
    var score: Double
    var heldOutScore: Double
    var cases: [EvalCaseResult]?
}

struct EvalCase: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var heldOut: Bool?
}

struct EvalsResponse: Codable, Sendable {
    var cases: [EvalCase]
    var history: [EvalSummary]
}

// MARK: - Models & profiles

struct ModelInfo: Codable, Identifiable, Hashable, Sendable {
    var ref: String
    var label: String
    var provider: String
    var contextWindow: Int?
    var tools: Bool?
    var id: String { ref }
}

struct Profile: Codable, Hashable, Sendable {
    var id: String
    var contextWindow: Int
    var nativeTools: Bool
    var strategy: String
    var fewShot: Int
    var temperature: Double?
    var escalateTo: String?
}

// MARK: - Config & state

struct ProviderConfig: Codable, Hashable, Sendable {
    var name: String
    var baseUrl: String
    var apiKeyEnv: String?
}

struct Defaults: Codable, Hashable, Sendable {
    var chatModel: String
    var taskModel: String
    var reflectorModel: String
    var judgeModel: String
    /// Model for frontend design work (the frontend-design skill).
    var frontendModel: String?
    /// auto, low, medium, high, xhigh or max.
    var effort: String?

    subscript(key: String) -> String {
        switch key {
        case "chatModel": return chatModel
        case "taskModel": return taskModel
        case "reflectorModel": return reflectorModel
        default: return judgeModel
        }
    }
    var json: JSONValue {
        var o: [String: JSONValue] = ["chatModel": .string(chatModel), "taskModel": .string(taskModel), "reflectorModel": .string(reflectorModel), "judgeModel": .string(judgeModel)]
        if let frontendModel { o["frontendModel"] = .string(frontendModel) }
        if let effort { o["effort"] = .string(effort) }
        return .object(o)
    }
}

struct Budgets: Codable, Hashable, Sendable {
    struct Daily: Codable, Hashable, Sendable { var chat: Double; var tasks: Double; var evolve: Double }
    var dailyUsd: Daily
}

struct Approval: Codable, Hashable, Sendable {
    struct Auto: Codable, Hashable, Sendable { var memory: Bool; var skill: Bool }
    var autoAccept: Auto
    var yolo: Bool?
    var yoloTasks: Bool?
}

struct EvolveConfig: Codable, Hashable, Sendable {
    var samplesPerCase: Int
    var maxAttempts: Int?
    var heldOutFraction: Double?
}

struct Config: Codable, Hashable, Sendable {
    var providers: [ProviderConfig]
    var defaults: Defaults
    var budgets: Budgets
    var approval: Approval
    var evolve: EvolveConfig
    var killSwitch: Bool
    var hasOpenRouterKey: Bool
    var hasMiniMaxKey: Bool?
    var hasGeminiKey: Bool?
}

struct Spend: Codable, Hashable, Sendable {
    var chat: Double
    var tasks: Double
    var evolve: Double
    var total: Double { chat + tasks + evolve }
}

struct NamedDescription: Codable, Hashable, Sendable { var name: String; var description: String }

struct ExtensionReport: Codable, Hashable, Sendable {
    var name: String
    var ok: Bool
    var error: String?
    var tools: [String]
}

struct MCPStatus: Codable, Hashable, Sendable {
    var name: String
    var tools: [String]
    var error: String?
}

struct AppState: Codable, Sendable {
    var config: Config
    var projects: [Project]
    var chats: [ChatSummary]
    var pendingProposals: Int
    var spend: Spend
    var strategies: [NamedDescription]
    var skills: [NamedDescription]
    var extensions: [ExtensionReport]
    var mcp: [MCPStatus]
    var homePath: String
    var workspacePath: String?
    var github: GithubState?
}

// MARK: - OpenRouter key

struct KeyCheck: Codable, Hashable, Sendable {
    var ok: Bool
    var rejected: Bool?
    var error: String?
    var label: String?
    var usage: Double?
    var limitRemaining: Double?
    var freeTier: Bool?
}

struct KeyStatus: Codable, Hashable, Sendable {
    var set: Bool
    var source: String?
    var masked: String?
    var check: KeyCheck?
}

// MARK: - Connectors

struct ConnectorField: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var label: String
    var secret: Bool?
    var required: Bool?
    var help: String?
    var placeholder: String?
    var set: Bool
    var value: String?
    var id: String { key }
}

struct ConnectorTool: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var description: String
    var permission: String
    var id: String { name }
}

struct Connector: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var description: String
    var icon: String?
    var auth: String
    var builtin: Bool
    var createdBy: String?
    var enabled: Bool
    var state: String
    var error: String?
    var account: String?
    var multiAccount: Bool?
    /// Every signed-in account, the default first (Google can have several).
    var accounts: [ConnectorAccount]?
    var fields: [ConnectorField]
    var tools: [ConnectorTool]
    var setup: String?
}

struct ConnectorAccount: Codable, Hashable, Sendable, Identifiable {
    var account: String
    var `default`: Bool
    var signedIn: Bool
    var id: String { account }
}

struct ExportResult: Codable, Sendable {
    var sft: String
    var sftCount: Int
    var dpoCount: Int
}

// MARK: - Live events

/// One event from a chat's run (`/api/chats/:id/stream`). Flat so every event type decodes.
struct AgentEvent: Codable, Sendable {
    var type: String
    var runId: String?
    var model: String?
    var strategy: String?
    var text: String?
    var id: String?
    var name: String?
    var args: JSONValue?
    var ok: Bool?
    var result: String?
    var ms: Double?
    var tool: String?
    var reason: String?
    var allow: Bool?
    var auto: Bool?
    var error: String?
    var reset: Bool?
    var content: String?
    var status: String?
    var message: JSONValue?
    /// `run_start`: when the run began, in ms since 1970.
    var at: Double?
    /// `files`: files the run created or changed so far.
    var files: [FileRef]?
    /// `plan`: the agent's checklist.
    var steps: [PlanStep]?
    /// `run_end`: the agent stopped to ask this.
    var question: UserQuestion?
    var stopReason: String?

    init(type: String) { self.type = type }
}

/// One event from the app-wide feed (`/api/events`).
struct ServerEvent: Codable, Sendable {
    var type: String
    var job: Job?
}

// MARK: - Skills

struct SkillInfo: Codable, Hashable, Sendable, Identifiable {
    struct Use: Codable, Hashable, Sendable { var uses: Int; var lastUsed: String? }
    struct Pending: Codable, Hashable, Sendable { var id: String; var title: String }
    var name: String
    var description: String
    var active: Bool
    var body: String
    var files: [String]?
    var usage: Use?
    var changedAt: String?
    var pending: [Pending]?
    var versions: Int?
    /// agent, reflector, user or default.
    var createdBy: String?
    var id: String { name }
}

struct SkillAudit: Codable, Hashable, Sendable {
    struct Dup: Codable, Hashable, Sendable { var skills: [String]; var similarity: Double }
    struct Unused: Codable, Hashable, Sendable { var name: String; var ageDays: Double }
    var duplicates: [Dup]
    var unused: [Unused]
    var inactive: [String]
    var empty: [String]
}

struct SkillsResponse: Codable, Sendable {
    var skills: [SkillInfo]
    var audit: SkillAudit?
}

// MARK: - Folders and the terminal (on the computer)

struct FolderLink: Codable, Hashable, Sendable, Identifiable {
    var path: String
    var name: String
    /// read or write.
    var access: String
    var linkedAt: String?
    /// chat, coordinator or project.
    var scope: String
    var exists: Bool
    var id: String { path }
}

struct TerminalEntry: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var chatId: String?
    var command: String
    var cwd: String
    var shell: String
    var background: Bool?
    /// running, done, failed, stopped or timeout.
    var status: String
    var exitCode: JSONValue?
    var startedAt: String
    var endedAt: String?
    var output: String
}

struct TerminalState: Codable, Sendable {
    var entries: [TerminalEntry]
    var session: Bool
    var mode: String
    var yolo: Bool
    var shell: String
}

// MARK: - Provider usage

struct UsageMeter: Codable, Hashable, Sendable {
    var label: String
    var used: Double
    var total: Double
    /// requests, usd or percent.
    var unit: String
    /// ms since 1970.
    var resetsAt: Double?

    var fraction: Double { total > 0 ? min(1, max(0, used / total)) : 0 }
    var left: String {
        switch unit {
        case "percent": return "\(Int(max(0, total - used).rounded()))% left"
        case "usd": return String(format: "$%.2f left of $%.2f", max(0, total - used), total)
        default: return "\(Int(max(0, total - used)).formatted()) of \(Int(total).formatted()) requests left"
        }
    }
}

struct ProviderUsage: Codable, Hashable, Sendable {
    var provider: String
    var meters: [UsageMeter]
    var checkedAt: Double?
    var error: String?

    /// The meter closest to running out.
    var tightest: UsageMeter? { meters.max { $0.fraction < $1.fraction } }
}

struct ChatHit: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var projectId: String?
    var updatedAt: String
    var snippet: String?
}
