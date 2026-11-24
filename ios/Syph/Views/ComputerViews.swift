import SwiftUI

// Things that live on the computer: folders linked to a chat or project, and the terminal Syph runs
// commands in. On the phone alone they aren't there, and the screens say so.

/// Folders on the computer this chat (or its project) can work in, with read or write access.
struct FoldersSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var vm: ChatViewModel
    @State private var path = ""
    @State private var access = "write"
    @State private var scope = "chat"
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if !app.capabilities.computer {
                    Section { NeedsComputerNote(what: "Linked folders") }
                } else {
                    Section {
                        if vm.folders.isEmpty {
                            Text("No folders yet. Link one and Syph can read (and, with write access, change) the files in it.")
                                .font(.footnote).foregroundStyle(Palette.muted)
                        }
                        ForEach(vm.folders) { f in
                            HStack(spacing: 12) {
                                IconTile(system: f.exists ? "folder.fill" : "folder.badge.questionmark", color: f.exists ? Palette.accent : Palette.warn, size: 34)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.name).font(.body.weight(.medium))
                                    Text(f.path).font(.caption.monospaced()).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                                    Text("\(f.access == "read" ? "Read only" : "Read and write") · \(f.scope == "chat" ? "This chat" : f.scope == "coordinator" ? "Coordinator and its threads" : "Whole project")")
                                        .font(.caption2).foregroundStyle(Palette.faint)
                                }
                                Spacer(minLength: 4)
                                Menu {
                                    Button { run { try await app.backend.setFolderAccess(f.path, access: f.access == "read" ? "write" : "read", projectId: vm.projectId, chatId: vm.chatId) } } label: {
                                        Label(f.access == "read" ? "Allow changes" : "Make read only", systemImage: f.access == "read" ? "pencil" : "eye")
                                    }
                                    Button { UIPasteboard.general.string = f.path; Haptic.success() } label: { Label("Copy path", systemImage: "doc.on.doc") }
                                    Button(role: .destructive) { run { try await app.backend.unlinkFolder(f.path, projectId: vm.projectId, chatId: vm.chatId) } } label: {
                                        Label("Unlink (keeps the folder)", systemImage: "link")
                                    }
                                } label: { Image(systemName: "ellipsis").foregroundStyle(Palette.muted).frame(width: 34, height: 34) }
                            }
                            .listRowBackground(Palette.surface)
                        }
                    } header: { Text("Linked folders") }

                    Section {
                        TextField(#"C:\Users\you\Documents\Notes"#, text: $path)
                            .font(.callout.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("Access", selection: $access) {
                            Text("Read and write").tag("write")
                            Text("Read only").tag("read")
                        }
                        if vm.projectId != nil {
                            Picker("For", selection: $scope) {
                                Text("This chat").tag("chat")
                                Text("Whole project").tag("project")
                            }
                        }
                        Button {
                            let p = path.trimmingCharacters(in: .whitespacesAndNewlines)
                            run {
                                if vm.chatId == nil && scope == "chat" { _ = try await ensureChat() }
                                try await app.backend.linkFolder(p, access: access, projectId: scope == "project" ? vm.projectId : nil, chatId: scope == "chat" ? vm.chatId : nil)
                                path = ""
                            }
                        } label: { Label(busy ? "Linking…" : "Link folder", systemImage: "link.badge.plus") }
                        .disabled(path.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                    } header: { Text("Link a folder on your computer") } footer: {
                        Text("Type the folder's full path on the computer. On the desktop you can also pick it with the folder picker.")
                    }
                    if let error { Section { Text(error).foregroundStyle(Palette.err).font(.footnote) } }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle("Folders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task { await vm.loadFolders() }
    }

    private func ensureChat() async throws -> String {
        if let id = vm.chatId { return id }
        let c = try await app.backend.createChat(projectId: vm.projectId, model: vm.model)
        vm.chatId = c.id
        vm.chat = c
        app.activeChatId = c.id
        return c.id
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        Haptic.tap()
        Task {
            do { try await work(); error = nil; Haptic.success() } catch { self.error = error.localizedDescription; Haptic.warning() }
            await vm.loadFolders()
            busy = false
        }
    }
}

/// The commands Syph ran for this chat on the computer, live, with a way to stop one.
struct TerminalSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var chatId: String
    @State private var state: TerminalState?
    @State private var error: String?
    @State private var open: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !app.capabilities.computer {
                        NeedsComputerNote(what: "The terminal")
                    } else if let state {
                        HStack(spacing: 8) {
                            Tag(text: state.shell, color: Palette.muted)
                            Tag(text: state.yolo ? "YOLO" : state.mode == "auto" ? "Runs without asking" : state.session ? "Allowed for this chat" : "Asks first", color: state.yolo || state.session ? Palette.warn : Palette.ok)
                            Spacer()
                            if state.session {
                                Button("Stop allowing") { Task { try? await app.backend.endTerminalSession(chatId); await load() } }
                                    .font(.footnote.weight(.semibold))
                            }
                        }
                        if state.entries.isEmpty {
                            EmptyState(icon: "terminal", title: "No commands yet", message: "Commands Syph runs for this chat on your computer show up here, with their output.").card()
                        }
                        ForEach(state.entries.reversed()) { e in entry(e) }
                    } else if let error {
                        ErrorBanner(text: error)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(16)
            }
            .background(Palette.bg)
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
        }
        .task {
            // Follow running commands: refresh every couple of seconds while the sheet is open.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: state?.entries.contains { $0.status == "running" } == true ? 1_500_000_000 : 5_000_000_000)
            }
        }
    }

    private func load() async {
        guard app.capabilities.computer else { return }
        do { state = try await app.backend.terminal(chatId); error = nil } catch { self.error = error.localizedDescription }
    }

    private func entry(_ e: TerminalEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { if open.contains(e.id) { open.remove(e.id) } else { open.insert(e.id) } } } label: {
                HStack(spacing: 8) {
                    StatusDot(status: e.status == "running" ? "running" : e.status == "done" ? "ok" : "error", pulse: e.status == "running")
                    Text(e.command).font(.system(.footnote, design: .monospaced).weight(.semibold)).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Text(e.status == "running" ? "Running" : e.exitCode.map { "Exit \($0.compact.replacingOccurrences(of: "\"", with: ""))" } ?? e.status.capitalized)
                        .font(.caption2).foregroundStyle(Palette.faint)
                }
            }
            .buttonStyle(.plain)
            Text(e.cwd).font(.caption2.monospaced()).foregroundStyle(Palette.faint).lineLimit(1).truncationMode(.middle)
            if open.contains(e.id) || e.status == "running" {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(e.output.isEmpty ? "(no output yet)" : String(e.output.suffix(8000)))
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.muted).textSelection(.enabled).padding(10)
                }
                .frame(maxHeight: 260)
                .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if e.status == "running" {
                Button { Task { try? await app.backend.stopCommand(e.id); await load() } } label: { Label("Stop", systemImage: "stop.fill") }
                    .buttonStyle(.destructiveCompact)
            }
        }
        .card(padding: 12, radius: 18)
    }
}

/// Explains a feature that needs Syph on the computer, with a way back to it.
struct NeedsComputerNote: View {
    @Environment(AppModel.self) private var app
    var what: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("\(what) needs your computer", systemImage: "desktopcomputer").font(.subheadline.weight(.semibold))
            Text("Syph is running on this phone alone right now. This comes back when the phone reaches Syph on your computer again.")
                .font(.footnote).foregroundStyle(Palette.muted)
            if app.pairedServer != nil {
                Button { Task { await app.reconnectNow() } } label: { Label(app.syncing ? "Connecting…" : "Reconnect", systemImage: "arrow.triangle.2.circlepath") }
                    .buttonStyle(.tonalCompact).disabled(app.syncing)
            }
        }
        .padding(.vertical, 4)
    }
}
