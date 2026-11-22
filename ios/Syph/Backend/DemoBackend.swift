import Foundation

/// A self-contained Syph for trying the app without a computer. Data lives in memory and resets on launch.
/// Replies are simulated (streamed tokens, a tool call, an approval) so every screen can be exercised.
final class DemoBackend: SyphBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var cfg: Config
    private var projectList: [Project]
    private var projectInfo: [String: (instructions: String, files: [String])]
    private var chatList: [Chat]
    private var taskList: [SyphTask]
    private var proposalList: [Proposal]
    private var evalHistory: [EvalSummary]
    private var jobList: [Job] = []
    private var profiles: [String: Profile] = [:]
    private var connectorList: [Connector]
    private var key: KeyStatus
    private var spend = Spend(chat: 0.184, tasks: 0.042, evolve: 0.361)
    private var live: [String: LiveRun] = [:]
    private var feed: [UUID: AsyncStream<ServerEvent>.Continuation] = [:]
    private var repoList: [RepoStatus] = []
    private var demoFiles: [String: String] = [:]
    /// Which project or chat each demo repo is linked to.
    private var owners: [String: String] = [:]
    private var ui = UiState(safeMode: false, items: [
        UiItem(id: "connect-repo", file: "ui/connect-repo.json", enabled: true, spec: .init(name: "Connect repo", description: "A button next to the message box that clones one of your GitHub repos into the project.")),
        UiItem(id: "standup", file: "ui/standup.json", enabled: false, spec: .init(name: "Stand-up notes", description: "A sidebar page that drafts today's stand-up from yesterday's chats.")),
    ])
    private static let demoFolder = "C:\\Users\\you\\.syph\\projects\\p-research\\files"
    private var pendingApprovals: [String: CheckedContinuation<Bool, Never>] = [:]

    private final class LiveRun {
        var events: [AgentEvent] = []
        var watchers: [UUID: AsyncThrowingStream<AgentEvent, Error>.Continuation] = [:]
        var task: Task<Void, Never>?
        var waiting = false
    }

    init() {
        let now = Date()
        func ago(_ s: Double) -> String { iso(now.addingTimeInterval(-s)) }
        func ahead(_ s: Double) -> String { iso(now.addingTimeInterval(s)) }

        cfg = Config(
            providers: [
                ProviderConfig(name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY"),
                ProviderConfig(name: "ollama", baseUrl: "http://localhost:11434", apiKeyEnv: nil),
                ProviderConfig(name: "lmstudio", baseUrl: "http://localhost:1234/v1", apiKeyEnv: nil),
            ],
            defaults: Defaults(chatModel: "openrouter:deepseek/deepseek-chat-v3.1", taskModel: "openrouter:deepseek/deepseek-chat-v3.1", reflectorModel: "openrouter:deepseek/deepseek-r1", judgeModel: "openrouter:qwen/qwen3-235b-a22b"),
            budgets: Budgets(dailyUsd: .init(chat: 2, tasks: 1, evolve: 3)),
            approval: Approval(autoAccept: .init(memory: false, skill: false), yolo: false, yoloTasks: false),
            evolve: EvolveConfig(samplesPerCase: 1, maxAttempts: 3, heldOutFraction: 0.2),
            killSwitch: false,
            hasOpenRouterKey: true
        )
        key = KeyStatus(set: true, source: "settings", masked: "sk-or-v1-…7f3a", check: KeyCheck(ok: true, usage: 4.12, limitRemaining: 15.88))

        projectList = [
            Project(id: "p-research", name: "Research", description: "Papers, notes and weekly digests", color: "#8FA8FF", updatedAt: ago(3600 * 2), chatCount: 2, taskCount: 1, folder: Self.demoFolder),
            Project(id: "p-launch", name: "Launch plan", description: "Go-to-market for the spring release", color: "#F2B880", updatedAt: ago(3600 * 26), chatCount: 1, taskCount: 1),
            Project(id: "p-home", name: "Home lab", description: "Ollama box, backups and scripts", color: "#8FD4A8", updatedAt: ago(3600 * 72), chatCount: 0, taskCount: 0),
        ]
        projectInfo = [
            "p-research": ("Cite sources with links. Prefer primary papers over blog posts. Keep digests under 300 words.", ["notes/attention.md", "notes/rlhf-survey.md", "papers/2406.01234.pdf", "digest-template.md"]),
            "p-launch": ("Audience: indie developers. Tone: confident, plain English, no hype.", ["brief.md", "pricing.csv"]),
            "p-home": ("The server is an Ubuntu box at 192.168.1.20 running Ollama.", []),
        ]

        let t1 = Turn(id: "t1", role: .user, content: "Summarise the three notes in this project in a short digest.", createdAt: ago(7204.6))
        let t2 = Turn(id: "t2", role: .assistant, content: """
        Here's this week's digest:

        **1. Attention is still the bottleneck.** Long-context models trade memory for latency; sparse attention closes ~60% of the gap.

        **2. RLHF survey.** Preference data quality matters more than quantity — *2k clean pairs beat 20k noisy ones.*

        **3. Next steps**
        - Re-run the eval set on the 8B local model
        - Draft the reading list for Friday

        Want me to schedule this as a weekly task?
        """, runId: "r-demo-1", model: "openrouter:deepseek/deepseek-chat-v3.1", toolCalls: [
            ToolCallView(id: "c1", name: "list_files", args: ["path": "notes"], result: "attention.md\nrlhf-survey.md", ok: true, ms: 12),
            ToolCallView(id: "c2", name: "read_file", args: ["path": "notes/attention.md"], result: "# Attention\nSparse attention…", ok: true, ms: 9),
        ], rating: "up", files: [
            FileRef(path: Self.demoFolder + "\\reports\\weekly-digest.md", name: "weekly-digest.md", action: "created", size: 1840, rel: "reports/weekly-digest.md"),
        ], plan: [
            PlanStep(text: "List the notes in the project", status: "done"),
            PlanStep(text: "Read each note", status: "done"),
            PlanStep(text: "Write the digest", status: "done"),
        ], durationMs: 4600, createdAt: ago(7200))

        chatList = [
            Chat(id: "c-digest", title: "Weekly research digest", projectId: "p-research", model: cfg.defaults.chatModel, updatedAt: ago(7200), turns: [t1, t2]),
            Chat(id: "c-ollama", title: "Is my Ollama server up?", projectId: nil, model: "ollama:qwen3:8b", updatedAt: ago(3600 * 5), turns: [
                Turn(id: "o1", role: .user, content: "Write a script that checks if my Ollama server is up", createdAt: ago(3600 * 5)),
                Turn(id: "o2", role: .assistant, content: "Here's a tiny check you can run from anywhere:\n\n```bash\ncurl -sf http://192.168.1.20:11434/api/tags > /dev/null \\\n  && echo \"Ollama is up\" \\\n  || echo \"Ollama is down\"\n```\n\nIt exits non-zero when the server is down, so it works in cron too.", runId: "r-demo-2", model: "ollama:qwen3:8b", createdAt: ago(3600 * 5)),
            ]),
            Chat(id: "c-pricing", title: "Pricing page copy", projectId: "p-launch", model: cfg.defaults.chatModel, updatedAt: ago(3600 * 26), turns: [
                Turn(id: "x1", role: .user, content: "Three headline options for the pricing page.", createdAt: ago(3600 * 26)),
                Turn(id: "x2", role: .assistant, content: "1. **Pay for what you run.** Nothing else.\n2. **Local first. Cloud when you need it.**\n3. **One key. Every model.**", runId: "r-demo-3", model: cfg.defaults.chatModel, createdAt: ago(3600 * 26)),
            ]),
            Chat(id: "c-prompt", title: "Review the system prompt", projectId: nil, model: cfg.defaults.chatModel, updatedAt: ago(3600 * 50), turns: [
                Turn(id: "y1", role: .user, content: "Review your system prompt and suggest one improvement", createdAt: ago(3600 * 50)),
                Turn(id: "y2", role: .assistant, content: "One change: **lead with the answer.** The prompt asks for thoroughness but never says to put the conclusion first, so long answers bury it. I've proposed the edit in Evolve.", runId: "r-demo-4", model: cfg.defaults.chatModel, createdAt: ago(3600 * 50)),
            ]),
        ]

        taskList = [
            SyphTask(id: "task-digest", name: "Morning research digest", prompt: "Summarise anything new in notes/ in under 200 words.", schedule: "0 8 * * 1-5", projectId: "p-research", model: nil, enabled: true, lastRun: ago(3600 * 9), lastStatus: "ok", lastChatId: "c-digest", nextRun: ahead(3600 * 15)),
            SyphTask(id: "task-ollama", name: "Ollama health check", prompt: "Check the Ollama server responds and tell me if it doesn't.", schedule: "*/30 * * * *", projectId: nil, model: "ollama:qwen3:8b", enabled: true, lastRun: ago(600), lastStatus: "ok", nextRun: ahead(1200)),
            SyphTask(id: "task-launch", name: "Launch checklist", prompt: "Review brief.md and list what's still open.", schedule: "0 18 * * 0", projectId: "p-launch", model: nil, enabled: false, lastRun: ago(3600 * 24 * 6), lastStatus: "error", nextRun: nil),
        ]

        proposalList = [
            Proposal(id: "pr-lead", kind: "prompt", title: "prompts/system.md", reason: "Several failing cases buried the answer under context. Asking for the conclusion first fixed 4 of 5 in the shadow run.", diff: "@@ -3,6 +3,7 @@\n You are Syph, a careful assistant.\n-Be thorough and explain your reasoning.\n+Lead with the answer in one sentence, then explain.\n+Keep explanations proportional to the question.\n Use tools when they help; never guess file contents.", source: "reflector", gate: GateResult(baseline: 0.78, candidate: 0.84, delta: 0.06, targetedBaseline: 0.4, targetedCandidate: 0.8, heldOutBaseline: 0.75, heldOutCandidate: 0.77, regressions: [], passed: true, notes: ["Targeted cases 40% → 80%.", "Held-out held."], model: cfg.defaults.chatModel), status: "pending", createdAt: ago(3600 * 3)),
            Proposal(id: "pr-mem", kind: "memory", title: "memory/user.md", reason: "You asked for links in research answers three times this week.", diff: "@@ -1,2 +1,3 @@\n # About the user\n Prefers concise answers.\n+Wants sources linked inline in research answers.", source: "agent", gate: nil, status: "pending", createdAt: ago(3600 * 20)),
            Proposal(id: "pr-skill", kind: "skill", title: "skills/weekly-digest/SKILL.md", reason: "Turned the digest you liked into a reusable skill.", diff: "@@ -0,0 +1,6 @@\n+---\n+name: weekly-digest\n+description: Summarise a folder of notes into a short digest\n+---\n+1. List the notes changed this week.\n+2. One bold line per note, then next steps.", source: "agent", gate: GateResult(baseline: 0.81, candidate: 0.82, delta: 0.01, regressions: [], passed: true, notes: [], model: cfg.defaults.chatModel), status: "accepted", createdAt: ago(3600 * 80), decidedAt: ago(3600 * 79)),
            Proposal(id: "pr-prof", kind: "profile", title: "profiles/ollama__qwen3_8b.json", reason: "Raise few-shot examples from 2 to 3 for the local model.", diff: "@@ -4 +4 @@\n-  \"fewShot\": 2,\n+  \"fewShot\": 3,", source: "reflector", gate: GateResult(baseline: 0.62, candidate: 0.6, delta: -0.02, regressions: ["math-word"], passed: false, notes: ["math-word regressed."], model: "ollama:qwen3:8b"), status: "rejected", createdAt: ago(3600 * 120), decidedAt: ago(3600 * 119)),
        ]

        let scores = [0.66, 0.69, 0.68, 0.72, 0.74, 0.73, 0.77, 0.78, 0.81, 0.84]
        evalHistory = scores.enumerated().map { i, s in
            EvalSummary(id: "e\(i)", model: "openrouter:deepseek/deepseek-chat-v3.1", startedAt: ago(Double(scores.count - i) * 86400), score: s, heldOutScore: s - 0.03, cases: nil)
        }

        repoList = [
            RepoStatus(name: "syph-notes", url: "https://github.com/you/syph-notes", path: Self.demoFolder + "\\syph-notes", connectedAt: ago(86400), scope: "project", exists: true, branch: "main", dirty: 2, ahead: 1, behind: 0, upstream: "origin/main", active: true),
        ]
        owners = [Self.demoFolder + "\\syph-notes": "p-research"]
        connectorList = [
            Connector(id: "github", name: "GitHub", description: "List, clone, pull, commit and push your repositories, and open pull requests.", icon: "github", auth: "apiKey", builtin: true, createdBy: nil, enabled: true, state: "ready", error: nil, account: "you", fields: [
                ConnectorField(key: "token", label: "Personal access token", secret: true, required: true, help: "github.com/settings/tokens → Generate new token (classic) with repo and workflow scopes.", placeholder: "ghp_…", set: true, value: "ghp_…4kQ"),
            ], tools: [
                ConnectorTool(name: "github_repos", description: "List your repositories.", permission: "allow"),
                ConnectorTool(name: "github_pr_create", description: "Open a pull request.", permission: "allow"),
                ConnectorTool(name: "github_api", description: "Call any GitHub API. DELETE asks first.", permission: "allow"),
            ], setup: nil),
            Connector(id: "google", name: "Google Workspace", description: "Gmail, Drive, Docs, Sheets, Slides, Calendar, Contacts and Tasks.", icon: "google", auth: "oauth2", builtin: true, createdBy: nil, enabled: true, state: "ready", error: nil, account: "you@gmail.com", fields: [
                ConnectorField(key: "clientId", label: "Client ID", secret: false, required: true, help: "From Google Cloud → Credentials → Desktop app.", placeholder: "…apps.googleusercontent.com", set: true, value: "1234…usercontent.com"),
                ConnectorField(key: "clientSecret", label: "Client secret", secret: true, required: true, help: nil, placeholder: "GOCSPX-…", set: true, value: "GOCSPX-…9xQ"),
            ], tools: [
                ConnectorTool(name: "gmail_search", description: "Search mail.", permission: "allow"),
                ConnectorTool(name: "gmail_send", description: "Send an email.", permission: "ask"),
                ConnectorTool(name: "drive_search", description: "Find files in Drive.", permission: "allow"),
                ConnectorTool(name: "calendar_create_event", description: "Create a calendar event.", permission: "ask"),
                ConnectorTool(name: "google_api", description: "Call any Google API with the same sign-in.", permission: "ask"),
            ], setup: "1. Create a project at **console.cloud.google.com**.\n2. Turn on the Gmail, Drive and Calendar APIs.\n3. Create an OAuth client of type **Desktop app**.\n4. Paste the Client ID and secret here, then sign in."),
            Connector(id: "notion", name: "Notion", description: "Search and edit pages in your Notion workspace.", icon: nil, auth: "apiKey", builtin: false, createdBy: "agent", enabled: true, state: "needs_setup", error: nil, account: nil, fields: [
                ConnectorField(key: "token", label: "Integration token", secret: true, required: true, help: "notion.so/my-integrations → New integration.", placeholder: "secret_…", set: false, value: nil),
            ], tools: [], setup: nil),
        ]
    }

    private func sync<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    private func pause(_ ms: UInt64 = 220) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

    private func emit(_ type: String, job: Job? = nil) {
        let conts = sync { Array(feed.values) }
        var e = ServerEvent(type: type)
        e.job = job
        conts.forEach { $0.yield(e) }
    }

    // MARK: State

    func state() async throws -> AppState {
        await pause(150)
        return sync {
            let projects = projectList.map { p -> Project in
                var p = p
                p.chatCount = chatList.filter { $0.projectId == p.id }.count
                p.taskCount = taskList.filter { $0.projectId == p.id }.count
                return p
            }
            let chats = chatList.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }.map { c in
                ChatSummary(id: c.id, title: c.title, projectId: c.projectId, model: c.model, updatedAt: c.updatedAt, status: live[c.id].map { $0.waiting ? "waiting" : "running" })
            }
            return AppState(
                config: cfg, projects: projects, chats: chats,
                pendingProposals: proposalList.filter { $0.status == "pending" }.count,
                spend: spend,
                strategies: [
                    NamedDescription(name: "direct", description: "Answer in one pass."),
                    NamedDescription(name: "verify", description: "Draft, self-check, then revise."),
                    NamedDescription(name: "best_of_n", description: "Sample several answers and keep the best."),
                    NamedDescription(name: "cascade", description: "Escalate hard turns to a stronger model."),
                ],
                skills: [NamedDescription(name: "plan-and-verify", description: "Plan steps, then check each one."), NamedDescription(name: "summarise", description: "Summarise long text.")],
                extensions: [ExtensionReport(name: "word-count", ok: true, error: nil, tools: ["count_words"])],
                mcp: [MCPStatus(name: "files", tools: ["read", "write", "search"], error: nil)],
                homePath: "~/.syph (demo)"
            )
        }
    }

    func models() async throws -> [ModelInfo] {
        await pause(200)
        return [
            ModelInfo(ref: "openrouter:deepseek/deepseek-chat-v3.1", label: "DeepSeek Chat v3.1", provider: "openrouter", contextWindow: 128000, tools: true),
            ModelInfo(ref: "openrouter:deepseek/deepseek-r1", label: "DeepSeek R1", provider: "openrouter", contextWindow: 128000, tools: true),
            ModelInfo(ref: "openrouter:anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", provider: "openrouter", contextWindow: 200000, tools: true),
            ModelInfo(ref: "openrouter:qwen/qwen3-235b-a22b", label: "Qwen3 235B", provider: "openrouter", contextWindow: 128000, tools: true),
            ModelInfo(ref: "openrouter:google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1000000, tools: true),
            ModelInfo(ref: "ollama:qwen3:8b", label: "qwen3:8b", provider: "ollama", contextWindow: 32768, tools: false),
            ModelInfo(ref: "ollama:llama3.2:3b", label: "llama3.2:3b", provider: "ollama", contextWindow: 8192, tools: false),
            ModelInfo(ref: "lmstudio:mistral-small", label: "mistral-small", provider: "lmstudio", contextWindow: 32768, tools: true),
        ]
    }

    func updateSettings(_ patch: JSONValue) async throws {
        await pause(120)
        var approveAll = false
        sync {
            if let a = patch["approval"] {
                if case .bool(let v)? = a["yolo"] { cfg.approval.yolo = v; approveAll = v }
                if case .bool(let v)? = a["yoloTasks"] { cfg.approval.yoloTasks = v }
                if let auto = a["autoAccept"] {
                    if case .bool(let v)? = auto["memory"] { cfg.approval.autoAccept.memory = v }
                    if case .bool(let v)? = auto["skill"] { cfg.approval.autoAccept.skill = v }
                }
            }
            if case .bool(let v)? = patch["killSwitch"] { cfg.killSwitch = v }
            if let d = patch["defaults"] {
                for k in ["chatModel", "taskModel", "reflectorModel", "judgeModel"] {
                    guard let v = d[k]?.string else { continue }
                    switch k {
                    case "chatModel": cfg.defaults.chatModel = v
                    case "taskModel": cfg.defaults.taskModel = v
                    case "reflectorModel": cfg.defaults.reflectorModel = v
                    default: cfg.defaults.judgeModel = v
                    }
                }
            }
            if let b = patch["budgets"]?["dailyUsd"] {
                if case .number(let v)? = b["chat"] { cfg.budgets.dailyUsd.chat = v }
                if case .number(let v)? = b["tasks"] { cfg.budgets.dailyUsd.tasks = v }
                if case .number(let v)? = b["evolve"] { cfg.budgets.dailyUsd.evolve = v }
            }
            if case .number(let v)? = patch["evolve"]?["samplesPerCase"] { cfg.evolve.samplesPerCase = Int(v) }
            if case .array(let ps)? = patch["providers"] {
                for p in ps {
                    if let n = p["name"]?.string, let u = p["baseUrl"]?.string, let i = cfg.providers.firstIndex(where: { $0.name == n }) { cfg.providers[i].baseUrl = u }
                }
            }
        }
        if approveAll { approveAllPending() }
    }

    func profile(_ ref: String) async throws -> Profile {
        await pause(100)
        return sync {
            profiles[ref] ?? Profile(id: ref, contextWindow: ref.hasPrefix("ollama") ? 32768 : 128000, nativeTools: !ref.hasPrefix("ollama"), strategy: ref.hasPrefix("ollama") ? "verify" : "direct", fewShot: ref.hasPrefix("ollama") ? 2 : 0, temperature: nil, escalateTo: nil)
        }
    }
    func saveProfile(_ ref: String, _ profile: Profile) async throws { sync { profiles[ref] = profile } }

    // MARK: Key

    func keyStatus() async throws -> KeyStatus { sync { key } }
    func saveKey(_ raw: String) async throws -> KeyStatus {
        await pause(700)
        let k = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard k.hasPrefix("sk-or-") else { throw SyphError(message: "OpenRouter keys start with sk-or-. Copy it again from openrouter.ai/keys.") }
        return sync {
            key = KeyStatus(set: true, source: "settings", masked: k.count > 16 ? "\(k.prefix(9))…\(k.suffix(4))" : "••••", check: KeyCheck(ok: true, usage: 0, limitRemaining: 20))
            cfg.hasOpenRouterKey = true
            return key
        }
    }
    func checkKey() async throws -> KeyStatus { await pause(600); return sync { key } }
    func removeKey() async throws -> KeyStatus {
        sync {
            key = KeyStatus(set: false, source: nil, masked: nil, check: nil)
            cfg.hasOpenRouterKey = false
            return key
        }
    }

    // MARK: Projects

    func project(_ id: String) async throws -> ProjectDetail {
        await pause(150)
        return try sync {
            guard let p = projectList.first(where: { $0.id == id }) else { throw SyphError(message: "No such project") }
            let info = projectInfo[id] ?? ("", [])
            let chats = chatList.filter { $0.projectId == id }.map { ChatSummary(id: $0.id, title: $0.title, projectId: id, model: $0.model, updatedAt: $0.updatedAt) }
            return ProjectDetail(id: p.id, name: p.name, description: p.description, color: p.color, updatedAt: p.updatedAt, instructions: info.instructions, files: info.files, chats: chats, tasks: taskList.filter { $0.projectId == id })
        }
    }
    func createProject(name: String, description: String, instructions: String) async throws -> Project {
        let colors = ["#8FA8FF", "#F2B880", "#8FD4A8", "#E59BD0", "#9EDCE8", "#E8D17F"]
        return sync {
            let p = Project(id: "p-\(UUID().uuidString.prefix(6).lowercased())", name: name, description: description, color: colors[projectList.count % colors.count], updatedAt: iso(Date()))
            projectList.insert(p, at: 0)
            projectInfo[p.id] = (instructions, [])
            return p
        }
    }
    func updateProject(_ id: String, _ patch: JSONValue) async throws {
        await pause(200)
        sync {
            if let s = patch["instructions"]?.string { projectInfo[id] = (s, projectInfo[id]?.files ?? []) }
            if let i = projectList.firstIndex(where: { $0.id == id }) {
                if let n = patch["name"]?.string { projectList[i].name = n }
                if let d = patch["description"]?.string { projectList[i].description = d }
                projectList[i].updatedAt = iso(Date())
            }
        }
    }
    func deleteProject(_ id: String) async throws {
        sync {
            projectList.removeAll { $0.id == id }
            for i in chatList.indices where chatList[i].projectId == id { chatList[i].projectId = nil }
        }
    }

    // MARK: Chats

    func chat(_ id: String) async throws -> Chat {
        try sync {
            guard var c = chatList.first(where: { $0.id == id }) else { throw SyphError(message: "No such chat") }
            c.running = live[id] != nil
            return c
        }
    }
    func createChat(projectId: String?, model: String?) async throws -> Chat {
        sync {
            let c = Chat(id: "c-\(UUID().uuidString.prefix(8).lowercased())", title: "New chat", projectId: projectId, model: model, updatedAt: iso(Date()), turns: [])
            chatList.insert(c, at: 0)
            return c
        }
    }
    func patchChat(_ id: String, _ patch: JSONValue) async throws {
        sync {
            guard let i = chatList.firstIndex(where: { $0.id == id }) else { return }
            if let t = patch["title"]?.string { chatList[i].title = t }
            if let p = patch["projectId"] { chatList[i].projectId = p.string }
            if let m = patch["model"]?.string { chatList[i].model = m }
        }
    }
    func deleteChat(_ id: String) async throws {
        _ = try? await stopChat(id)
        sync { chatList.removeAll { $0.id == id } }
        emit("chats")
    }

    func sendMessage(_ chatId: String, text: String, model: String?) async throws {
        let run = LiveRun()
        try sync {
            guard let i = chatList.firstIndex(where: { $0.id == chatId }) else { throw SyphError(message: "No such chat") }
            guard live[chatId] == nil else { throw SyphError(message: "This chat is already working.") }
            chatList[i].turns.append(Turn(id: "u-\(UUID().uuidString.prefix(6))", role: .user, content: text, createdAt: iso(Date())))
            if chatList[i].title == "New chat" { chatList[i].title = Self.titleFrom(text) }
            if let model { chatList[i].model = model }
            chatList[i].updatedAt = iso(Date())
            live[chatId] = run
        }
        let usedModel = model ?? sync { cfg.defaults.chatModel }
        run.task = Task { [weak self] in await self?.simulate(chatId: chatId, text: text, model: usedModel, run: run) }
        emit("chats")
    }

    private static func titleFrom(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let first = t.split(separator: "\n").first.map(String.init) ?? t
        return first.count > 42 ? String(first.prefix(40)) + "…" : first
    }

    private func push(_ e: AgentEvent, _ run: LiveRun) {
        let ws = sync { () -> [AsyncThrowingStream<AgentEvent, Error>.Continuation] in
            run.events.append(e)
            return Array(run.watchers.values)
        }
        ws.forEach { $0.yield(e) }
    }

    private func simulate(chatId: String, text: String, model: String, run: LiveRun) async {
        let runId = "r-\(UUID().uuidString.prefix(8))"
        var start = AgentEvent(type: "run_start"); start.runId = runId; start.model = model; start.strategy = "direct"; start.at = Date().timeIntervalSince1970 * 1000
        push(start, run)
        await pause(500)

        let lower = text.lowercased()
        var calls: [ToolCallView] = []
        let wantsShell = lower.contains("script") || lower.contains("server") || lower.contains("check") || lower.contains("run ")
        let wantsFiles = lower.contains("file") || lower.contains("note") || lower.contains("summar") || lower.contains("project")
        let wantsTask = lower.contains("schedule") || lower.contains("every") || lower.contains("daily")

        let started = Date()
        var plan: [PlanStep] = []
        func setPlan(_ steps: [PlanStep]) {
            plan = steps
            var e = AgentEvent(type: "plan"); e.steps = steps
            push(e, run)
        }
        if wantsFiles {
            setPlan([PlanStep(text: "Look through the project files", status: "in_progress"), PlanStep(text: "Write the summary", status: "pending")])
            await pause(250)
            var c = AgentEvent(type: "tool_call"); c.id = "tc1"; c.name = "list_files"; c.args = ["path": "."]
            push(c, run); await pause(450)
            var r = AgentEvent(type: "tool_result"); r.id = "tc1"; r.name = "list_files"; r.ok = true; r.result = "notes/attention.md\nnotes/rlhf-survey.md\ndigest-template.md"; r.ms = 14
            push(r, run)
            calls.append(ToolCallView(id: "tc1", name: "list_files", args: ["path": "."], result: r.result, ok: true, ms: 14))
            await pause(300)
            setPlan([PlanStep(text: "Look through the project files", status: "done"), PlanStep(text: "Write the summary", status: "in_progress")])
        }

        if wantsShell || wantsTask {
            let tool = wantsTask ? "create_task" : "shell"
            let args: JSONValue = wantsTask ? ["name": "Daily summary", "schedule": "0 8 * * *", "prompt": .string(text)] : ["command": "curl -sf http://192.168.1.20:11434/api/tags"]
            var c = AgentEvent(type: "tool_call"); c.id = "tc2"; c.name = tool; c.args = args
            push(c, run)
            let yolo = sync { cfg.approval.yolo ?? false }
            var allowed = true
            if !yolo {
                let approvalId = "ap-\(UUID().uuidString.prefix(6))"
                var a = AgentEvent(type: "approval_request"); a.id = approvalId; a.tool = tool; a.args = args; a.reason = "\(tool) asks first"
                sync { run.waiting = true }
                push(a, run)
                emit("chats")
                allowed = await withCheckedContinuation { cont in sync { pendingApprovals[approvalId] = cont } }
                sync { run.waiting = false }
                var d = AgentEvent(type: "approval_done"); d.id = approvalId; d.allow = allowed
                push(d, run)
                emit("chats")
            }
            if Task.isCancelled { return finish(chatId: chatId, runId: runId, model: model, content: "", calls: calls, run: run, status: "stopped") }
            await pause(500)
            var r = AgentEvent(type: "tool_result"); r.id = "tc2"; r.name = tool; r.ok = allowed; r.ms = allowed ? 312 : 0
            r.result = allowed ? (wantsTask ? "Created task \"Daily summary\" (every day at 08:00)." : "{\"models\":[{\"name\":\"qwen3:8b\"}]}") : "Declined by the user."
            push(r, run)
            calls.append(ToolCallView(id: "tc2", name: tool, args: args, result: r.result, ok: allowed, ms: r.ms))
            if allowed && wantsTask {
                sync { taskList.insert(SyphTask(id: "task-\(UUID().uuidString.prefix(6))", name: "Daily summary", prompt: text, schedule: "0 8 * * *", projectId: nil, model: nil, enabled: true, lastRun: nil, lastStatus: "never", nextRun: iso(Date().addingTimeInterval(3600 * 12))), at: 0) }
                emit("task")
            }
            await pause(300)
        }

        let reply = Self.reply(for: text, tools: calls, yolo: sync { cfg.approval.yolo ?? false })
        var content = ""
        var i = reply.startIndex
        while i < reply.endIndex {
            if Task.isCancelled { break }
            let n = Int.random(in: 2...6)
            let j = reply.index(i, offsetBy: n, limitedBy: reply.endIndex) ?? reply.endIndex
            let piece = String(reply[i..<j])
            content += piece
            var t = AgentEvent(type: "token"); t.text = piece
            push(t, run)
            i = j
            await pause(UInt64.random(in: 18...42))
        }
        var files: [FileRef] = []
        if wantsFiles && !Task.isCancelled {
            files = [FileRef(path: Self.demoFolder + "\\reports\\summary.md", name: "summary.md", action: "created", size: Double(content.utf8.count), rel: "reports/summary.md")]
            sync { demoFiles[files[0].path] = content }
            var f = AgentEvent(type: "files"); f.files = files
            push(f, run)
            setPlan(plan.map { PlanStep(text: $0.text, status: "done") })
        }
        finish(chatId: chatId, runId: runId, model: model, content: content, calls: calls, run: run, status: Task.isCancelled ? "stopped" : "ok", plan: plan, files: files, started: started)
    }

    private func finish(chatId: String, runId: String, model: String, content: String, calls: [ToolCallView], run: LiveRun, status: String, plan: [PlanStep] = [], files: [FileRef] = [], started: Date? = nil) {
        var end = AgentEvent(type: "run_end"); end.runId = runId; end.content = content; end.status = status
        push(end, run)
        let ws = sync { () -> [AsyncThrowingStream<AgentEvent, Error>.Continuation] in
            if let i = chatList.firstIndex(where: { $0.id == chatId }) {
                chatList[i].turns.append(Turn(id: "a-\(UUID().uuidString.prefix(6))", role: .assistant, content: content.isEmpty ? "_Stopped._" : content, runId: runId, model: model, toolCalls: calls.isEmpty ? nil : calls, files: files.isEmpty ? nil : files, plan: plan.isEmpty ? nil : plan, durationMs: started.map { Date().timeIntervalSince($0) * 1000 }, createdAt: iso(Date())))
                chatList[i].updatedAt = iso(Date())
            }
            spend.chat += Double.random(in: 0.001...0.006)
            live[chatId] = nil
            return Array(run.watchers.values)
        }
        ws.forEach { $0.finish() }
        emit("chats")
    }

    private static func reply(for text: String, tools: [ToolCallView], yolo: Bool) -> String {
        let l = text.lowercased()
        if tools.contains(where: { $0.ok == false }) {
            return "No problem — I didn't run it. If you'd like, I can explain what the command would do first, or you can turn on **YOLO** in the chat box so ask-first tools run without asking."
        }
        if l.contains("schedule") || l.contains("daily") {
            return "Done. I created a task called **Daily summary** that runs every day at 08:00.\n\n- You'll find each run saved as a chat\n- Change the time or model any time in **Tasks**\n- Rate a run 👍 or 👎 and it can become an eval case"
        }
        if l.contains("script") || l.contains("server") || l.contains("ollama") {
            return "The server answered, so **Ollama is up** and serving `qwen3:8b`.\n\nHere's the check as a reusable script:\n\n```bash\n#!/usr/bin/env bash\nif curl -sf http://192.168.1.20:11434/api/tags > /dev/null; then\n  echo \"Ollama is up\"\nelse\n  echo \"Ollama is down\" >&2; exit 1\nfi\n```\n\nWant me to schedule it every 30 minutes?"
        }
        if l.contains("skill") {
            return "I drafted a skill called **weekly-digest** from what we did today:\n\n1. List the notes changed this week\n2. Write one bold line per note\n3. Finish with next steps\n\nIt's waiting for you in **Evolve** — accept it and I'll use it whenever you ask for a digest."
        }
        if l.contains("prompt") || l.contains("improve") {
            return "One improvement: **lead with the answer.** My system prompt asks for thoroughness but never says to put the conclusion first.\n\nI've proposed this edit in **Evolve**. It's been measured on the evals: `78% → 84%`, nothing regressed."
        }
        if !tools.isEmpty {
            return "I looked through the project files. Here's the short version:\n\n**Attention** — sparse attention closes most of the long-context gap.\n**RLHF survey** — clean preference pairs beat volume.\n\nNext step: re-run the evals on the local model. Want me to start that?"
        }
        return "Sure. Here's a clear, short answer to get started:\n\n- **What it is:** the key idea in one line\n- **Why it matters:** the practical upshot\n- **What to do next:** one concrete step\n\n_This is the demo Syph. Connect to Syph on your computer in Settings to use your real models, files and tools._"
    }

    func follow(_ chatId: String) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { cont in
            let id = UUID()
            let replay: [AgentEvent]? = sync {
                guard let run = live[chatId] else { return nil }
                run.watchers[id] = cont
                return run.events
            }
            guard let replay else {
                cont.yield(AgentEvent(type: "idle"))
                cont.finish()
                return
            }
            replay.forEach { cont.yield($0) }
            cont.onTermination = { [weak self] _ in self?.sync { self?.live[chatId]?.watchers[id] = nil } }
        }
    }

    func stopChat(_ id: String) async throws {
        let (task, waiting) = sync { (live[id]?.task, live[id].map { r in pendingApprovals.keys.filter { _ in r.waiting } } ?? []) }
        task?.cancel()
        for a in waiting { try? await resolveApproval(a, allow: false) }
    }

    func rate(chatId: String, turnId: String, rating: String?) async throws {
        sync {
            guard let i = chatList.firstIndex(where: { $0.id == chatId }), let j = chatList[i].turns.firstIndex(where: { $0.id == turnId }) else { return }
            chatList[i].turns[j].rating = rating
        }
    }

    func resolveApproval(_ id: String, allow: Bool) async throws {
        let cont = sync { pendingApprovals.removeValue(forKey: id) }
        cont?.resume(returning: allow)
    }

    private func approveAllPending() {
        let all = sync { () -> [CheckedContinuation<Bool, Never>] in
            let v = Array(pendingApprovals.values)
            pendingApprovals.removeAll()
            return v
        }
        all.forEach { $0.resume(returning: true) }
    }

    func turnIntoEval(runId: String, rating: String, expectation: String?) async throws { await pause(400) }

    // MARK: Tasks

    func tasks() async throws -> [SyphTask] {
        await pause(120)
        return sync { taskList.map { t in var t = t; t.scheduleText = Cron.describe(t.schedule); if !t.enabled { t.nextRun = nil }; return t } }
    }
    func saveTask(_ d: TaskDraft) async throws {
        sync {
            if let id = d.id, let i = taskList.firstIndex(where: { $0.id == id }) {
                taskList[i].name = d.name; taskList[i].prompt = d.prompt; taskList[i].schedule = d.schedule
                taskList[i].projectId = d.projectId; taskList[i].model = d.model; taskList[i].enabled = d.enabled
            } else {
                taskList.insert(SyphTask(id: "task-\(UUID().uuidString.prefix(6))", name: d.name, prompt: d.prompt, schedule: d.schedule, projectId: d.projectId, model: d.model, enabled: d.enabled, lastRun: nil, lastStatus: "never", nextRun: iso(Date().addingTimeInterval(3600 * 6))), at: 0)
            }
        }
        emit("task")
    }
    func patchTask(_ id: String, _ patch: JSONValue) async throws {
        sync {
            guard let i = taskList.firstIndex(where: { $0.id == id }) else { return }
            if case .bool(let v)? = patch["enabled"] {
                taskList[i].enabled = v
                taskList[i].nextRun = v ? iso(Date().addingTimeInterval(3600 * 3)) : nil
            }
        }
    }
    func deleteTask(_ id: String) async throws { sync { taskList.removeAll { $0.id == id } }; emit("task") }
    func runTask(_ id: String) async throws {
        sync { if let i = taskList.firstIndex(where: { $0.id == id }) { taskList[i].lastStatus = "running" } }
        emit("task")
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard let self else { return }
            self.sync {
                if let i = self.taskList.firstIndex(where: { $0.id == id }) {
                    self.taskList[i].lastStatus = "ok"
                    self.taskList[i].lastRun = iso(Date())
                    self.spend.tasks += 0.002
                }
            }
            self.emit("task")
        }
    }

    // MARK: Evolve

    func proposals() async throws -> [Proposal] { await pause(150); return sync { proposalList } }

    func decide(_ id: String, decision: String, model: String?) async throws {
        if decision == "gate" {
            let job = startJob(kind: "gate", title: "Measuring proposal")
            await runJob(job, steps: ["Applying in a shadow copy…", "Scoring 30 cases…", "Comparing with baseline…", "Held-out score holds."])
            sync {
                if let i = proposalList.firstIndex(where: { $0.id == id }) {
                    proposalList[i].gate = GateResult(baseline: 0.84, candidate: 0.86, delta: 0.02, regressions: [], passed: true, notes: ["Targeted cases improved."], model: model)
                }
            }
            emit("proposal")
            return
        }
        await pause(350)
        sync {
            guard let i = proposalList.firstIndex(where: { $0.id == id }) else { return }
            proposalList[i].status = decision == "accept" ? "accepted" : decision == "reject" ? "rejected" : "rolled_back"
            proposalList[i].decidedAt = iso(Date())
        }
        emit("proposal")
    }

    func evals() async throws -> EvalsResponse {
        await pause(150)
        let ids = ["fmt-json-keys", "tool-edit-file", "plan-steps", "math-word", "refuse-harm-safe", "fmt-three-bullets", "math-arith", "writing-email", "fmt-word-limit", "honesty-fake-paper", "memory-propose", "instr-lead-answer", "fmt-table", "code-regex", "honesty-unknown", "code-bug", "fmt-one-word", "reason-logic", "tool-write-file", "reason-trick", "brevity-simple", "explain-eli5", "skill-summarise", "code-fizzbuzz", "tool-list-then-read", "tool-no-guess", "tool-read-file", "instr-ambiguous", "math-percent", "tool-count-lines"]
        return sync { EvalsResponse(cases: ids.enumerated().map { EvalCase(id: $1, heldOut: $0 % 5 == 0) }, history: evalHistory) }
    }

    func runEvals(model: String?) async throws {
        let job = startJob(kind: "eval", title: "Running evals")
        Task { [weak self] in
            guard let self else { return }
            await self.runJob(job, steps: (1...6).map { "Case \($0 * 5)/30 scored" } + ["Done: score 85%."])
            self.sync {
                let last = self.evalHistory.last?.score ?? 0.8
                let s = min(0.97, last + Double.random(in: -0.01...0.03))
                self.evalHistory.append(EvalSummary(id: "e\(self.evalHistory.count)", model: model ?? self.cfg.defaults.chatModel, startedAt: iso(Date()), score: s, heldOutScore: s - 0.03))
                self.spend.evolve += 0.03
            }
            self.emit("proposal")
        }
    }

    func evolve(model: String?) async throws {
        let job = startJob(kind: "evolve", title: "Improving")
        Task { [weak self] in
            guard let self else { return }
            await self.runJob(job, steps: ["Scoring the current setup…", "3 cases failing: fmt-table, math-word, tool-no-guess", "Asking the reflector for changes…", "Gating 1 proposal in a shadow copy…", "1 proposal passed the gate."])
            self.sync {
                self.proposalList.insert(Proposal(id: "pr-\(UUID().uuidString.prefix(6))", kind: "skill", title: "skills/markdown-tables/SKILL.md", reason: "fmt-table failed twice: columns weren't aligned. A short skill fixes it.", diff: "@@ -0,0 +1,5 @@\n+---\n+name: markdown-tables\n+description: Write well-formed Markdown tables\n+---\n+Always include a header separator row.", source: "reflector", gate: GateResult(baseline: 0.84, candidate: 0.87, delta: 0.03, regressions: [], passed: true, notes: ["fmt-table 0% → 100%."], model: model), status: "pending", createdAt: iso(Date())), at: 0)
                self.spend.evolve += 0.08
            }
            self.emit("proposal")
        }
    }

    private func startJob(kind: String, title: String) -> String {
        let job = Job(id: "job-\(UUID().uuidString.prefix(6))", kind: kind, title: title, status: "running", log: [], startedAt: iso(Date()))
        sync { jobList.insert(job, at: 0) }
        emit("job", job: job)
        return job.id
    }

    private func runJob(_ id: String, steps: [String]) async {
        for s in steps {
            try? await Task.sleep(nanoseconds: 900_000_000)
            let j = sync { () -> Job? in
                guard let i = jobList.firstIndex(where: { $0.id == id }) else { return nil }
                jobList[i].log.append(s)
                return jobList[i]
            }
            if let j { emit("job", job: j) }
        }
        let j = sync { () -> Job? in
            guard let i = jobList.firstIndex(where: { $0.id == id }) else { return nil }
            jobList[i].status = "done"
            return jobList[i]
        }
        if let j { emit("job", job: j) }
    }

    func jobs() async throws -> [Job] { sync { jobList } }

    func exportData() async throws -> ExportResult {
        await pause(600)
        return ExportResult(sft: "~/.syph/exports/sft.jsonl", sftCount: 42, dpoCount: 9)
    }

    // MARK: Connectors

    func connectors() async throws -> [Connector] { await pause(150); return sync { connectorList } }
    func saveConnectorFields(_ id: String, values: [String: String]) async throws {
        await pause(300)
        sync {
            guard let i = connectorList.firstIndex(where: { $0.id == id }) else { return }
            for (k, v) in values where !v.isEmpty {
                if let f = connectorList[i].fields.firstIndex(where: { $0.key == k }) {
                    connectorList[i].fields[f].set = true
                    connectorList[i].fields[f].value = v.count > 8 ? "\(v.prefix(4))…\(v.suffix(3))" : "••••"
                }
            }
            if connectorList[i].fields.allSatisfy({ $0.set || !($0.required ?? false) }) {
                connectorList[i].state = connectorList[i].auth == "oauth2" ? "needs_signin" : "ready"
                if connectorList[i].auth == "apiKey" {
                    connectorList[i].tools = [ConnectorTool(name: "\(id)_search", description: "Search \(connectorList[i].name).", permission: "allow"), ConnectorTool(name: "\(id)_update", description: "Change a page.", permission: "ask")]
                }
            }
        }
        emit("connectors")
    }
    func setConnectorEnabled(_ id: String, enabled: Bool) async throws {
        sync { if let i = connectorList.firstIndex(where: { $0.id == id }) { connectorList[i].enabled = enabled } }
    }
    func signIn(_ id: String) async throws -> URL {
        throw SyphError(message: "Sign-in needs Syph on your computer. Connect to it in Settings → Connection.")
    }
    func disconnect(_ id: String) async throws {
        sync { if let i = connectorList.firstIndex(where: { $0.id == id }) { connectorList[i].state = "needs_signin"; connectorList[i].account = nil } }
    }
    func removeConnector(_ id: String) async throws {
        sync {
            guard let i = connectorList.firstIndex(where: { $0.id == id }) else { return }
            if connectorList[i].builtin {
                connectorList[i].state = "needs_setup"; connectorList[i].account = nil
                for f in connectorList[i].fields.indices { connectorList[i].fields[f].set = false; connectorList[i].fields[f].value = nil }
            } else {
                connectorList.remove(at: i)
            }
        }
        emit("connectors")
    }

    func events() -> AsyncStream<ServerEvent> {
        AsyncStream { cont in
            let id = UUID()
            sync { feed[id] = cont }
            cont.onTermination = { [weak self] _ in self?.sync { self?.feed[id] = nil } }
        }
    }

    // MARK: Files

    func chatFiles(_ chatId: String) async throws -> [FileRef] {
        await pause(120)
        return sync {
            var seen = Set<String>()
            return (chatList.first { $0.id == chatId }?.turns ?? []).reversed().flatMap { $0.files ?? [] }.filter { seen.insert($0.path).inserted }
        }
    }

    func download(_ path: String) async throws -> URL {
        await pause(300)
        let name = RemoteBackend.fileName(path)
        let text = sync { demoFiles[path] } ?? """
        # Weekly digest

        **Attention is still the bottleneck.** Sparse attention closes about 60% of the long-context gap.

        **RLHF survey.** 2k clean preference pairs beat 20k noisy ones.

        ## Next steps
        - Re-run the eval set on the 8B local model
        - Draft the reading list for Friday
        """
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: GitHub & repos

    func github() async throws -> GithubState { GithubState(connected: true, account: "you", state: "ready") }

    func githubRepos(query: String?) async throws -> [GithubRepo] {
        await pause(350)
        let all = [
            GithubRepo(full_name: "you/syph-notes", name: "syph-notes", owner: "you", private: true, description: "Research notes and digests", default_branch: "main", html_url: "https://github.com/you/syph-notes", pushed_at: iso(Date().addingTimeInterval(-3600 * 3))),
            GithubRepo(full_name: "you/launch-site", name: "launch-site", owner: "you", private: false, description: "Marketing site for the spring release", default_branch: "main", html_url: "https://github.com/you/launch-site", pushed_at: iso(Date().addingTimeInterval(-86400 * 2))),
            GithubRepo(full_name: "you/homelab-scripts", name: "homelab-scripts", owner: "you", private: true, description: "Backups, Ollama and cron scripts", default_branch: "main", html_url: "https://github.com/you/homelab-scripts", pushed_at: iso(Date().addingTimeInterval(-86400 * 9))),
        ]
        guard let q = query?.lowercased(), !q.isEmpty else { return all }
        return all.filter { $0.full_name.lowercased().contains(q) }
    }

    func repos(projectId: String?, chatId: String?) async throws -> [RepoStatus] {
        await pause(150)
        let pid = projectId ?? sync { chatList.first { $0.id == chatId }?.projectId }
        return sync { repoList.filter { r in r.scope == "project" ? (pid != nil && owners[r.path] == pid) : owners[r.path] == chatId } }
    }

    func linkRepo(_ repo: String, scope: String, projectId: String?, chatId: String?) async throws {
        await pause(1200)
        let name = String(repo.split(separator: "/").last ?? Substring(repo))
        let path = Self.demoFolder + "\\" + name
        sync {
            guard !repoList.contains(where: { $0.path == path }) else { return }
            for i in repoList.indices { repoList[i].active = false }
            repoList.append(RepoStatus(name: name, url: "https://github.com/" + repo, path: path, connectedAt: iso(Date()), scope: scope, exists: true, branch: "main", dirty: 0, ahead: 0, behind: 0, upstream: "origin/main", active: true))
            owners[path] = scope == "chat" ? chatId : projectId
        }
        emit("chats")
    }

    func unlinkRepo(_ path: String, projectId: String?, chatId: String?) async throws {
        sync { repoList.removeAll { $0.path == path } }
        emit("chats")
    }

    func pullRepo(_ path: String) async throws -> RepoActionResult {
        await pause(700)
        return sync {
            guard let i = repoList.firstIndex(where: { $0.path == path }) else { return RepoActionResult(ok: false) }
            repoList[i].behind = 0
            return RepoActionResult(ok: true, output: "Already up to date.", status: repoList[i])
        }
    }

    func pushRepo(_ path: String) async throws -> RepoActionResult {
        await pause(900)
        return sync {
            guard let i = repoList.firstIndex(where: { $0.path == path }) else { return RepoActionResult(ok: false) }
            let n = repoList[i].ahead ?? 0
            repoList[i].ahead = 0
            return RepoActionResult(ok: true, output: n > 0 ? "Pushed \(n) commit\(n == 1 ? "" : "s") to origin/main." : "Everything up-to-date", status: repoList[i])
        }
    }

    func setActiveRepo(chatId: String, path: String?) async throws {
        sync { for i in repoList.indices { repoList[i].active = repoList[i].path == path } }
    }

    // MARK: Interface

    func uiState() async throws -> UiState { await pause(120); return sync { ui } }
    func setUiEnabled(_ id: String, enabled: Bool) async throws -> UiState {
        sync { if let i = ui.items.firstIndex(where: { $0.id == id }) { ui.items[i].enabled = enabled }; return ui }
    }
    func setSafeMode(_ on: Bool) async throws -> UiState { sync { ui.safeMode = on; return ui } }
    func removeUi(_ id: String) async throws -> UiState { sync { ui.items.removeAll { $0.id == id }; return ui } }
}

func iso(_ d: Date) -> String { ISO8601DateFormatter.syph.string(from: d) }

extension ISO8601DateFormatter {
    static let syph: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
