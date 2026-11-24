import SwiftUI

/// How a thread's state reads: a coloured dot and a short label.
struct ThreadStateBadge: View {
    var state: String
    private var info: (String, Color) {
        switch state {
        case "queued": return ("Queued", Palette.faint)
        case "working": return ("Working", Palette.accent)
        case "blocked": return ("Needs you", Palette.warn)
        case "review_ready": return ("Ready for review", Palette.ok)
        case "failed": return ("Failed", Palette.err)
        case "stopped": return ("Stopped", Palette.faint)
        default: return ("Done", Palette.ok)
        }
    }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(info.1).frame(width: 7, height: 7)
            Text(info.0).font(.caption.weight(.medium)).foregroundStyle(state == "blocked" ? Palette.warn : Palette.muted)
        }
        .fixedSize()
    }
}

/// The card a coordinator chat shows when one of its threads ends or needs you. Tap to open the thread.
struct ThreadUpdateCard: View {
    @Environment(AppModel.self) private var app
    var update: ThreadUpdate
    var body: some View {
        Button { Haptic.tap(); app.openChat(update.threadId) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.triangle.branch").font(.footnote).foregroundStyle(Palette.muted)
                    Text(update.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                    Spacer(minLength: 6)
                    ThreadStateBadge(state: update.state)
                }
                Text(update.summary).font(.subheadline).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
                if let n = update.needs, n != update.summary {
                    Text(n).font(.footnote).foregroundStyle(Palette.warn).multilineTextAlignment(.leading)
                }
                HStack(spacing: 12) {
                    if let f = update.filesChanged, f > 0 { Label("\(f) file\(f == 1 ? "" : "s")", systemImage: "doc") }
                    Spacer(minLength: 0)
                    Text("Open thread").fontWeight(.semibold).foregroundStyle(Palette.accent)
                }
                .font(.caption).foregroundStyle(Palette.faint)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.stroke))
        }
        .buttonStyle(.pressable)
    }
}

/// A project's threads beside its coordinator chat (the desktop's thread rail), as a sheet:
/// open one, stop it, mark it resolved, or delete it. Project settings are one tap away.
struct ThreadsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var vm: ChatViewModel
    @State private var showResolved = false
    @State private var confirmDelete: ThreadSummary?
    @State private var error: String?

    private var all: [ThreadSummary] { vm.threads?.threads ?? [] }
    private var shown: [ThreadSummary] { all.filter { showResolved ? $0.resolved == true : $0.resolved != true } }

    var body: some View {
        NavigationStack {
            List {
                if let t = vm.threads {
                    Section {
                        Button { Haptic.tap(); dismiss(); app.openChat(t.coordinatorId) } label: {
                            HStack(spacing: 12) {
                                LivingMark(size: 30, mode: t.coordinatorStatus == "running" ? .loading : .idle, birth: false, glow: false)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Coordinator").font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                                    Text("Plans the work and starts a thread for each piece.").font(.caption).foregroundStyle(Palette.muted)
                                }
                                Spacer()
                                if vm.chatId == t.coordinatorId { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
                            }
                        }
                        .listRowBackground(Palette.surface)
                    }
                }
                Section {
                    if shown.isEmpty {
                        Text(showResolved ? "No resolved threads." : "Ask the coordinator for some work and it starts a thread for it.")
                            .font(.footnote).foregroundStyle(Palette.muted).listRowBackground(Color.clear)
                    }
                    ForEach(shown) { th in
                        Button { Haptic.tap(); dismiss(); app.openChat(th.id) } label: { row(th) }
                            .listRowBackground(vm.chatId == th.id ? Palette.surface3 : Palette.surface)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { confirmDelete = th } label: { Label("Delete", systemImage: "trash") }
                                Button { act { try await app.backend.resolveThread(th.id, resolved: th.resolved != true) } } label: {
                                    Label(th.resolved == true ? "Reopen" : "Resolve", systemImage: th.resolved == true ? "arrow.uturn.left" : "checkmark")
                                }
                                .tint(Palette.ok)
                            }
                            .contextMenu {
                                if th.status == "running" || th.threadState == "working" {
                                    Button { act { try await app.backend.stopThread(th.id) } } label: { Label("Stop", systemImage: "stop.circle") }
                                }
                                Button { act { try await app.backend.resolveThread(th.id, resolved: th.resolved != true) } } label: {
                                    Label(th.resolved == true ? "Reopen" : "Mark resolved", systemImage: "checkmark.circle")
                                }
                                Button(role: .destructive) { confirmDelete = th } label: { Label("Delete thread", systemImage: "trash") }
                            }
                    }
                } header: {
                    Picker("Show", selection: $showResolved) {
                        Text("Active").tag(false)
                        Text("Resolved (\(all.filter { $0.resolved == true }.count))").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .textCase(nil)
                    .padding(.bottom, 6)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(Palette.err).listRowBackground(Color.clear) }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle(vm.project?.name ?? "Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let pid = vm.projectId ?? vm.chat?.projectId, app.capabilities.projects {
                        Button { dismiss(); app.open(.project(pid)) } label: { Label("Project settings", systemImage: "gearshape") }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .refreshable { await vm.loadThreads() }
            .confirmationDialog("Delete \"\(confirmDelete?.title ?? "")\"?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
                Button("Delete thread", role: .destructive) {
                    guard let th = confirmDelete else { return }
                    act {
                        try await app.backend.deleteThread(th.id)
                        if app.activeChatId == th.id, let c = vm.threads?.coordinatorId { app.openChat(c) }
                    }
                }
            } message: { Text("Its chat is removed. Work it already did stays where it is.") }
        }
        .task { await vm.loadThreads() }
    }

    private func row(_ th: ThreadSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(th.title).font(.body.weight(.medium)).foregroundStyle(Palette.text).lineLimit(2)
                if let s = th.summary, !s.isEmpty { Text(s).font(.footnote).foregroundStyle(Palette.muted).lineLimit(2) }
                HStack(spacing: 8) {
                    Text(Fmt.rel(th.updatedAt))
                    if let c = th.costUsd, c > 0 { Text(Fmt.usd(c)) }
                }
                .font(.caption2).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 6)
            ThreadStateBadge(state: th.status == "waiting" ? "blocked" : th.status == "running" ? "working" : th.threadState ?? "done")
        }
        .padding(.vertical, 4)
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Haptic.tap()
        Task {
            do { try await work(); error = nil } catch { self.error = error.localizedDescription }
            await vm.loadThreads()
            await app.refresh()
        }
    }
}
