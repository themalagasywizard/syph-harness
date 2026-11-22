import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var profileRef: String?
    @State private var profile: Profile?
    @State private var exported: String?
    @State private var exporting = false
    @State private var confirmDisconnect = false

    var body: some View {
        @Bindable var app = app
        ScrollView {
            if let s = app.state {
                let cfg = s.config
                VStack(alignment: .leading, spacing: 26) {
                    ConnectionCard(confirmDisconnect: $confirmDisconnect)

                    RowGroup(title: "Model providers") {
                        NavigationLink { OpenRouterKeyView() } label: {
                            SettingRow(title: "OpenRouter", subtitle: "Hundreds of hosted models through one key.", icon: "cloud.fill") {
                                Tag(text: cfg.hasOpenRouterKey ? "Key set" : "No key", color: cfg.hasOpenRouterKey ? Palette.ok : Palette.warn)
                                chevron
                            }
                        }
                        ProviderRow(name: "ollama", title: "Ollama", subtitle: "Local models on your computer or network.", icon: "cpu", providers: cfg.providers)
                        ProviderRow(name: "lmstudio", title: "OpenAI-compatible", subtitle: "LM Studio, llama.cpp, vLLM or any /v1 endpoint.", icon: "server.rack", providers: cfg.providers)
                    }

                    RowGroup(title: "Default models") {
                        ForEach([("chatModel", "Chat", "New chats start with this model."), ("taskModel", "Tasks", "Scheduled tasks use this unless they pick one."), ("reflectorModel", "Reflector", "Proposes improvements. Use your strongest model."), ("judgeModel", "Judge", "Scores eval answers. Ideally a different family.")], id: \.0) { k, label, hint in
                            SettingRow(title: label, subtitle: hint) {
                                ModelField(title: label, value: cfg.defaults[k]) { m in
                                    var d = cfg.defaults.json
                                    if case .object(var o) = d { o[k] = .string(m); d = .object(o) }
                                    Task { await app.patchSettings(["defaults": d]) }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        RowGroup(title: "Model profile") {
                            SettingRow(title: "Model") {
                                ModelField(value: profileRef) { profileRef = $0 }
                            }
                            if let profile { profileRows(profile, strategies: s.strategies) }
                        }
                        Text("How Syph runs a model. The improvement loop may propose changes to these too.").font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 6)
                    }

                    RowGroup(title: "Connectors") {
                        NavigationLink { ConnectorsView() } label: {
                            SettingRow(title: "GitHub, Google Workspace and other apps", subtitle: s.github.map { $0.connected ? "GitHub connected\($0.account.map { " as \($0)" } ?? "")." : "GitHub isn't connected yet." } ?? "Sign in to Google, add API keys, remove connectors.", icon: "puzzlepiece.extension.fill", iconColor: Palette.accent2) { chevron }
                        }
                    }

                    RowGroup(title: "Interface") {
                        NavigationLink { InterfaceSettingsView() } label: {
                            SettingRow(title: "Changes Syph made", subtitle: "Buttons and pages Syph added to the desktop app. Turn them off, remove them, or use safe mode.", icon: "rectangle.3.group.fill", iconColor: Palette.accent) { chevron }
                        }
                    }

                    RowGroup(title: "Tool approvals") {
                        toggleRow("YOLO mode", "Run shell commands and other ask-first tools without asking. Also lets any tool waiting for you run.", icon: "bolt.fill", color: Palette.warn, on: cfg.approval.yolo ?? false) { v in ["approval": ["yolo": .bool(v)]] }
                        toggleRow("YOLO for scheduled Tasks", "Tasks run with nobody watching, so they decline ask-first tools unless this is on.", icon: "clock.badge.exclamationmark.fill", color: Palette.warn, on: cfg.approval.yoloTasks ?? false) { v in ["approval": ["yoloTasks": .bool(v)]] }
                    }

                    RowGroup(title: "Self-improvement") {
                        toggleRow("Auto-accept memory", "Only when evals improve and nothing regresses.", on: cfg.approval.autoAccept.memory) { v in ["approval": ["autoAccept": ["memory": .bool(v), "skill": .bool(cfg.approval.autoAccept.skill)]]] }
                        toggleRow("Auto-accept skills", "Prompts, profiles and code always wait for you.", on: cfg.approval.autoAccept.skill) { v in ["approval": ["autoAccept": ["memory": .bool(cfg.approval.autoAccept.memory), "skill": .bool(v)]]] }
                        SettingRow(title: "Samples per eval case", subtitle: "More samples smooth out randomness but cost more.") {
                            Stepper("\(cfg.evolve.samplesPerCase)", value: Binding(get: { cfg.evolve.samplesPerCase }, set: { v in
                                Task { await app.patchSettings(["evolve": ["samplesPerCase": .number(Double(v)), "maxAttempts": .number(Double(cfg.evolve.maxAttempts ?? 3)), "heldOutFraction": .number(cfg.evolve.heldOutFraction ?? 0.2)]]) }
                            }), in: 1...5).fixedSize().monospacedDigit()
                        }
                        toggleRow("Kill switch", "Pause all Tasks and the improvement loop. Chat keeps working.", icon: "power", color: Palette.err, on: cfg.killSwitch) { v in ["killSwitch": .bool(v)] }
                    }

                    RowGroup(title: "Daily budgets") {
                        ForEach(["chat", "tasks", "evolve"], id: \.self) { k in
                            let spent = k == "chat" ? s.spend.chat : k == "tasks" ? s.spend.tasks : s.spend.evolve
                            let limit = k == "chat" ? cfg.budgets.dailyUsd.chat : k == "tasks" ? cfg.budgets.dailyUsd.tasks : cfg.budgets.dailyUsd.evolve
                            BudgetRow(name: k.capitalized, spent: spent, limit: limit) { v in
                                var d: [String: JSONValue] = ["chat": .number(cfg.budgets.dailyUsd.chat), "tasks": .number(cfg.budgets.dailyUsd.tasks), "evolve": .number(cfg.budgets.dailyUsd.evolve)]
                                d[k] = .number(v)
                                Task { await app.patchSettings(["budgets": ["dailyUsd": .object(d)]]) }
                            }
                        }
                    }

                    RowGroup(title: "Extensions and MCP") {
                        if s.extensions.isEmpty && s.mcp.isEmpty {
                            Text("No extensions yet. Syph can write them as proposals; MCP servers go in config.json under mcpServers.").font(.footnote).foregroundStyle(Palette.muted).padding(16)
                        }
                        ForEach(s.extensions, id: \.name) { x in
                            SettingRow(title: x.name, subtitle: x.ok ? "Tools: \(x.tools.isEmpty ? "none" : x.tools.joined(separator: ", "))" : x.error, icon: "puzzlepiece.fill", iconColor: Palette.muted) {
                                Tag(text: x.ok ? "Loaded" : "Off", color: x.ok ? Palette.ok : Palette.err)
                            }
                        }
                        ForEach(s.mcp, id: \.name) { m in
                            SettingRow(title: "MCP · \(m.name)", subtitle: m.error ?? "\(m.tools.count) tools", icon: "server.rack", iconColor: Palette.muted) {
                                Tag(text: m.error == nil ? "Connected" : "Error", color: m.error == nil ? Palette.ok : Palette.err)
                            }
                        }
                    }

                    RowGroup(title: "Skills") {
                        ForEach(s.skills, id: \.name) { sk in
                            SettingRow(title: sk.name, subtitle: sk.description, icon: "wand.and.stars", iconColor: Palette.accent) { EmptyView() }
                        }
                    }

                    RowGroup(title: "Data and appearance") {
                        SettingRow(title: "Export training data", subtitle: exported ?? "SFT and DPO datasets as JSONL, for fine-tuning a local model.", icon: "square.and.arrow.down.fill", iconColor: Palette.ok) {
                            Button {
                                exporting = true
                                Task {
                                    if let r = try? await app.backend.exportData() {
                                        exported = "\(r.sftCount) SFT and \(r.dpoCount) DPO examples written next to \(r.sft)"
                                        Haptic.success()
                                    }
                                    exporting = false
                                }
                            } label: { if exporting { ProgressView() } else { Text("Export") } }
                            .buttonStyle(.tonalCompact)
                        }
                        SettingRow(title: "Appearance", icon: "circle.lefthalf.filled", iconColor: Palette.muted) {
                            Picker("Appearance", selection: $app.theme) {
                                ForEach(ThemePreference.allCases) { Text($0.label).tag($0) }
                            }
                            .pickerStyle(.menu)
                        }
                    }

                    Text("Syph stores everything in \(s.homePath) on your computer.")
                        .font(.footnote).foregroundStyle(Palette.faint).frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
            } else {
                ProgressView().padding(.top, 100).frame(maxWidth: .infinity)
            }
        }
        .background(Backdrop())
        .navigationTitle("Settings")
        .refreshable { await app.refresh() }
        .task(id: profileRef) {
            if profileRef == nil { profileRef = app.state?.config.defaults.chatModel }
            if let r = profileRef { profile = try? await app.backend.profile(r) }
        }
        .confirmationDialog("Disconnect from \(app.connection.label)?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { app.forgetConnection() }
        } message: { Text("Nothing is deleted. To connect again, scan a new QR code.") }
    }

    private var chevron: some View { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Palette.faint) }

    private func toggleRow(_ title: String, _ sub: String, icon: String? = nil, color: Color = Palette.accent, on: Bool, patch: @escaping (Bool) -> JSONValue) -> some View {
        SettingRow(title: title, subtitle: sub, icon: icon, iconColor: color) {
            Toggle("", isOn: Binding(get: { on }, set: { v in
                Haptic.tap()
                Task { await app.patchSettings(patch(v)) }
            }))
            .labelsHidden()
            .tint(Palette.ok)
        }
    }

    @ViewBuilder private func profileRows(_ p: Profile, strategies: [NamedDescription]) -> some View {
        SettingRow(title: "Strategy", subtitle: strategies.first { $0.name == p.strategy }?.description) {
            Picker("Strategy", selection: Binding(get: { p.strategy }, set: { v in save { $0.strategy = v } })) {
                ForEach(strategies, id: \.name) { Text($0.name).tag($0.name) }
            }
            .pickerStyle(.menu)
        }
        if p.strategy == "cascade" {
            SettingRow(title: "Escalate to", subtitle: "Used when a check of this model's answer fails.") {
                ModelField(value: p.escalateTo) { m in save { $0.escalateTo = m } }
            }
        }
        SettingRow(title: "Few-shot examples", subtitle: "Good past answers shown for similar requests.") {
            Stepper("\(p.fewShot)", value: Binding(get: { p.fewShot }, set: { v in save { $0.fewShot = v } }), in: 0...5).fixedSize().monospacedDigit()
        }
        SettingRow(title: "Context window", subtitle: "Tokens. Older turns are summarised past 60%.") {
            Menu {
                ForEach([4096, 8192, 16384, 32768, 65536, 128000, 200000, 1000000], id: \.self) { n in
                    Button(n.formatted()) { save { $0.contextWindow = n } }
                }
            } label: {
                Text(p.contextWindow.formatted()).font(.subheadline.weight(.medium).monospacedDigit()).foregroundStyle(Palette.muted)
            }
        }
        SettingRow(title: "Native tool calling", subtitle: "Off for local models without tools; Syph uses a text protocol instead.") {
            Toggle("", isOn: Binding(get: { p.nativeTools }, set: { v in save { $0.nativeTools = v } })).labelsHidden().tint(Palette.ok)
        }
    }

    private func save(_ change: (inout Profile) -> Void) {
        guard var p = profile, let ref = profileRef else { return }
        change(&p)
        profile = p
        Haptic.tap()
        Task { try? await app.backend.saveProfile(ref, p) }
    }
}

struct ConnectionCard: View {
    @Environment(AppModel.self) private var app
    @Binding var confirmDisconnect: Bool
    @State private var showConnect = false

    var body: some View {
        let demo = app.connection == .demo
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(Palette.accentGradient).opacity(0.25)
                    Image(systemName: demo ? "play.circle.fill" : "desktopcomputer").font(.title3.weight(.semibold)).foregroundStyle(Palette.accent)
                }
                .frame(width: 52, height: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(demo ? "Demo mode" : "Connected to \(app.connection.label)").font(.headline)
                    HStack(spacing: 6) {
                        StatusDot(status: app.loadError == nil ? "ok" : "error", pulse: app.loadError == nil)
                        Text(demo ? "Sample data, nothing leaves your phone" : "Paired by QR code").font(.subheadline).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                }
                Spacer()
            }
            HStack(spacing: 10) {
                Button { showConnect = true } label: { Label(demo ? "Scan QR code" : "Pair again", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity) }.buttonStyle(.primaryCompact)
                Button { confirmDisconnect = true } label: { Text("Disconnect").frame(maxWidth: .infinity) }.buttonStyle(.tonalCompact)
            }
        }
        .padding(18)
        .glass(radius: 26)
        .fullScreenCover(isPresented: $showConnect) { PairSheet() }
    }
}

