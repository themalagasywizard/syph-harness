import SwiftUI

/// Searchable model sheet. Defaults first, then DeepSeek and local models, then search hits
/// (same grouping as the desktop picker). Typing `provider:model` lets you use any model exactly.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var title = "Model"
    var value: String?
    /// Also show the effort selector (and the provider's usage) for the chosen model.
    var effort = false
    var onPick: (String) -> Void
    @State private var usage: ProviderUsage?
    @State private var models: [ModelInfo] = []
    @State private var query = ""
    @State private var loading = true

    struct Group: Identifiable { var label: String; var items: [(ref: String, label: String)]; var id: String { label } }

    private var groups: [Group] {
        let d = app.state?.config.defaults
        var pinned: [String] = []
        // Opens on the selected model and the ones picked recently, like the desktop's menu.
        for r in [value].compactMap({ $0 }) + RecentModels.list + [d?.chatModel, d?.frontendModel, d?.reflectorModel].compactMap({ $0 }) where !pinned.contains(r) { pinned.append(r) }
        pinned = Array(pinned.prefix(7))
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let match = { (m: ModelInfo) in needle.isEmpty || m.ref.lowercased().contains(needle) || m.label.lowercased().contains(needle) }
        var out: [Group] = []
        if needle.isEmpty { out.append(Group(label: "Recent", items: pinned.map { ($0, Fmt.model($0)) })) }
        var order: [String] = []
        var by: [String: [ModelInfo]] = [:]
        for m in models where match(m) {
            if needle.isEmpty && m.provider == "openrouter" && !m.ref.contains("deepseek") { continue }
            if by[m.provider] == nil { order.append(m.provider) }
            by[m.provider, default: []].append(m)
        }
        for p in order { out.append(Group(label: Fmt.providerLabel(p), items: by[p]!.prefix(needle.isEmpty ? 12 : 40).map { ($0.ref, $0.label) })) }
        let exact = query.trimmingCharacters(in: .whitespaces)
        if !needle.isEmpty && !models.contains(where: { $0.ref == exact }) { out.append(Group(label: "Use exactly", items: [(exact, exact)])) }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                if effort, !Effort.levels(value).isEmpty { effortSection }
                if effort, let usage, !usage.meters.isEmpty {
                    Section("\(Fmt.providerLabel(usage.provider)) usage") { UsageBar(usage: usage).listRowBackground(Palette.surface) }
                }
                ForEach(groups) { g in
                    Section(g.label) {
                        ForEach(g.items, id: \.ref) { m in
                            Button {
                                Haptic.tap()
                                onPick(m.ref)
                                dismiss()
                            } label: {
                                HStack(spacing: 12) {
                                    IconTile(system: icon(for: m.ref), color: m.ref.hasPrefix("openrouter") ? Palette.accent : Palette.ok, size: 32)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(m.label).foregroundStyle(Palette.text).lineLimit(1)
                                        Text(m.ref.replacingOccurrences(of: "openrouter:", with: "")).font(.caption.monospaced()).foregroundStyle(Palette.muted).lineLimit(1)
                                    }
                                    Spacer()
                                    if m.ref == value { Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.accent).font(.title3) }
                                }
                            }
                            .listRowBackground(Palette.surface)
                        }
                    }
                }
                if loading && models.isEmpty {
                    HStack { ProgressView(); Text("Loading models…").foregroundStyle(Palette.muted) }.listRowBackground(Color.clear)
                } else if models.isEmpty {
                    Text("No models found. Ollama and LM Studio show up while they're running.").font(.footnote).foregroundStyle(Palette.muted).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search, or type provider:model")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .task {
            models = await app.loadModels()
            loading = false
        }
        .task(id: value) {
            guard effort, let v = value else { return }
            let p = PhoneKeys.split(v).provider
            if ["openrouter", "minimax", "gemini"].contains(p) { usage = try? await app.backend.usage(p, model: PhoneKeys.split(v).model, fresh: false) }
        }
    }

    private var effortSection: some View {
        let current = app.state?.config.defaults.effort ?? "auto"
        let levels = Effort.levels(value)
        let shown = levels.contains(current) ? current : "auto"
        return Section {
            Picker("Effort", selection: Binding(get: { shown }, set: { e in
                Haptic.tap()
                guard let d = app.state?.config.defaults else { return }
                var json = d.json
                if case .object(var o) = json { o["effort"] = .string(e); json = .object(o) }
                Task { await app.patchSettings(["defaults": json]) }
            })) {
                ForEach(levels, id: \.self) { Text(Effort.label($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Palette.surface)
        } header: { Text("Effort") } footer: { Text(Effort.hint(shown)) }
    }

    private func icon(for ref: String) -> String {
        if ref.hasPrefix("ollama") || ref.hasPrefix("lmstudio") { return "cpu" }
        return "cloud.fill"
    }
}

/// A row-style button that shows the current model and opens the picker.
struct ModelField: View {
    var title = "Model"
    var value: String?
    var onPick: (String) -> Void
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 6) {
                Text(Fmt.model(value).isEmpty ? "Choose" : Fmt.model(value)).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Palette.muted)
        }
        .sheet(isPresented: $open) {
            ModelPickerSheet(title: title, value: value, onPick: onPick).presentationDetents([.medium, .large])
        }
    }
}
