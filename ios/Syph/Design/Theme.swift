import SwiftUI

// Syph's iOS design language: near-black canvas, soft elevated cards, one cool accent,
// big confident numerals (Revolut-style) and Apple's materials / Liquid Glass where available.

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt64(s, radix: 16) ?? 0x888888
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: 1)
    }

    /// A colour that switches with the interface style.
    static func dynamic(_ dark: String, _ light: String) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
    }
}

enum Palette {
    static let bg = Color.dynamic("#08080A", "#F4F4F1")
    static let surface = Color.dynamic("#131316", "#FFFFFF")
    static let surface2 = Color.dynamic("#1B1B1F", "#ECECE8")
    static let surface3 = Color.dynamic("#26262B", "#E2E2DD")
    static let stroke = Color.dynamic("#FFFFFF", "#000000").opacity(0.07)
    static let text = Color.dynamic("#F2F2EE", "#141413")
    static let muted = Color.dynamic("#9A9A93", "#6B6A63")
    static let faint = Color.dynamic("#5E5E58", "#A3A198")
    static let accent = Color.dynamic("#9EC7FF", "#2F5FA8")
    static let accent2 = Color.dynamic("#B7A6FF", "#5B48C2")
    static let ok = Color.dynamic("#7FD4A0", "#2E7D4F")
    static let warn = Color.dynamic("#F0C674", "#946B12")
    static let err = Color.dynamic("#FF8A7A", "#B3402F")
    static let addBg = Color.dynamic("#7FD4A0", "#2E7D4F").opacity(0.12)
    static let delBg = Color.dynamic("#FF8A7A", "#B3402F").opacity(0.12)

    static let accentGradient = LinearGradient(colors: [accent, accent2], startPoint: .topLeading, endPoint: .bottomTrailing)
}

enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

// MARK: - Backdrop

/// The app canvas: deep black with a slow, soft aurora at the top, like a premium banking app.
struct Backdrop: View {
    var tint: Color = Palette.accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack(alignment: .top) {
            Palette.bg
            if scheme == .dark {
                TimelineView(.animation(minimumInterval: 1 / 20)) { tl in
                    let t = tl.date.timeIntervalSinceReferenceDate
                    MeshGradient(width: 3, height: 3, points: [
                        [0, 0], [0.5, 0], [1, 0],
                        [Float(0.15 + 0.08 * sin(t / 6)), 0.45], [Float(0.55 + 0.1 * cos(t / 7)), Float(0.4 + 0.08 * sin(t / 5))], [1, Float(0.5 + 0.06 * cos(t / 8))],
                        [0, 1], [0.5, 1], [1, 1],
                    ], colors: [
                        tint.opacity(0.30), Palette.accent2.opacity(0.22), tint.opacity(0.14),
                        Palette.accent2.opacity(0.10), tint.opacity(0.10), Palette.accent2.opacity(0.06),
                        .clear, .clear, .clear,
                    ])
                }
                .frame(height: 420)
                .blur(radius: 60)
                .opacity(0.9)
            } else {
                LinearGradient(colors: [tint.opacity(0.10), .clear], startPoint: .top, endPoint: .bottom).frame(height: 360)
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - Surfaces

struct CardStyle: ViewModifier {
    var padding: CGFloat = 18
    var radius: CGFloat = 24
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.stroke))
    }
}

extension View {
    func card(padding: CGFloat = 18, radius: CGFloat = 24) -> some View { modifier(CardStyle(padding: padding, radius: radius)) }

    /// Liquid Glass on iOS 26, an ultra-thin material before that.
    @ViewBuilder func glass(radius: CGFloat = 26, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if interactive {
                self.glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            } else {
                self.glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            }
        } else {
            self
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.stroke))
        }
    }

    @ViewBuilder func glassCapsule() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            self.background(.ultraThinMaterial, in: Capsule()).overlay(Capsule().strokeBorder(Palette.stroke))
        }
    }

    func sectionLabel() -> some View {
        self.font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted).textCase(.uppercase).tracking(0.6)
    }
}

// MARK: - Buttons

struct PrimaryButtonStyle: ButtonStyle {
    var tint: Color = Palette.text
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font((compact ? Font.subheadline : .body).weight(.semibold))
            .foregroundStyle(Palette.bg)
            .padding(.horizontal, compact ? 14 : 20)
            .frame(minHeight: compact ? 36 : 52)
            .background(tint, in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct TonalButtonStyle: ButtonStyle {
    var compact = false
    var destructive = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font((compact ? Font.subheadline : .body).weight(.semibold))
            .foregroundStyle(destructive ? Palette.err : Palette.text)
            .padding(.horizontal, compact ? 14 : 20)
            .frame(minHeight: compact ? 36 : 52)
            .background(destructive ? Palette.err.opacity(0.12) : Palette.surface3, in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
    static var primaryCompact: PrimaryButtonStyle { PrimaryButtonStyle(compact: true) }
}
extension ButtonStyle where Self == TonalButtonStyle {
    static var tonal: TonalButtonStyle { TonalButtonStyle() }
    static var tonalCompact: TonalButtonStyle { TonalButtonStyle(compact: true) }
    static var destructiveCompact: TonalButtonStyle { TonalButtonStyle(compact: true, destructive: true) }
}
extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}

// MARK: - Small pieces

struct StatusDot: View {
    var status: String?
    var color: Color?
    var pulse = false
    @State private var on = false

    var resolved: Color {
        if let color { return color }
        switch status {
        case "ok", "done", "ready": return Palette.ok
        case "error", "failed": return Palette.err
        case "running": return Palette.accent
        case "waiting": return Palette.warn
        default: return Palette.faint
        }
    }

    var body: some View {
        Circle()
            .fill(resolved)
            .frame(width: 8, height: 8)
            .background(Circle().fill(resolved.opacity(0.35)).scaleEffect(pulse && on ? 2.4 : 1).opacity(pulse && on ? 0 : 1))
            .onAppear {
                guard pulse else { return }
                withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { on = true }
            }
    }
}

struct Tag: View {
    var text: String
    var color: Color = Palette.muted
    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
    }
}

struct IconTile: View {
    var system: String
    var color: Color = Palette.accent
    var size: CGFloat = 40
    var body: some View {
        Image(systemName: system)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
    }
}

struct EmptyState: View {
    var icon: String
    var title: String
    var message: String
    var body: some View {
        VStack(spacing: 12) {
            IconTile(system: icon, color: Palette.muted, size: 56)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .padding(.horizontal, 24)
    }
}

/// A settings-style row: title, optional subtitle, trailing content.
struct SettingRow<Trailing: View>: View {
    var title: String
    var subtitle: String?
    var icon: String?
    var iconColor: Color = Palette.accent
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 14) {
            if let icon { IconTile(system: icon, color: iconColor, size: 34) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(Palette.text)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
    }
}

/// Groups rows into one rounded card with hairline dividers.
struct RowGroup<Content: View>: View {
    var title: String?
    var footer: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).sectionLabel().padding(.leading, 6) }
            VStack(spacing: 0) {
                Group(subviews: content()) { subs in
                    ForEach(Array(subs.enumerated()), id: \.offset) { i, s in
                        if i > 0 { Divider().overlay(Palette.stroke).padding(.leading, 16) }
                        s
                    }
                }
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.stroke))
            if let footer { Text(footer).font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 6) }
        }
    }
}

struct ErrorBanner: View {
    var text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.err)
            Text(text).font(.footnote).foregroundStyle(Palette.text)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Palette.err.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
