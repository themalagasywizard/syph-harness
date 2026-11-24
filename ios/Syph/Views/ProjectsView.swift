import SwiftUI

struct ProjectsView: View {
    @Environment(AppModel.self) private var app
    @State private var creating = false

    var body: some View {
        let projects = app.state?.projects ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Each project has its own instructions, files, memory and tasks.")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                if projects.isEmpty {
                    EmptyState(icon: "square.stack.3d.up", title: "No projects yet", message: "A project keeps related chats, files and scheduled tasks together, with its own instructions.").card()
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(projects) { p in
                        NavigationLink { ProjectDetailView(id: p.id) } label: { ProjectCard(project: p) }.buttonStyle(.pressable)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
        .background(Backdrop())
        .navigationTitle("Projects")
        .refreshable { await app.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptic.tap(); creating = true } label: { Image(systemName: "plus").font(.body.weight(.semibold)) }
            }
        }
        .sheet(isPresented: $creating) { NewProjectSheet() }
    }
}

struct ProjectCard: View {
    var project: Project
    var body: some View {
        let c = Color(hex: project.color ?? "#9EC7FF")
        VStack(alignment: .leading, spacing: 0) {
            IconTile(system: "folder.fill", color: c, size: 42)
            Spacer(minLength: 18)
            Text(project.name).font(.headline).foregroundStyle(Palette.text).lineLimit(1)
            Text(project.description?.isEmpty == false ? project.description! : "No description")
                .font(.footnote).foregroundStyle(Palette.muted).lineLimit(2).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
            HStack(spacing: 10) {
                Label("\(project.chatCount ?? 0)", systemImage: "bubble.left.fill")
                Label("\(project.taskCount ?? 0)", systemImage: "clock.fill")
            }
            .font(.caption.weight(.semibold)).foregroundStyle(Palette.faint)
            .padding(.top, 12)
        }
        .frame(height: 176, alignment: .topLeading)
        .padding(16)
        .background(
            ZStack(alignment: .topTrailing) {
                Palette.surface
                Circle().fill(c.opacity(0.22)).frame(width: 140).blur(radius: 40).offset(x: 50, y: -50)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Palette.stroke))
    }
}

