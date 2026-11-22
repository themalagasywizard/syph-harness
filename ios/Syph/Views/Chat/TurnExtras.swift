import SwiftUI
import QuickLook

// MARK: - Plan checklist

/// The step-by-step plan Syph keeps for multi-step tasks, ticked off as it works.
struct PlanChecklist: View {
    var steps: [PlanStep]
    var streaming: Bool

    private var done: Int { steps.filter { $0.status == "done" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.caption.weight(.bold)).foregroundStyle(Palette.accent)
                Text("Plan").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(done) of \(steps.count)").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted).monospacedDigit()
            }
            ProgressView(value: Double(done), total: Double(max(steps.count, 1)))
                .tint(done == steps.count ? Palette.ok : Palette.accent)
                .scaleEffect(y: 0.7)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        icon(s.status)
                            .frame(width: 16)
                        Text(s.text)
                            .font(.subheadline)
                            .foregroundStyle(s.status == "done" ? Palette.muted : Palette.text)
                            .strikethrough(s.status == "done", color: Palette.faint)
                            .fontWeight(s.status == "in_progress" ? .semibold : .regular)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(14)
        .background(Palette.surface2.opacity(0.75), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Palette.stroke))
        .animation(.smooth, value: steps)
    }

    @ViewBuilder private func icon(_ status: String) -> some View {
        switch status {
        case "done":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.ok)
        case "in_progress":
            if streaming {
                Image(systemName: "circle.dotted").foregroundStyle(Palette.accent)
                    .symbolEffect(.rotate, options: .repeating)
            } else {
                Image(systemName: "circle.lefthalf.filled").foregroundStyle(Palette.accent)
            }
        default:
            Image(systemName: "circle").foregroundStyle(Palette.faint)
        }
    }
}

// MARK: - Files Syph made

enum FileKind {
    static func icon(_ name: String) -> (String, Color) {
        switch (name as NSString).pathExtension.lowercased() {
        case "pptx", "ppt", "key": return ("rectangle.on.rectangle.angled.fill", Color(hex: "#F2A27A"))
        case "docx", "doc", "pages", "rtf": return ("doc.richtext.fill", Color(hex: "#8FA8FF"))
        case "xlsx", "xls", "csv", "tsv", "numbers": return ("tablecells.fill", Color(hex: "#7FD4A0"))
        case "pdf": return ("doc.text.image.fill", Color(hex: "#FF8A7A"))
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg": return ("photo.fill", Color(hex: "#B7A6FF"))
        case "md", "markdown", "txt": return ("doc.plaintext.fill", Palette.muted)
        case "mp4", "mov", "webm": return ("film.fill", Color(hex: "#B7A6FF"))
        case "mp3", "wav", "m4a", "ogg": return ("waveform", Color(hex: "#B7A6FF"))
        case "html", "htm", "js", "ts", "tsx", "py", "swift", "sh", "json", "css", "ps1": return ("chevron.left.forwardslash.chevron.right", Palette.accent)
        default: return ("doc.fill", Palette.muted)
        }
    }

