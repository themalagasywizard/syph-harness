import SwiftUI

/// The slide-out menu: new chat, the sections (Projects, Tasks, Evolve, Connectors), recent chats, settings.
struct SideMenu: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var confirmDelete: ChatSummary?
    @State private var hits: [ChatHit] = []

    private var chats: [ChatSummary] {
        let all = (app.state?.chats ?? []).filter { $0.role != "thread" }
        return query.isEmpty ? all : all.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Search
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted)
                TextField("Search chats", text: $query).submitLabel(.search)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Palette.surface2, in: Capsule())
            .padding(.horizontal, 16)
            .padding(.top, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if query.isEmpty {
                        item("square.and.pencil", "New chat") { app.newChat() }
                            .padding(.bottom, 6)
                        item("square.stack.3d.up", "Projects", badge: app.state?.projects.count, quiet: true) { app.open(.projects) }
                        if app.capabilities.computer {
                            item("clock.arrow.2.circlepath", "Tasks") { app.open(.tasks) }
                            item("sparkles", "Evolve", badge: app.state?.pendingProposals) { app.open(.evolve) }
                            item("wand.and.stars", "Skills") { app.open(.skills) }
                            item("puzzlepiece.extension", "Connectors") { app.open(.connectors) }
                        } else if app.isStandalone {
                            standaloneCard.padding(.top, 8)
                        }

                        Text("Recent").sectionLabel().padding(.horizontal, 14).padding(.top, 22).padding(.bottom, 6)
                    }
                    if chats.isEmpty {
                        Text(query.isEmpty ? "No chats yet." : "No matches.").font(.subheadline).foregroundStyle(Palette.faint).padding(14)
                    }
                    ForEach(chats) { c in chatRow(c) }
                    if !query.isEmpty && !hits.isEmpty {
                        Text("In messages").sectionLabel().padding(.horizontal, 14).padding(.top, 16).padding(.bottom, 4)
                        ForEach(hits.filter { h in !chats.contains { $0.id == h.id } }) { h in
                            Button { Haptic.tap(); app.openChat(h.id) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(h.title).font(.body).foregroundStyle(Palette.text).lineLimit(1)
                                    if let sn = h.snippet { Text(sn).font(.caption).foregroundStyle(Palette.muted).lineLimit(2) }
                                }
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.top, 14)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.immediately)
            .task(id: query) {
                // Search inside messages too (on the computer), after a short pause in typing.
                guard query.count >= 2 else { hits = []; return }
                try? await Task.sleep(nanoseconds: 300_000_000)
                if !Task.isCancelled { hits = (try? await app.backend.searchChats(query)) ?? [] }
            }

            Divider().overlay(Palette.stroke)
            Button { app.open(.settings) } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Palette.accentGradient).opacity(0.25)
                        SyphMark(size: 18, color: Palette.text)
                    }
                    .frame(width: 38, height: 38)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Settings").font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                        HStack(spacing: 5) {
                            StatusDot(status: app.loadError == nil ? "ok" : "error")
                            Text(app.connection == .demo ? "Demo" : app.isStandalone ? "On this iPhone" : app.connection.label).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                    Spacer()
                    Image(systemName: "gearshape").foregroundStyle(Palette.muted)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.bg)
        .confirmationDialog("Delete \"\(confirmDelete?.title ?? "")\"?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete chat", role: .destructive) {
                guard let c = confirmDelete else { return }
                Task {
                    try? await app.backend.deleteChat(c.id)
                    if app.activeChatId == c.id { app.newChat() }
                    await app.refresh()
                }
            }
        }
    }

    /// Standalone: what works here, and the way back to the computer.
    private var standaloneCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                LivingMark(size: 22, mode: app.syncing ? .loading : .idle, birth: false, glow: false)
                Text("On this iPhone").font(.subheadline.weight(.semibold))
            }
            Text(app.pairedServer == nil
                 ? "Chats run on the phone with your own key. Pair with Syph on a computer for projects, tasks, files and the terminal."
                 : "Chats run on the phone and sync to your computer when it's back. Tasks, Evolve, connectors and the terminal wait for it.")
                .font(.caption).foregroundStyle(Palette.muted)
            if app.pairedServer != nil {
                Button { Task { await app.reconnectNow() } } label: { Label(app.syncing ? "Connecting…" : "Reconnect", systemImage: "arrow.triangle.2.circlepath") }
                    .font(.caption.weight(.semibold)).disabled(app.syncing)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 8)
    }

    private func item(_ icon: String, _ title: String, badge: Int? = nil, quiet: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            Haptic.tap()
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.body.weight(.medium)).frame(width: 24).foregroundStyle(Palette.text)
                Text(title).font(.body.weight(.medium)).foregroundStyle(Palette.text)
                Spacer()
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(quiet ? Palette.muted : Palette.bg)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(quiet ? AnyShapeStyle(Palette.surface3) : AnyShapeStyle(Palette.accent), in: Capsule())
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
    }

    private func chatRow(_ c: ChatSummary) -> some View {
        let active = app.activeChatId == c.id
        let color = app.project(c.projectId).map { Color(hex: $0.color ?? "#888") }
        return Button {
            Haptic.tap()
            app.openChat(c.id)
        } label: {
            HStack(spacing: 10) {
                if let color { Circle().fill(color).frame(width: 7, height: 7) }
                Text(c.title).font(.body).foregroundStyle(Palette.text).lineLimit(1)
                Spacer(minLength: 4)
                if c.id.hasPrefix("phone-") {
                    Image(systemName: "iphone").font(.caption2).foregroundStyle(Palette.faint).accessibilityLabel("Made on this phone, not synced yet")
                }
                if c.role == "coordinator" { Image(systemName: "arrow.triangle.branch").font(.caption2).foregroundStyle(Palette.faint) }
                if c.status != nil { StatusDot(status: c.status == "waiting" ? "waiting" : "running", pulse: true) }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(active ? Palette.surface2 : .clear, in: Capsule())
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .contextMenu {
            Button(role: .destructive) { confirmDelete = c } label: { Label("Delete chat", systemImage: "trash") }
        }
    }
}
