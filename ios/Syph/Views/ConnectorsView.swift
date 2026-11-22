import SwiftUI

struct ConnectorsView: View {
    @Environment(AppModel.self) private var app
    @State private var items: [Connector]?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Apps Syph can work in for you. Reading runs freely; sending, creating or changing things asks you first unless YOLO is on. Keys and sign-ins stay on your computer.")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                Button { app.newChat(draft: "Create a connector for ") } label: {
                    Label("Ask Syph to add one", systemImage: "plus.bubble.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                if let items {
                    ForEach(items) { c in ConnectorCard(c: c) { Task { await load() } } }
                    if items.count <= 1 {
                        Text("Need another app? Ask in chat, for example \"connect my Notion\" or \"add a connector for the Linear API\". Syph writes it, you approve it, then add the key here.")
                            .font(.footnote).foregroundStyle(Palette.muted).padding(.top, 6)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
            .animation(.smooth, value: items)
        }
        .background(Backdrop(tint: Palette.accent2))
        .navigationTitle("Connectors")
        .refreshable { await load() }
        .task(id: app.tick) { await load() }
    }

    private func load() async { if let c = try? await app.backend.connectors() { items = c } }
}

struct ConnectorCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    var c: Connector
    var reload: () -> Void
    @State private var open: Bool
    @State private var guide: Bool
    @State private var showTools = false
    @State private var values: [String: String] = [:]
    @State private var busy: String?
    @State private var error: String?
    @State private var waiting: URL?
    @State private var confirm = false

    init(c: Connector, reload: @escaping () -> Void) {
        self.c = c
        self.reload = reload
        _open = State(initialValue: c.state != "ready")
        _guide = State(initialValue: c.state == "needs_setup")
    }

    private static let stateLabel = ["ready": "Connected", "needs_setup": "Needs keys", "needs_signin": "Needs sign-in", "error": "Error"]
    private var stateColor: Color {
        guard c.enabled else { return Palette.faint }
        switch c.state {
        case "ready": return Palette.ok
        case "error": return Palette.err
        default: return Palette.warn
        }
    }
    private var dirty: Bool { values.values.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                icon
                Button {
                    Haptic.tap()
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(c.name).font(.headline).foregroundStyle(Palette.text)
                            Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Palette.faint).rotationEffect(.degrees(open ? 90 : 0))
                        }
                        HStack(spacing: 6) {
                            Tag(text: !c.enabled ? "Off" : c.state == "ready" && c.account != nil ? "Connected · \(c.account!)" : Self.stateLabel[c.state] ?? c.state, color: stateColor)
                            if !c.builtin { Text("made by \(c.createdBy == "agent" ? "Syph" : "you")").font(.caption).foregroundStyle(Palette.faint) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                Toggle("", isOn: Binding(get: { c.enabled }, set: { v in act("toggle") { try await app.backend.setConnectorEnabled(c.id, enabled: v) } }))
                    .labelsHidden().tint(Palette.ok)
            }
            Text(c.description).font(.subheadline).foregroundStyle(Palette.muted).padding(.top, 10)

            if open {
                VStack(alignment: .leading, spacing: 14) {
                    if let setup = c.setup {
                        DisclosureGroup(isExpanded: $guide) {
                            MarkdownView(text: setup, size: 14).padding(.top, 8)
                        } label: {
                            Text("How to set up \(c.name)").font(.footnote.weight(.semibold))
                        }
                        .tint(Palette.muted)
                    }
                    if !c.fields.isEmpty { fields }
                    if c.auth == "oauth2" { signin }
                    if let e = c.error { ErrorBanner(text: e) }
                    if let error { ErrorBanner(text: error) }
                    foot
                    if showTools { tools }
                }
                .padding(.top, 16)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(18)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Palette.stroke))
        .opacity(c.enabled ? 1 : 0.65)
        .onChange(of: c.state) { _, s in if s == "ready" { waiting = nil; guide = false } }
        .confirmationDialog(c.builtin ? "Clear its keys and sign-in?" : "Delete this connector, its code and its keys?", isPresented: $confirm, titleVisibility: .visible) {
            Button(c.builtin ? "Reset" : "Delete", role: .destructive) { act("remove") { try await app.backend.removeConnector(c.id) } }
        }
    }

    @ViewBuilder private var icon: some View {
        if c.icon == "google" {
            Text("G")
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(LinearGradient(colors: [Color(hex: "#4285F4"), Color(hex: "#EA4335"), Color(hex: "#FBBC05"), Color(hex: "#34A853")], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 44, height: 44)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else if c.icon == "github" {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: 44, height: 44)
                .background(Color(hex: "#24292F"), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.stroke))
        } else {
            IconTile(system: "puzzlepiece.extension.fill", color: Palette.accent2, size: 44)
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(c.fields) { f in
                VStack(alignment: .leading, spacing: 6) {
                    Text(f.label + ((f.required ?? false) ? "" : " (optional)")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted)
                    Group {
                        let binding = Binding(get: { values[f.key] ?? "" }, set: { values[f.key] = $0 })
                        let ph = f.set ? "\(f.value ?? "") (saved)" : (f.placeholder ?? "")
                        if f.secret ?? false { SecureField(ph, text: binding) } else { TextField(ph, text: binding) }
                    }
                    .font(.footnote.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    if let h = f.help { Text(h).font(.caption).foregroundStyle(Palette.faint) }
                }
            }
            HStack {
                Spacer()
                Button(busy == "save" ? "Saving…" : "Save") {
                    act("save") {
                        try await app.backend.saveConnectorFields(c.id, values: values)
                        values = [:]
                    }
                }
                .buttonStyle(.tonalCompact)
                .disabled(!dirty || busy != nil)
            }
        }
    }

    @ViewBuilder private var signin: some View {
        if c.state == "ready" || c.state == "error" {
            HStack(spacing: 8) {
                Text("Signed in\(c.account.map { " as \($0)" } ?? "").").font(.footnote).foregroundStyle(Palette.muted)
                Spacer()
                Button { signIn() } label: { Label("Again", systemImage: "arrow.clockwise") }.buttonStyle(.tonalCompact)
                Button { act("disconnect") { try await app.backend.disconnect(c.id) } } label: { Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right") }.buttonStyle(.tonalCompact)
            }
            .disabled(busy != nil)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Button { signIn() } label: {
                    Label("Sign in with \(c.icon == "google" ? "Google" : c.name)", systemImage: "person.badge.key.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primaryCompact)
                .disabled(c.state == "needs_setup" || busy != nil)
                if c.state == "needs_setup" { Text("Save the client ID and secret first.").font(.caption).foregroundStyle(Palette.faint) }
                if let waiting {
                    HStack(spacing: 4) {
                        Text("Finish signing in in Safari. Nothing opened?").font(.caption).foregroundStyle(Palette.muted)
                        Button("Open it") { openURL(waiting) }.font(.caption.weight(.semibold))
                    }
                }
            }
        }
    }

    private var foot: some View {
        HStack {
            if !c.tools.isEmpty {
                Button { withAnimation(.snappy) { showTools.toggle() } } label: {
                    Label("\(c.tools.count) tools for the agent", systemImage: showTools ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold))
                }
                .foregroundStyle(Palette.muted)
            } else {
                Text(c.state == "ready" ? "No tools loaded." : "Tools appear once it's connected.").font(.footnote).foregroundStyle(Palette.faint)
            }
            Spacer()
            Button { confirm = true } label: { Label(c.builtin ? "Reset" : "Remove", systemImage: "trash") }.buttonStyle(.destructiveCompact)
        }
    }

    private var tools: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(c.tools) { t in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(t.name).font(.footnote.monospaced().weight(.semibold))
                        Spacer()
                        Tag(text: t.permission == "ask" ? "asks first" : t.permission == "deny" ? "blocked" : "runs freely", color: t.permission == "ask" ? Palette.warn : t.permission == "deny" ? Palette.err : Palette.ok)
                    }
                    Text(t.description.components(separatedBy: ". ").first ?? t.description).font(.caption).foregroundStyle(Palette.muted)
                }
            }
        }
        .padding(14)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func signIn() {
        act("signin") {
            let url = try await app.backend.signIn(c.id)
            waiting = url
            openURL(url)
        }
    }

    private func act(_ name: String, _ fn: @escaping () async throws -> Void) {
        busy = name
        error = nil
        Task {
            do {
                try await fn()
                Haptic.success()
                reload()
            } catch {
                self.error = error.localizedDescription
                Haptic.warning()
            }
            busy = nil
        }
    }
}