    static func size(_ bytes: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

/// Cards for the files an answer created or changed. Tap one to preview it.
struct FileCards: View {
    var files: [FileRef]
    @State private var preview: FileRef?

    var body: some View {
        VStack(spacing: 8) {
            ForEach(files) { f in
                Button { Haptic.tap(); preview = f } label: { FileRow(file: f) }
                    .buttonStyle(.pressable)
            }
        }
        .sheet(item: $preview) { f in FilePreviewSheet(file: f) }
    }
}

struct FileRow: View {
    var file: FileRef
    var body: some View {
        let (icon, color) = FileKind.icon(file.name)
        HStack(spacing: 12) {
            IconTile(system: icon, color: color, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Text([file.action == "modified" ? "Changed" : "Created", FileKind.size(file.size), file.rel].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            if file.exists == false {
                Tag(text: "Gone", color: Palette.faint)
            } else {
                Image(systemName: "eye").font(.subheadline).foregroundStyle(Palette.muted)
            }
        }
        .padding(10)
        .background(Palette.surface2.opacity(0.75), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Palette.stroke))
    }
}

/// Downloads a file from the computer and shows it with Quick Look (slides, docs, sheets, PDFs, images, code…).
struct FilePreviewSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var file: FileRef
    @State private var local: URL?
    @State private var error: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Group {
                if let local, ["md", "markdown"].contains(local.pathExtension.lowercased()), let text = try? String(contentsOf: local, encoding: .utf8) {
                    // Quick Look shows Markdown as plain text, so draw it like a chat answer.
                    ScrollView {
                        MarkdownView(text: text).textSelection(.enabled).padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if let local {
                    QuickLookView(url: local).ignoresSafeArea(edges: .bottom)
                } else if let error {
                    VStack(spacing: 16) {
                        EmptyState(icon: "exclamationmark.triangle", title: "Couldn't open \(file.name)", message: error)
                        Button("Try again") { Task { await load() } }.buttonStyle(.tonalCompact)
                    }
                } else {
                    VStack(spacing: 14) {
                        CellLoader(size: 34)
                        Text("Getting \(file.name) from your computer…").font(.footnote).foregroundStyle(Palette.muted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Palette.bg)
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            UIPasteboard.general.string = file.path
                            Haptic.success()
                        } label: { Label("Copy path on computer", systemImage: "doc.on.doc") }
                        Text(file.path)
                    } label: { Image(systemName: "info.circle") }
                    if let local { ShareLink(item: local) { Image(systemName: "square.and.arrow.up") } }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        error = nil
        do { local = try await app.backend.download(file.path) }
        catch { self.error = error.localizedDescription }
    }
}

struct QuickLookView: UIViewControllerRepresentable {
    var url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let c = QLPreviewController()
        c.dataSource = context.coordinator
        return c
    }

    func updateUIViewController(_ c: QLPreviewController, context: Context) {
        context.coordinator.url = url
        c.reloadData()
    }

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// Every file this chat made, newest first.
struct ChatFilesSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var chatId: String
    @State private var files: [FileRef]?
    @State private var preview: FileRef?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 8) {
                    if let files {
                        if files.isEmpty {
                            EmptyState(icon: "doc", title: "No files yet", message: "Files Syph creates or changes in this chat show up here.")
                        }
                        ForEach(files) { f in
                            Button { preview = f } label: { FileRow(file: f) }.buttonStyle(.pressable)
                        }
                    } else {
                        ProgressView().padding(.top, 60)
                    }
                }
                .padding(20)
            }
            .background(Palette.bg)
            .navigationTitle("Files in this chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $preview) { f in FilePreviewSheet(file: f) }
        }
        .task { files = (try? await app.backend.chatFiles(chatId)) ?? [] }
    }
}

// MARK: - Repos

/// "main ● 2 ↑1" — the branch and what's waiting.
struct RepoBadges: View {
    var repo: RepoStatus
    var body: some View {
        HStack(spacing: 6) {
            if let b = repo.branch {
                Label(b, systemImage: "arrow.triangle.branch").labelStyle(.titleAndIcon)
            }
            if let d = repo.dirty, d > 0 { Text("● \(d)").foregroundStyle(Palette.warn) }
            if let a = repo.ahead, a > 0 { Text("↑\(a)").foregroundStyle(Palette.accent) }
            if let b = repo.behind, b > 0 { Text("↓\(b)").foregroundStyle(Palette.accent2) }
            if !repo.exists { Text("missing").foregroundStyle(Palette.err) }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Palette.muted)
        .monospacedDigit()
    }
}

/// Shared pull / push with a result message, used by the chat chip and project pages.
@MainActor @Observable
final class RepoActions {
    var busy: String?
    var message: String?
    var failed = false

    func run(_ label: String, _ work: @escaping () async throws -> RepoActionResult, then: @escaping () async -> Void) {
        guard busy == nil else { return }
        busy = label
        message = nil
        Task {
            do {
                let r = try await work()
                failed = false
                let out = (r.output ?? "").split(separator: "\n").last.map(String.init) ?? ""
                message = out.isEmpty ? "\(label) done." : out
                Haptic.success()
            } catch {
                failed = true
                message = error.localizedDescription
                Haptic.warning()
            }
            busy = nil
            await then()
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            withAnimation { message = nil }
        }
    }
}

