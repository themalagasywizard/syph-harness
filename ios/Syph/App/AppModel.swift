import SwiftUI
import Observation

enum Connection: Equatable {
    case none
    case demo
    case remote(URL)
    /// Syph on this phone alone: chats run against the model provider directly and sync to the computer later.
    case standalone

    var label: String {
        switch self {
        case .none: return "Not connected"
        case .demo: return "Demo"
        case .standalone: return "This iPhone"
        case .remote(let u):
            if let name = UserDefaults.standard.string(forKey: "syph.computer.\(u.absoluteString)") { return name }
            return u.host().map { "\($0)\(u.port.map { ":\($0)" } ?? "")" } ?? u.absoluteString
        }
    }
}

/// Pages opened from the side menu, pushed over the chat.
enum Page: Hashable {
    case projects, tasks, evolve, connectors, settings, skills
    /// A project's settings: instructions, files, repos and tasks (behind the coordinator's Settings button).
    case project(String)
}

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
    /// The first load after launch has finished (the launch screen waits for it).
    var booted = false
    /// A short note about syncing between the phone and the computer, shown as a banner.
    var syncNote: String?
    var syncing = false
    /// Bumped when a thread list may have changed (threads, chats).
    var threadsTick = 0
    private var probe: Task<Void, Never>?
    private var uploading = false

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
        case "standalone": connect(.standalone)
        case "remote":
            if let s = d.string(forKey: "syph.server"), let u = URL(string: s) { connect(.remote(u)) }
        default: booted = true
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
            case "skills": open(.skills)
            case "standalone": connect(.standalone)
            case "menu": drawerOpen = true
            default: if v.hasPrefix("chat:") { openChat(String(v.dropFirst(5))) }
            }
        }
        #endif
    }

    var capabilities: BackendCapabilities { backend.capabilities }
    var isStandalone: Bool { connection == .standalone }
    /// The computer this phone is paired with, if any (kept while working on the phone alone).
    var pairedServer: URL? {
        guard let s = UserDefaults.standard.string(forKey: "syph.server"), let u = URL(string: s), Keychain.token(for: u) != nil || u.host() == "127.0.0.1" || u.host() == "localhost" else { return nil }
        return u
    }

    var lastServer: String { UserDefaults.standard.string(forKey: "syph.server") ?? "http://127.0.0.1:7337" }

    func connect(_ c: Connection) {
        feed?.cancel()
        probe?.cancel()
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
            booted = true
            return
        case .standalone:
            backend = LocalBackend()
            d.set("standalone", forKey: "syph.connection")
            watchForComputer()
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
            let s = try await backend.state()
            state = s
            loadError = nil
            if case .remote = connection {
                Mirror.save(state: s)
                if !LocalBackend.pendingChats().isEmpty { await syncPhoneChats() }
            }
        } catch {
            loadError = error.localizedDescription
            // The computer is out of reach on launch: carry on on the phone if it has been used before.
            if case .remote = connection, state == nil, !booted, Mirror.state() != nil || PhoneKeys.any {
                booted = true
                connect(.standalone)
                syncNote = "Your computer isn't reachable, so Syph is working on this phone. Chats sync when it's back."
                return
            }
        }
        booted = true
    }

    // MARK: Standalone and sync

    /// Work on the phone alone, keeping the pairing so chats sync when the computer is back.
    func goStandalone() {
        connect(.standalone)
        syncNote = pairedServer == nil ? nil : "Working on this phone. Chats sync to your computer when it's back."
    }

    /// While on the phone alone, check now and then whether the paired computer is back.
    private func watchForComputer() {
        probe?.cancel()
        guard let u = pairedServer else { return }
        probe = Task { [weak self] in
            var wait: UInt64 = 8
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
                wait = min(wait * 2, 60)
                guard let self, !Task.isCancelled else { return }
                if (try? await RemoteBackend(base: u, token: Keychain.token(for: u)).state()) != nil {
                    await self.reconnect(u)
                    return
                }
            }
        }
    }

    /// Try the paired computer now (the "Reconnect" button).
    func reconnectNow() async {
        guard let u = pairedServer else { return }
        syncing = true
        defer { syncing = false }
        do {
            _ = try await RemoteBackend(base: u, token: Keychain.token(for: u)).state()
            await reconnect(u)
        } catch {
            syncNote = "Still can't reach your computer. Check it's on the same Wi-Fi with Syph open."
        }
    }

    private func reconnect(_ u: URL) async {
        // Don't pull the rug from under a reply that's still streaming on the phone.
        if let id = activeChatId, state?.chats.first(where: { $0.id == id })?.status == "running" {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
        let open = activeChatId
        connect(.remote(u))
        let map = await syncPhoneChats()
        if let open, let mapped = map[open] ?? (open.hasPrefix("phone-") ? nil : open) { openChat(mapped) }
    }

    /// Send the chats made on this phone to the computer, then drop them here. Returns phone id → computer id.
    @discardableResult
    func syncPhoneChats() async -> [String: String] {
        guard case .remote = connection, !uploading else { return [:] }
        let pending = LocalBackend.pendingChats()
        guard !pending.isEmpty else { return [:] }
        uploading = true
        syncing = true
        defer { uploading = false; syncing = false }
        var map: [String: String] = [:]
        for c in pending {
            if let id = try? await backend.importChat(phoneId: c.id, title: c.title, projectId: c.projectId, model: c.model, turns: c.turns) {
                map[c.id] = id
            }
        }
        LocalBackend.removeSynced(Set(map.keys))
        if !map.isEmpty {
            syncNote = "Synced \(map.count) chat\(map.count == 1 ? "" : "s") from this phone to your computer."
            Haptic.success()
            if let s = try? await backend.state() { state = s; Mirror.save(state: s) }
        }
        if map.count < pending.count { syncNote = "Some phone chats didn't sync yet. Syph will try again." }
        return map
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
        case "chats", "threads":
            threadsTick += 1
            Task { await refresh() }
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

    /// Opening a project goes straight to its coordinator chat, as on the desktop. Without one
    /// (an older server, or a project only read from the computer's mirror) it opens the project page.
    func openProject(_ id: String) {
        if let c = project(id)?.coordinatorChatId { openChat(c); return }
        Task {
            if let t = try? await backend.projectThreads(id) { openChat(t.coordinatorId) }
            else { open(.project(id)) }
        }
    }

    func open(_ page: Page) {
        withAnimation(.smooth(duration: 0.35)) {
            path = [page]
            drawerOpen = false
        }
    }
}