struct ProviderRow: View {
    @Environment(AppModel.self) private var app
    var name: String
    var title: String
    var subtitle: String
    var icon: String
    var providers: [ProviderConfig]
    @State private var url = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingRow(title: title, subtitle: subtitle, icon: icon, iconColor: Palette.ok) { EmptyView() }
            HStack {
                Text("Base URL").font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted)
                TextField("http://localhost", text: $url)
                    .font(.footnote.monospaced())
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(save)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .padding(.leading, 48)
        }
        .onAppear { url = providers.first { $0.name == name }?.baseUrl ?? "" }
        .onChange(of: focused) { _, f in if !f { save() } }
    }

    private func save() {
        guard url != providers.first(where: { $0.name == name })?.baseUrl else { return }
        let list: [JSONValue] = providers.map { p in
            ["name": .string(p.name), "baseUrl": .string(p.name == name ? url : p.baseUrl), "apiKeyEnv": .str(p.apiKeyEnv)]
        }
        Task {
            await app.patchSettings(["providers": .array(list)])
            app.resetModels()
        }
    }
}

struct BudgetRow: View {
    var name: String
    var spent: Double
    var limit: Double
    var set: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(name).font(.body.weight(.medium))
                Spacer()
                Text("\(Fmt.usd(spent, digits: 3)) of").font(.subheadline).foregroundStyle(Palette.muted).monospacedDigit()
                Menu {
                    ForEach([0.5, 1, 2, 3, 5, 10, 20, 50], id: \.self) { v in Button(Fmt.usd(v)) { set(v) } }
                } label: {
                    Text(Fmt.usd(limit)).font(.subheadline.weight(.semibold)).monospacedDigit()
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Palette.surface3, in: Capsule())
                }
            }
            ProgressView(value: min(1, limit > 0 ? spent / limit : 0)).tint(spent >= limit ? Palette.err : Palette.accent)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// Add, check, replace or remove the OpenRouter key. The server only ever returns a masked form.