struct NewProjectSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Name", text: $name); TextField("Description", text: $description) }
                Section {
                    TextField("Added to the system prompt for every chat and task in this project.", text: $instructions, axis: .vertical).lineLimit(4...10)
                } header: { Text("Instructions") }
                if let error { Section { Text(error).foregroundStyle(Palette.err) } }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty).fontWeight(.semibold)
                }
            }
        }
    }

    private func create() {
        Task {
            do {
                _ = try await app.backend.createProject(name: name.trimmingCharacters(in: .whitespaces), description: description, instructions: instructions)
                Haptic.success()
                await app.refresh()
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct ProjectDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var id: String
    @State private var p: ProjectDetail?
    @State private var tab = Section.chats
    @State private var instructions = ""
    @State private var saved = false
    @State private var confirmDelete = false
    @State private var repos: [RepoStatus] = []
    @State private var linking = false
    @State private var preview: FileRef?
    @State private var actions = RepoActions()
    @State private var threads: ProjectThreads?

    enum Section: String, CaseIterable { case chats = "Chats", instructions = "Instructions", files = "Files", tasks = "Tasks" }

    var body: some View {
        ScrollView {
            if let p {
                let c = Color(hex: p.color ?? "#9EC7FF")
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        IconTile(system: "folder.fill", color: c, size: 56)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.name).font(.title.bold())
                            if let d = p.description, !d.isEmpty { Text(d).font(.subheadline).foregroundStyle(Palette.muted) }
                        }
                    }
                    if let t = threads {
                        Button { Haptic.tap(); app.openChat(t.coordinatorId) } label: {
                            Label("Coordinator", systemImage: "bubble.left.and.text.bubble.right").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.primary)
                        threadsCard(t)
                    }
                    Button { app.newChat(projectId: p.id) } label: {
                        Label(threads == nil ? "New chat in \(p.name)" : "Plain chat in \(p.name)", systemImage: "square.and.pencil").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)

                    reposCard(p)

                    Picker("Section", selection: $tab) {
                        ForEach(Section.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: tab) { Haptic.tap() }

                    content(p)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
            } else {
                ProgressView().padding(.top, 80).frame(maxWidth: .infinity)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Backdrop(tint: Color(hex: p?.color ?? "#9EC7FF")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete project", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .confirmationDialog("Delete \"\(p?.name ?? "")\" and its files? Chats are kept.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete project", role: .destructive) {
                Task {
                    try? await app.backend.deleteProject(id)
                    await app.refresh()
                    dismiss()
                }
            }
        }
        .task(id: app.tick) { await load() }
        .sheet(isPresented: $linking) {
            RepoPickerSheet(projectName: p?.name, allowChatScope: false) { repo, _ in
                try await app.backend.linkRepo(repo, scope: "project", projectId: id, chatId: nil)
                await loadRepos()
            }
        }
        .sheet(item: $preview) { f in FilePreviewSheet(file: f) }
    }

    private func load() async {
        guard let d = try? await app.backend.project(id) else { return }
        withAnimation(.smooth) { p = d }
        instructions = d.instructions
        if let t = try? await app.backend.projectThreads(id) { withAnimation(.smooth) { threads = t } }
        await loadRepos()
    }

    @ViewBuilder private func threadsCard(_ t: ProjectThreads) -> some View {
        let active = t.threads.filter { $0.resolved != true }
        VStack(alignment: .leading, spacing: 8) {
            Text("Threads").sectionLabel().padding(.horizontal, 6)
            if active.isEmpty {
                Text("Ask the coordinator for some work and it starts a thread for it. Threads show up here.")
                    .font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 6)
            } else {
                RowGroup {
                    ForEach(active) { th in
                        Button { Haptic.tap(); app.openChat(th.id) } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(th.title).font(.body.weight(.medium)).foregroundStyle(Palette.text).lineLimit(1)
                                    if let s = th.summary { Text(s).font(.footnote).foregroundStyle(Palette.muted).lineLimit(2).multilineTextAlignment(.leading) }
                                }
                                Spacer(minLength: 6)
                                ThreadStateBadge(state: th.status == "waiting" ? "blocked" : th.status == "running" ? "working" : th.threadState ?? "done")
                            }
                            .padding(.vertical, 10)
                            .padding(.horizontal, 14)
                        }
                        .buttonStyle(.pressable)
                    }
                }
            }
        }
    }

    private func loadRepos() async {
        if let r = try? await app.backend.repos(projectId: id, chatId: nil) {
            withAnimation(.smooth) { repos = r.filter { $0.scope == "project" } }
        }
    }

    @ViewBuilder private func reposCard(_ p: ProjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Repositories").sectionLabel()
                Spacer()
                Button { Haptic.tap(); linking = true } label: { Label("Link repo", systemImage: "plus") }
                    .font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 6)
            if repos.isEmpty {
                Button { Haptic.tap(); linking = true } label: {
                    HStack(spacing: 12) {
                        IconTile(system: "shippingbox", color: Palette.muted, size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Link a GitHub repo").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
                            Text("Syph clones it into this project and works on it in every chat here: pull, edit, commit, push.")
                                .font(.footnote).foregroundStyle(Palette.muted).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(14)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.stroke))
                }
                .buttonStyle(.pressable)
            } else {
                RowGroup {
                    ForEach(repos) { r in
                        HStack(spacing: 12) {
                            IconTile(system: "shippingbox.fill", color: Palette.accent, size: 34)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(r.name).font(.body.weight(.medium)).foregroundStyle(Palette.text)
                                RepoBadges(repo: r)
                                if let e = r.error { Text(e).font(.caption).foregroundStyle(Palette.err) }
                            }
                            Spacer(minLength: 6)
                            if actions.busy != nil { ProgressView().controlSize(.small) }
                            Menu {
                                Button { actions.run("Pull", { try await app.backend.pullRepo(r.path) }, then: loadRepos) } label: { Label("Pull latest", systemImage: "arrow.down.circle") }
                                Button { actions.run("Push", { try await app.backend.pushRepo(r.path) }, then: loadRepos) } label: { Label("Push", systemImage: "arrow.up.circle") }
                                if let u = URL(string: r.url) { Link(destination: u) { Label("Open on GitHub", systemImage: "safari") } }
                                Button { UIPasteboard.general.string = r.path; Haptic.success() } label: { Label("Copy folder path", systemImage: "folder") }
                                Button(role: .destructive) {
                                    Task {
                                        try? await app.backend.unlinkRepo(r.path, projectId: id, chatId: nil)
                                        await loadRepos()
                                    }
                                } label: { Label("Unlink (keeps the folder)", systemImage: "link.badge.plus") }
                            } label: {
                                Image(systemName: "ellipsis").font(.body.weight(.semibold)).foregroundStyle(Palette.muted).frame(width: 36, height: 36)
                            }
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 14)
                    }
                }
            }
            if let m = actions.message {
                Text(m).font(.caption).foregroundStyle(actions.failed ? Palette.err : Palette.muted).padding(.horizontal, 6)
            }
        }
    }

    @ViewBuilder private func content(_ p: ProjectDetail) -> some View {
        switch tab {
        case .chats:
            if p.chats.isEmpty { EmptyState(icon: "bubble.left", title: "No chats yet", message: "Chats you start here use this project's instructions and files.").card() }
            else {
                RowGroup {
                    ForEach(p.chats) { c in
                        Button { app.openChat(c.id) } label: {
                            SettingRow(title: c.title, subtitle: Fmt.model(c.model)) {
                                Text(Fmt.rel(c.updatedAt)).font(.caption).foregroundStyle(Palette.faint)
                            }
                        }
                        .buttonStyle(.pressable)
                    }
                }
            }
        case .instructions:
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $instructions)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 220)
                    .padding(12)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.stroke))
                Text("Added to the system prompt for every chat and task in this project. Syph may propose edits in Evolve.")
                    .font(.footnote).foregroundStyle(Palette.muted)
                Button {
                    Task {
                        try? await app.backend.updateProject(id, ["instructions": .string(instructions)])
                        Haptic.success()
                        withAnimation { saved = true }
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        withAnimation { saved = false }
                    }
                } label: {
                    Label(saved ? "Saved" : "Save instructions", systemImage: saved ? "checkmark" : "square.and.arrow.down").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(instructions == p.instructions && !saved)
            }
        case .files:
            VStack(alignment: .leading, spacing: 10) {
                Text("Syph's file tools work inside this project's folder on your computer. Tap a file to preview it.").font(.footnote).foregroundStyle(Palette.muted)
                if let folder = p.folder {
                    Button { UIPasteboard.general.string = folder; Haptic.success() } label: {
                        Label(folder, systemImage: "folder").font(.caption.monospaced()).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                    }
                }
                if p.files.isEmpty { EmptyState(icon: "doc", title: "No files yet", message: "Drop files in the project's folder to share them with Syph.").card() }
                else {
                    RowGroup {
                        ForEach(p.files.prefix(300), id: \.self) { f in
                            Button {
                                guard let folder = p.folder else { return }
                                Haptic.tap()
                                preview = FileRef(path: folder + "/" + f, name: (f as NSString).lastPathComponent, action: "created", size: 0, rel: f)
                            } label: {
                                SettingRow(title: (f as NSString).lastPathComponent, subtitle: (f as NSString).deletingLastPathComponent, icon: FileKind.icon(f).0, iconColor: FileKind.icon(f).1) {
                                    if p.folder != nil { Image(systemName: "eye").font(.footnote).foregroundStyle(Palette.faint) }
                                }
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                }
            }
        case .tasks:
            if p.tasks.isEmpty { EmptyState(icon: "clock", title: "No tasks in this project", message: "Create one in Tasks and pick this project.").card() }
            else {
                RowGroup {
                    ForEach(p.tasks) { t in
                        SettingRow(title: t.name, subtitle: Cron.describe(t.schedule)) {
                            HStack(spacing: 6) {
                                StatusDot(status: t.lastStatus)
                                Text(t.lastRun.map { Fmt.rel($0) } ?? "Never run").font(.caption).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                }
            }
        }
    }
}