/// The chip above the chat bar: which repo this chat is working on, with pull / push.
struct RepoChip: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    var vm: ChatViewModel
    var onLink: () -> Void
    @State private var actions = RepoActions()

    var body: some View {
        if let r = vm.activeRepo {
            VStack(alignment: .leading, spacing: 6) {
                Menu {
                    if vm.repos.count > 1 {
                        Section("Working on") {
                            ForEach(vm.repos) { x in
                                Button { vm.setActiveRepo(x) } label: { Label(x.name, systemImage: x.path == r.path ? "checkmark" : "shippingbox") }
                            }
                        }
                    }
                    Section {
                        Button { actions.run("Pull", { try await app.backend.pullRepo(r.path) }, then: vm.loadRepos) } label: { Label("Pull latest", systemImage: "arrow.down.circle") }
                        Button { actions.run("Push", { try await app.backend.pushRepo(r.path) }, then: vm.loadRepos) } label: {
                            Label((r.ahead ?? 0) > 0 ? "Push \(r.ahead!) commit\(r.ahead == 1 ? "" : "s")" : "Push", systemImage: "arrow.up.circle")
                        }
                    }
                    Section {
                        if let u = URL(string: r.url) { Button { openURL(u) } label: { Label("Open on GitHub", systemImage: "safari") } }
                        Button { UIPasteboard.general.string = r.path; Haptic.success() } label: { Label("Copy folder path", systemImage: "folder") }
                        Button(action: onLink) { Label("Link another repo", systemImage: "plus") }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if actions.busy != nil { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "shippingbox.fill").font(.caption).foregroundStyle(Palette.accent) }
                        Text(r.name).font(.footnote.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                        RepoBadges(repo: r)
                        Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.faint)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .glassCapsule()
                }
                .simultaneousGesture(TapGesture().onEnded { Haptic.tap() })
                if let m = actions.message {
                    Text(m).font(.caption).foregroundStyle(actions.failed ? Palette.err : Palette.muted).lineLimit(2)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .animation(.smooth, value: actions.message)
        }
    }
}

/// Pick one of your GitHub repos (or paste owner/name or a URL) and link it to the chat or its project.
struct RepoPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var projectName: String?
    /// Chat links offer a choice of scope; project pages always link to the project.
    var allowChatScope = true
    var link: (_ repo: String, _ scope: String) async throws -> Void

    @State private var query = ""
    @State private var repos: [GithubRepo]?
    @State private var github: GithubState?
    @State private var scope = "project"
    @State private var linking: String?
    @State private var error: String?

    private var typed: String? {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.contains("/") ? q : nil
    }

    var body: some View {
        NavigationStack {
            List {
                if allowChatScope && projectName != nil {
                    Section {
                        Picker("Link to", selection: $scope) {
                            Text("Whole project").tag("project")
                            Text("This chat only").tag("chat")
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    } footer: {
                        Text(scope == "project" ? "Every chat in \(projectName!) works on it." : "Only this chat works on it.")
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.err).font(.footnote) }
                }
                if let typed {
                    Section {
                        row(title: typed, subtitle: "Clone this repo", icon: "link", key: typed)
                    }
                }
                if let github, !github.connected {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("GitHub isn't connected", systemImage: "person.crop.circle.badge.exclamationmark").font(.subheadline.weight(.semibold))
                            Text("Paste owner/name or a URL to clone a public repo, or connect GitHub to list your own.").font(.footnote).foregroundStyle(Palette.muted)
                            Button("Open Connectors") { dismiss(); app.open(.connectors) }.buttonStyle(.tonalCompact)
                        }
                        .padding(.vertical, 4)
                    }
                }
                if let repos {
                    Section(github?.account.map { "Your repositories · \($0)" } ?? "Your repositories") {
                        if repos.isEmpty { Text("No matching repositories.").foregroundStyle(Palette.muted) }
                        ForEach(repos) { r in
                            row(title: r.full_name, subtitle: [r.description, r.pushed_at.map { "Pushed " + Fmt.rel($0) }].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "), icon: r.private ? "lock.fill" : "shippingbox", key: r.full_name)
                        }
                    }
                } else if github?.connected != false {
                    HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search, or paste owner/name")
            .navigationTitle("Link a repo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .interactiveDismissDisabled(linking != nil)
        }
        .task {
            github = try? await app.backend.github()
            if github?.connected != false { await search() }
        }
        .task(id: query) {
            guard github?.connected == true else { return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !Task.isCancelled { await search() }
        }
        .onAppear { if projectName == nil { scope = "chat" } }
    }

    private func search() async {
        do { repos = try await app.backend.githubRepos(query: typed == nil ? query : nil) }
        catch { self.error = error.localizedDescription; repos = [] }
    }

    private func row(title: String, subtitle: String, icon: String, key: String) -> some View {
        Button {
            guard linking == nil else { return }
            Haptic.tap()
            linking = key
            error = nil
            Task {
                do {
                    try await link(key, allowChatScope ? scope : "project")
                    Haptic.success()
                    dismiss()
                } catch {
                    self.error = error.localizedDescription
                    Haptic.warning()
                }
                linking = nil
            }
        } label: {
            HStack(spacing: 12) {
                IconTile(system: icon, color: Palette.accent, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
                    if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(Palette.muted).lineLimit(2) }
                }
                Spacer()
                if linking == key {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Cloning…").font(.caption).foregroundStyle(Palette.muted) }
                }
            }
        }
        .disabled(linking != nil && linking != key)
    }
}
