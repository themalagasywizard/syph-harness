import SwiftUI

struct TasksView: View {
    @Environment(AppModel.self) private var app
    @State private var tasks: [SyphTask] = []
    @State private var loaded = false
    @State private var editing: TaskDraft?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Prompts that run on a schedule while Syph is open on your computer. Each run is saved as a chat.")
                    .font(.subheadline).foregroundStyle(Palette.muted)
                if let next = tasks.filter({ $0.enabled }).compactMap({ t in Fmt.date(t.nextRun).map { (t, $0) } }).min(by: { $0.1 < $1.1 }) {
                    NextUpCard(task: next.0, date: next.1)
                }
                if loaded && tasks.isEmpty {
                    EmptyState(icon: "clock.arrow.2.circlepath", title: "No tasks yet", message: "A task runs a prompt on a schedule, for example a morning digest of a project's notes.").card()
                }
                VStack(spacing: 10) {
                    ForEach(tasks) { t in
                        TaskCard(task: t, project: app.project(t.projectId), defaultModel: app.state?.config.defaults.taskModel) { enabled in
                            setEnabled(t.id, enabled)
                        } open: {
                            editing = TaskDraft(t)
                        } openResult: {
                            if let id = t.lastChatId { app.openChat(id) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
            .animation(.smooth, value: tasks)
        }
        .background(Backdrop())
        .navigationTitle("Tasks")
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptic.tap(); editing = TaskDraft() } label: { Image(systemName: "plus").font(.body.weight(.semibold)) }
            }
        }
        .sheet(item: $editing) { d in
            TaskEditor(draft: d) { Task { await load() } }
        }
        .task(id: app.tick) {
            await load()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await load()
            }
        }
    }

    private func load() async {
        if let t = try? await app.backend.tasks() { tasks = t }
        loaded = true
    }

    private func setEnabled(_ id: String, _ enabled: Bool) {
        Haptic.tap()
        if let i = tasks.firstIndex(where: { $0.id == id }) { tasks[i].enabled = enabled }
        Task {
            try? await app.backend.patchTask(id, ["enabled": .bool(enabled)])
            await load()
        }
    }
}

extension TaskDraft: Identifiable {}

struct NextUpCard: View {
    var task: SyphTask
    var date: Date
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Next up").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted).textCase(.uppercase)
                Text(task.name).font(.title3.weight(.semibold)).lineLimit(1)
                Text(date, style: .relative).font(.subheadline).foregroundStyle(Palette.accent).monospacedDigit()
            }
            Spacer()
            ZStack {
                Circle().stroke(Palette.surface3, lineWidth: 6)
                Circle().trim(from: 0, to: 0.72).stroke(Palette.accentGradient, style: StrokeStyle(lineWidth: 6, lineCap: .round)).rotationEffect(.degrees(-90))
                Image(systemName: "clock.fill").foregroundStyle(Palette.accent)
            }
            .frame(width: 56, height: 56)
        }
        .padding(20)
        .glass(radius: 26)
    }
}

struct TaskCard: View {
    var task: SyphTask
    var project: Project?
    var defaultModel: String?
    var setEnabled: (Bool) -> Void
    var open: () -> Void
    var openResult: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(task.name).font(.headline).foregroundStyle(Palette.text)
                        Text([project?.name, Fmt.model(task.model ?? defaultModel)].compactMap { $0 }.joined(separator: " · "))
                            .font(.footnote).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                    Spacer()
                    Toggle("", isOn: Binding(get: { task.enabled }, set: setEnabled)).labelsHidden().tint(Palette.ok)
                }
                HStack(spacing: 8) {
                    Label(task.scheduleText ?? Cron.describe(task.schedule), systemImage: "repeat")
                        .font(.footnote.weight(.medium)).foregroundStyle(Palette.text)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Palette.surface2, in: Capsule())
                    Text(task.schedule).font(.caption.monospaced()).foregroundStyle(Palette.faint)
                }
                Divider().overlay(Palette.stroke)
                HStack {
                    StatusDot(status: task.lastStatus, pulse: task.lastStatus == "running")
                    Text(task.lastStatus == "running" ? "Running…" : task.lastRun.map { "Ran \(Fmt.rel($0))" } ?? "Never run")
                        .font(.footnote).foregroundStyle(Palette.muted)
                    if task.lastChatId != nil {
                        Button(action: openResult) {
                            Label("Result", systemImage: "bubble.left.fill").font(.footnote.weight(.semibold))
                        }
                        .padding(.leading, 4)
                    }
                    Spacer()
                    Text(task.enabled ? (Fmt.rel(task.nextRun).isEmpty ? "—" : "Next \(Fmt.rel(task.nextRun))") : "Paused")
                        .font(.footnote).foregroundStyle(task.enabled ? Palette.muted : Palette.faint)
                }
            }
            .padding(18)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Palette.stroke))
            .opacity(task.enabled ? 1 : 0.6)
        }
        .buttonStyle(.pressable)
    }
}

struct TaskEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var draft: TaskDraft
    var saved: () -> Void
    @State private var error: String?
    @State private var confirmDelete = false

    private var desc: String { Cron.describe(draft.schedule) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Morning digest", text: $draft.name)
                    TextField("What should Syph do each time?", text: $draft.prompt, axis: .vertical).lineLimit(3...8)
                } header: { Text("Task") }

                Section {
                    TextField("0 8 * * *", text: $draft.schedule)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Cron.presets, id: \.1) { p in
                                Button {
                                    Haptic.tap()
                                    draft.schedule = p.1
                                } label: {
                                    Text(p.0).font(.footnote.weight(.semibold))
                                        .foregroundStyle(draft.schedule == p.1 ? Palette.bg : Palette.text)
                                        .padding(.horizontal, 12).frame(height: 32)
                                        .background(draft.schedule == p.1 ? Palette.text : Palette.surface3, in: Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                } header: { Text("Schedule") } footer: {
                    Text(desc).foregroundStyle(desc.hasPrefix("Invalid") ? Palette.err : Palette.muted)
                }

                Section {
                    Picker("Project", selection: $draft.projectId) {
                        Text("None").tag(String?.none)
                        ForEach(app.state?.projects ?? []) { Text($0.name).tag(String?.some($0.id)) }
                    }
                    HStack {
                        Text("Model")
                        Spacer()
                        ModelField(value: draft.model ?? app.state?.config.defaults.taskModel) { draft.model = $0 }
                    }
                    Toggle("Enabled", isOn: $draft.enabled).tint(Palette.ok)
                }

                if let error { Section { Text(error).foregroundStyle(Palette.err) } }

                if let id = draft.id {
                    Section {
                        Button {
                            Task {
                                try? await app.backend.runTask(id)
                                Haptic.success()
                                saved(); dismiss()
                            }
                        } label: { Label("Run now", systemImage: "play.fill") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete task", systemImage: "trash") }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle(draft.id == nil ? "New task" : "Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).fontWeight(.semibold) }
            }
            .confirmationDialog("Delete this task?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        if let id = draft.id { try? await app.backend.deleteTask(id) }
                        saved(); dismiss()
                    }
                }
            }
        }
    }

    private func save() {
        guard !draft.name.trimmingCharacters(in: .whitespaces).isEmpty, !draft.prompt.trimmingCharacters(in: .whitespaces).isEmpty else {
            error = "Give the task a name and a prompt."; Haptic.warning(); return
        }
        guard !desc.hasPrefix("Invalid") else { error = desc; Haptic.warning(); return }
        Task {
            do {
                try await app.backend.saveTask(draft)
                Haptic.success()
                saved()
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
