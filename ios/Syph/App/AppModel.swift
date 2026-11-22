import SwiftUI
import Observation

enum Connection: Equatable {
    case none
    case demo
    case remote(URL)

    var label: String {
        switch self {
        case .none: return "Not connected"
        case .demo: return "Demo"
        case .remote(let u):
            if let name = UserDefaults.standard.string(forKey: "syph.computer.\(u.absoluteString)") { return name }
            return u.host().map { "\($0)\(u.port.map { ":\($0)" } ?? "")" } ?? u.absoluteString
        }
    }
}

/// Pages opened from the side menu, pushed over the chat.
enum Page: Hashable { case projects, tasks, evolve, connectors, settings }

/// Which chat the main screen shows. `.new` carries a fresh id so each new chat starts clean.
enum ChatRoute: Hashable {
    case chat(String)
    case new(projectId: String?, draft: String?, key: UUID)
}

enum ThemePreference: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var scheme: ColorScheme? { self == .dark ? .dark : self == .light ? .light : nil }
    var label: String { rawValue.capitalized }
}

/// App-wide store: which Syph we talk to, its state, the live change feed, and navigation.
@MainActor @Observable
final class AppModel {
    private(set) var connection: Connection = .none
    private(set) var backend: SyphBackend = DemoBackend()
    var state: AppState?
    var loadError: String?
    var jobs: [String: Job] = [:]
    /// Bumped when something changed on the server (tasks, proposals, connectors).
    var tick = 0

    // Navigation: one chat on screen, a side menu, and pages pushed from it.
    var current: ChatRoute = .new(projectId: nil, draft: nil, key: UUID())
    /// The chat the screen is showing once it exists (a new chat gets an id on its first message).
    var activeChatId: String?
    var path: [Page] = []
    var drawerOpen = false

    var theme: ThemePreference {
        didSet { UserDefaults.standard.set(theme.rawValue, forKey: "syph.theme") }
    }
    private var models: [ModelInfo]?
    private var feed: Task<Void, Never>?