struct OpenRouterKeyView: View {
    @Environment(AppModel.self) private var app
    @State private var status: KeyStatus?
    @State private var editing = false
    @State private var value = ""
    @State private var busy: String?
    @State private var error: String?
    @State private var confirmRemove = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 14) {
                    IconTile(system: "cloud.fill", size: 56)
                    VStack(alignment: .leading) {
                        Text("OpenRouter").font(.title2.bold())
                        Text("Used for DeepSeek by default.").font(.subheadline).foregroundStyle(Palette.muted)
                    }
                }
                if let status {
                    if status.set && !editing {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("API key").sectionLabel()
                            Text(status.masked ?? "••••").font(.title3.monospaced().weight(.semibold))
                            Text(status.source == "environment" ? "From the .env next to Syph or the environment" : "Saved in Settings").font(.footnote).foregroundStyle(Palette.muted)
                            if let c = status.check { CheckLine(check: c) }
                            HStack(spacing: 8) {
                                Button { run("check") { try await app.backend.checkKey() } } label: {
                                    Label("Check", systemImage: "arrow.clockwise").symbolEffect(.rotate, isActive: busy == "check")
                                }.buttonStyle(.tonalCompact)
                                Button("Replace") { editing = true }.buttonStyle(.tonalCompact)
                                if status.source == "settings" {
                                    Button { confirmRemove = true } label: { Label("Remove", systemImage: "trash") }.buttonStyle(.destructiveCompact)
                                }
                            }
                            .disabled(busy != nil)
                        }
                        .card()
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("API key").sectionLabel()
                            SecureField("sk-or-v1-…", text: $value)
                                .font(.body.monospaced())
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(14)
                                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            HStack {
                                if status.set { Button("Cancel") { editing = false; value = ""; error = nil }.buttonStyle(.tonalCompact) }
                                Spacer()
                                Button {
                                    run("save") { try await app.backend.saveKey(value) }
                                } label: { Text(busy == "save" ? "Checking…" : "Save key") }
                                .buttonStyle(.primaryCompact)
                                .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty || busy != nil)
                            }
                            Text("Get one at openrouter.ai/keys. Syph checks it with OpenRouter, then saves it to the .env in your Syph data folder on your computer, where its own file tools can't read it.")
                                .font(.footnote).foregroundStyle(Palette.muted)
                            Link("Open openrouter.ai/keys", destination: URL(string: "https://openrouter.ai/keys")!).font(.footnote.weight(.semibold))
                        }
                        .card()
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
                if let error { ErrorBanner(text: error) }
            }
            .padding(20)
        }
        .background(Backdrop())
        .navigationTitle("OpenRouter")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let s = try? await app.backend.keyStatus() { status = s; editing = !s.set }
        }
        .confirmationDialog("Remove the OpenRouter key?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove key", role: .destructive) { run("remove") { try await app.backend.removeKey() } }
        }
    }

    private func run(_ kind: String, _ fn: @escaping () async throws -> KeyStatus) {
        busy = kind
        error = nil
        Task {
            do {
                let s = try await fn()
                withAnimation { status = s }
                if kind != "check" {
                    value = ""
                    editing = !s.set
                    app.resetModels()
                    await app.refresh()
                }
                Haptic.success()
            } catch {
                self.error = error.localizedDescription
                Haptic.warning()
            }
            busy = nil
        }
    }
}

