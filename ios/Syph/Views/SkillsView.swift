import SwiftUI

/// Manage skills, as on the desktop's Skills page: switch one off, edit it, delete it (each change is
/// a proposal you can roll back in Evolve), write a new one, and see the tidy-up hints Syph found.
struct SkillsView: View {
    @Environment(AppModel.self) private var app
    @State private var data: SkillsResponse?
    @State private var error: String?
    @State private var query = ""
    @State private var editing: SkillInfo?
    @State private var creating = false
    @State private var confirmDelete: SkillInfo?
    @State private var note: String?

    private var skills: [SkillInfo] {
        let all = data?.skills ?? []
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? all : all.filter { $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q) }
    }

    var body: some View {
        List {
            if !app.capabilities.skills {
                Section { NeedsComputerNote(what: "Skills") }
            }
            if let a = data?.audit, !(a.duplicates.isEmpty && a.unused.isEmpty && a.empty.isEmpty) {
                Section("Worth a look") {
                    ForEach(a.duplicates, id: \.skills) { d in
                        Label("\(d.skills.joined(separator: " and ")) look alike (\(Int(d.similarity * 100))%). Merge or delete one.", systemImage: "square.on.square")
                    }
                    ForEach(a.unused, id: \.name) { u in
                        Label("\(u.name) hasn't been used in \(Int(u.ageDays)) days.", systemImage: "moon.zzz")
                    }
                    ForEach(a.empty, id: \.self) { n in Label("\(n) has no instructions yet.", systemImage: "doc") }
                }
                .font(.footnote)
                .foregroundStyle(Palette.muted)
                .listRowBackground(Palette.surface)
            }
            Section {
                ForEach(skills) { sk in
                    Button { editing = sk } label: { row(sk) }
                        .listRowBackground(Palette.surface)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { confirmDelete = sk } label: { Label("Delete", systemImage: "trash") }
                            Button { toggle(sk) } label: { Label(sk.active ? "Switch off" : "Switch on", systemImage: sk.active ? "pause" : "play") }
                                .tint(sk.active ? Palette.warn : Palette.ok)
                        }
                }
                if data != nil && skills.isEmpty {
                    Text(query.isEmpty ? "No skills yet. Syph proposes them when it notices a procedure it keeps repeating." : "No matches.")
                        .font(.footnote).foregroundStyle(Palette.muted).listRowBackground(Color.clear)
                }
            } header: {
                if let n = data?.skills.count { Text("\(n) skill\(n == 1 ? "" : "s")") }
            } footer: {
                Text("Each change is a proposal, accepted at once and kept in Evolve, so you can roll it back.")
            }
            if let note { Text(note).font(.footnote).foregroundStyle(Palette.ok).listRowBackground(Color.clear) }
            if let error { Text(error).font(.footnote).foregroundStyle(Palette.err).listRowBackground(Color.clear) }
        }
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        .navigationTitle("Skills")
        .searchable(text: $query, prompt: "Search skills")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { creating = true } label: { Image(systemName: "plus").font(.body.weight(.semibold)) }
                    .disabled(!app.capabilities.skills)
            }
        }
        .refreshable { await load() }
        .task(id: app.tick) { await load() }
        .sheet(item: $editing) { sk in SkillEditor(skill: sk) { await load() } }
        .sheet(isPresented: $creating) { SkillEditor(skill: nil) { await load() } }
        .confirmationDialog("Delete \(confirmDelete?.name ?? "")?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete skill", role: .destructive) {
                guard let sk = confirmDelete else { return }
                run("Deleted \(sk.name). Roll it back in Evolve if you change your mind.") { try await app.backend.deleteSkill(sk.name) }
            }
        }
    }

    private func row(_ sk: SkillInfo) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(system: "wand.and.stars", color: sk.active ? Palette.accent : Palette.faint, size: 34)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(sk.name).font(.body.weight(.medium)).foregroundStyle(sk.active ? Palette.text : Palette.muted)
                    if !sk.active { Tag(text: "Off", color: Palette.faint) }
                    if !(sk.pending ?? []).isEmpty { Tag(text: "Change pending", color: Palette.warn) }
                }
                Text(sk.description).font(.footnote).foregroundStyle(Palette.muted).lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 8) {
                    if let u = sk.usage { Text(u.uses == 0 ? "Not used yet" : "Used \(u.uses)×\(u.lastUsed.map { ", last \(Fmt.rel($0))" } ?? "")") }
                    if let by = sk.createdBy, by != "default" { Text("by \(by == "user" ? "you" : by)") }
                }
                .font(.caption2).foregroundStyle(Palette.faint)
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        guard app.capabilities.skills else { return }
        do { data = try await app.backend.skills(); error = nil } catch { self.error = error.localizedDescription }
    }

    private func toggle(_ sk: SkillInfo) {
        run(sk.active ? "Switched off \(sk.name)." : "Switched on \(sk.name).") { try await app.backend.setSkillActive(sk.name, active: !sk.active) }
    }

    private func run(_ done: String, _ work: @escaping () async throws -> Void) {
        Haptic.tap()
        Task {
            do { try await work(); note = done; error = nil; Haptic.success() } catch { self.error = error.localizedDescription; Haptic.warning() }
            await load()
            await app.refresh()
        }
    }
}

/// Edit a skill's description and instructions, or write a new one.
struct SkillEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var skill: SkillInfo?
    var onSaved: () async -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var bodyText = ""
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                if skill == nil {
                    Section { TextField("name-with-dashes", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled() } header: { Text("Name") }
                }
                Section {
                    TextField("When Syph should use this skill, in one line", text: $description, axis: .vertical).lineLimit(1...3)
                } header: { Text("Description") }
                Section {
                    TextEditor(text: $bodyText).font(.callout.monospaced()).frame(minHeight: 260)
                } header: { Text("Instructions") } footer: {
                    if let s = skill, let v = s.versions, v > 1 { Text("\(v) versions kept. Earlier ones are in Evolve.") }
                }
                if let error { Section { Text(error).foregroundStyle(Palette.err) } }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle(skill?.name ?? "New skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { save() }
                        .fontWeight(.semibold)
                        .disabled(saving || description.trimmingCharacters(in: .whitespaces).isEmpty || (skill == nil && name.trimmingCharacters(in: .whitespaces).isEmpty))
                }
            }
        }
        .onAppear {
            if let s = skill { name = s.name; description = s.description; bodyText = s.body }
        }
    }

    private func save() {
        saving = true
        Task {
            do {
                if let s = skill { try await app.backend.saveSkill(s.name, description: description, body: bodyText) }
                else { try await app.backend.createSkill(name, description: description, body: bodyText) }
                Haptic.success()
                await onSaved()
                dismiss()
            } catch {
                self.error = error.localizedDescription
                Haptic.warning()
            }
            saving = false
        }
    }
}