    init() {
        theme = ThemePreference(rawValue: UserDefaults.standard.string(forKey: "syph.theme") ?? "") ?? .dark
        let d = UserDefaults.standard
        switch d.string(forKey: "syph.connection") {
        case "demo": connect(.demo)
        case "remote":
            if let s = d.string(forKey: "syph.server"), let u = URL(string: s) { connect(.remote(u)) }
        default: break
        }
        #if DEBUG
        let args = CommandLine.arguments
        func arg(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
        if let link = arg("-syphPair") { Task { try? await self.pair(link: link) } }
        if let s = arg("-syphServer"), let u = URL(string: s) { connect(.remote(u)) }
        // Screenshot helper: `-syphDemoTab evolve` (projects/tasks/settings/connectors/menu/chat:<id>) opens the demo there.
        if let v = arg("-syphDemoTab") {
            if connection == .none || arg("-syphServer") == nil { connect(.demo) }
            switch v {
            case "projects": open(.projects)
            case "tasks": open(.tasks)
            case "evolve": open(.evolve)
            case "settings": open(.settings)
            case "connectors": open(.connectors)
            case "menu": drawerOpen = true
            default: if v.hasPrefix("chat:") { openChat(String(v.dropFirst(5))) }
            }
        }
        #endif
    }

    var lastServer: String { UserDefaults.standard.string(forKey: "syph.server") ?? "http://127.0.0.1:7337" }

    func connect(_ c: Connection) {
        feed?.cancel()
        state = nil
        loadError = nil
        jobs = [:]
        models = nil
        path = []
        drawerOpen = false
        current = .new(projectId: nil, draft: nil, key: UUID())
        activeChatId = nil
        connection = c
        let d = UserDefaults.standard
        switch c {
        case .none:
            d.removeObject(forKey: "syph.connection")
            return
        case .demo:
            backend = DemoBackend()
            d.set("demo", forKey: "syph.connection")
        case .remote(let u):
            backend = RemoteBackend(base: u, token: Keychain.token(for: u))
            d.set("remote", forKey: "syph.connection")
            d.set(u.absoluteString, forKey: "syph.server")
        }
        Task { await refresh() }
        listen()
    }

    /// Pair with a computer from its QR link: `syph://pair?url=…&code=…&name=…`.
    func pair(link raw: String) async throws {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: text), comps.scheme == "syph", comps.host == "pair",
              let urlString = comps.queryItems?.first(where: { $0.name == "url" })?.value, let base = URL(string: urlString),
              let code = comps.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw SyphError(message: "That isn't a Syph pairing code. In Syph on your computer, open Settings → Phone and show the QR code.")
        }
        let token = try await RemoteBackend.pair(base: base, code: code, name: UIDevice.current.name)
        Keychain.setToken(token, for: base)
        if let name = comps.queryItems?.first(where: { $0.name == "name" })?.value {
            UserDefaults.standard.set(name, forKey: "syph.computer.\(base.absoluteString)")
        }
        Haptic.success()
        connect(.remote(base))
    }

    /// Checks a typed address answers like Syph before switching to it (works from the Simulator,
    /// where the phone is the computer). Pairing links are accepted here too.
    func connectManually(_ raw: String) async throws {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("syph://") { return try await pair(link: s) }
        if !s.contains("://") { s = "http://" + s }
        guard let u = URL(string: s), let host = u.host() else { throw SyphError(message: "That doesn't look like an address. Try 127.0.0.1:7337, or scan the QR code.") }
        let base = u.port == nil ? URL(string: "\(u.scheme ?? "http")://\(host):7337")! : URL(string: "\(u.scheme ?? "http")://\(host):\(u.port!)")!
        _ = try await RemoteBackend(base: base, token: Keychain.token(for: base)).state()
        connect(.remote(base))
    }

    /// Forget this computer's token, then go back to the welcome screen.
    func forgetConnection() {
        if case .remote(let u) = connection { Keychain.setToken(nil, for: u) }
        connect(.none)
    }

    func refresh() async {
        do {
            state = try await backend.state()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    func loadModels() async -> [ModelInfo] {
        if let models, !models.isEmpty { return models }
        let m = (try? await backend.models()) ?? []
        models = m
        return m
    }

    func resetModels() { models = nil }

    private func listen() {
        let b = backend
        feed = Task { [weak self] in
            while !Task.isCancelled {
                for await e in b.events() {
                    guard let self else { return }
                    self.handle(e)
                }
                // The feed dropped (server restarted, phone slept): try again shortly.
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await self?.refresh()
            }
        }
    }

    private func handle(_ e: ServerEvent) {
        switch e.type {
        case "job": if let j = e.job { jobs[j.id] = j }
        case "chats": Task { await refresh() }
        case "connectors": tick += 1
        case "task", "proposal":
            tick += 1
            Task { await refresh() }
        default: break
        }
    }

    // MARK: Helpers used across screens

    func project(_ id: String?) -> Project? { id.flatMap { id in state?.projects.first { $0.id == id } } }

    var yolo: Bool { state?.config.approval.yolo ?? false }

    func patchSettings(_ patch: JSONValue) async {
        do {
            try await backend.updateSettings(patch)
        } catch {
            loadError = error.localizedDescription
        }
        await refresh()
    }

    func openChat(_ id: String) {
        withAnimation(.smooth(duration: 0.35)) {
            if activeChatId != id { current = .chat(id); activeChatId = id }
            path = []
            drawerOpen = false
        }
    }

    func newChat(projectId: String? = nil, draft: String? = nil) {
        withAnimation(.smooth(duration: 0.35)) {
            current = .new(projectId: projectId, draft: draft, key: UUID())
            activeChatId = nil
            path = []
            drawerOpen = false
        }
    }

    func open(_ page: Page) {
        withAnimation(.smooth(duration: 0.35)) {
            path = [page]
            drawerOpen = false
        }
    }
}