struct CheckLine: View {
    var check: KeyCheck
    var body: some View {
        if !check.ok {
            Label(check.error ?? "Check failed", systemImage: "xmark.octagon.fill").font(.footnote).foregroundStyle(Palette.err)
        } else {
            let parts = ["Key works"] + [check.usage.map { "\(Fmt.usd($0)) used" }, check.limitRemaining.map { "\(Fmt.usd($0)) left" }, check.freeTier == true ? "free tier" : nil].compactMap { $0 }
            Label(parts.joined(separator: " · "), systemImage: "checkmark.circle.fill").font(.footnote.weight(.medium)).foregroundStyle(Palette.ok)
        }
    }
}

/// The interface changes Syph made on the desktop: a switch and Remove for each, plus safe mode.
struct InterfaceSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var ui: UiState?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Ask Syph in chat to add a button or page, and it shows up here once you approve it. These changes are drawn in the desktop app.")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                if let error { ErrorBanner(text: error) }
                if let ui {
                    RowGroup(footer: "Safe mode hides every change Syph made, without deleting them.") {
                        SettingRow(title: "Safe mode", icon: "shield.lefthalf.filled", iconColor: Palette.warn) {
                            Toggle("", isOn: Binding(get: { ui.safeMode }, set: { v in update { try await app.backend.setSafeMode(v) } })).labelsHidden()
                        }
                    }
                    if ui.items.isEmpty {
                        EmptyState(icon: "rectangle.3.group", title: "No changes yet", message: "Try asking Syph: \"add a button to connect my GitHub repos\".").card()
                    } else {
                        RowGroup(title: "Changes") {
                            ForEach(ui.items) { item in
                                SettingRow(title: item.spec?.name ?? item.id, subtitle: item.error ?? item.spec?.description, icon: item.error == nil ? "rectangle.badge.plus" : "exclamationmark.triangle.fill", iconColor: item.error == nil ? Palette.accent : Palette.err) {
                                    Toggle("", isOn: Binding(get: { item.enabled }, set: { v in update { try await app.backend.setUiEnabled(item.id, enabled: v) } }))
                                        .labelsHidden()
                                        .disabled(item.error != nil)
                                }
                                .contextMenu {
                                    Button(role: .destructive) { update { try await app.backend.removeUi(item.id) } } label: { Label("Remove", systemImage: "trash") }
                                }
                            }
                        }
                        Text("Touch and hold a change to remove it.").font(.footnote).foregroundStyle(Palette.faint).padding(.horizontal, 6)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
        .background(Backdrop())
        .navigationTitle("Interface")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do { ui = try await app.backend.uiState(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func update(_ work: @escaping () async throws -> UiState) {
        Haptic.tap()
        Task {
            do { let u = try await work(); withAnimation(.smooth) { ui = u } }
            catch { self.error = error.localizedDescription }
        }
    }
}
