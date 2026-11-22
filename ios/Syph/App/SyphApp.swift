import SwiftUI

@main
struct SyphApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.theme.scheme)
                .tint(Palette.accent)
                // The Camera app opens syph://pair links straight into the app.
                .onOpenURL { url in
                    guard url.scheme == "syph" else { return }
                    Task {
                        do { try await model.pair(link: url.absoluteString) }
                        catch { model.loadError = error.localizedDescription }
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if app.connection == .none {
                WelcomeView().transition(.opacity.combined(with: .scale(scale: 1.02)))
            } else {
                Shell().transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.45), value: app.connection)
    }
}

/// The whole app: one chat screen, with the menu sliding in from the left (swipe right or tap ☰).
struct Shell: View {
    @Environment(AppModel.self) private var app
    @State private var drag: CGFloat = 0

    var body: some View {
        @Bindable var app = app
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 360)
            let base: CGFloat = app.drawerOpen ? width : 0
            let x = min(max(base + drag, 0), width)
            let progress = x / width

            ZStack(alignment: .leading) {
                SideMenu()
                    .frame(width: width)
                    .offset(x: (progress - 1) * 60)
                    .opacity(0.4 + 0.6 * progress)

                NavigationStack(path: $app.path) {
                    ChatView(route: app.current)
                        .id(app.current)
                        .navigationDestination(for: Page.self) { page in
                            switch page {
                            case .projects: ProjectsView()
                            case .tasks: TasksView()
                            case .evolve: EvolveView()
                            case .connectors: ConnectorsView()
                            case .settings: SettingsView()
                            }
                        }
                }
                .clipShape(RoundedRectangle(cornerRadius: progress > 0 ? 34 : 0, style: .continuous))
                .shadow(color: .black.opacity(0.45 * progress), radius: 30, x: -8)
                .overlay {
                    if progress > 0 {
                        RoundedRectangle(cornerRadius: 34, style: .continuous)
                            .fill(Color.black.opacity(0.35 * progress))
                            .onTapGesture { close() }
                            .allowsHitTesting(app.drawerOpen)
                    }
                }
                .scaleEffect(1 - 0.06 * progress, anchor: .leading)
                .offset(x: x)
                .ignoresSafeArea()
                .simultaneousGesture(swipe(width: width), including: app.path.isEmpty ? .all : .subviews)
            }
            .background(Palette.bg.ignoresSafeArea())
        }
        .overlay(alignment: .top) {
            if let err = app.loadError, app.state == nil { OfflineCard(message: err) }
        }
        .onChange(of: app.drawerOpen) { _, open in
            Haptic.soft()
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }

    private func swipe(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 18)
            .onChanged { v in
                guard abs(v.translation.width) > abs(v.translation.height) * 1.4 else { return }
                if app.drawerOpen ? v.translation.width < 0 : v.translation.width > 0 { drag = v.translation.width }
            }
            .onEnded { v in
                let projected = v.predictedEndTranslation.width
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                    if !app.drawerOpen && drag > 0 && (drag > width * 0.35 || projected > width * 0.6) { app.drawerOpen = true }
                    else if app.drawerOpen && drag < 0 && (-drag > width * 0.3 || projected < -width * 0.5) { app.drawerOpen = false }
                    drag = 0
                }
            }
    }

    private func close() {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { app.drawerOpen = false }
    }
}

/// Shown when Syph can't be reached on launch.
struct OfflineCard: View {
    @Environment(AppModel.self) private var app
    var message: String

    var body: some View {
        ZStack {
            Backdrop()
            VStack(spacing: 18) {
                SyphMark(size: 54, color: Palette.muted)
                Text("Can't reach Syph").font(.title2.bold())
                Text(message).font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                VStack(spacing: 10) {
                    Button("Try again") { Task { await app.refresh() } }.buttonStyle(.primary)
                    Button("Use the demo instead") { app.connect(.demo) }.buttonStyle(.tonal)
                    Button("Pair again") { app.forgetConnection() }
                        .font(.subheadline.weight(.semibold)).padding(.top, 4)
                }
                .padding(.top, 6)
            }
            .padding(32)
        }
    }
}
