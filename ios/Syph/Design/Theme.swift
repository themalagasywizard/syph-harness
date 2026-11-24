import SwiftUI

// Syph's iOS design language: near-black canvas, soft elevated cards, one cool accent,
// flat surfaces and the bundled Instrument Serif for titles, matching the desktop app.

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
    // The desktop's palette (ui/src/styles.css): restrained, near-monochrome, one cool accent, no gradients.
    static let bg = Color.dynamic("#0D0D0C", "#F8F7F3")
    static let surface = Color.dynamic("#151514", "#F0EFEA")
    static let surface2 = Color.dynamic("#1C1C1B", "#E8E7E1")
    static let surface3 = Color.dynamic("#262624", "#DEDCD5")
    static let stroke = Color.dynamic("#2A2A28", "#E0DED7")
    static let text = Color.dynamic("#ECEBE6", "#191917")
    static let muted = Color.dynamic("#98978F", "#6B6A63")
    static let faint = Color.dynamic("#5C5B56", "#A3A198")
    static let accent = Color.dynamic("#A9B8CC", "#3F5573")
    /// Kept for older call sites; the desktop has a single accent.
    static let accent2 = accent
    static let ok = Color.dynamic("#8FB59A", "#3E7A51")
    static let warn = Color.dynamic("#D3B673", "#93701F")
    static let err = Color.dynamic("#D68A7F", "#A64B3F")
    static let addBg = Color.dynamic("#8FB59A", "#3E7A51").opacity(0.10)
    static let delBg = Color.dynamic("#D68A7F", "#A64B3F").opacity(0.10)

    /// Flat, like the desktop. Kept as a gradient type so existing fills and strokes still compile.
    static let accentGradient = LinearGradient(colors: [accent, accent], startPoint: .top, endPoint: .bottom)
}

/// The desktop's display serif (Instrument Serif), bundled with the app.
extension Font {
    static func serif(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("InstrumentSerif-Regular", size: size, relativeTo: style)
    }
}

enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

// MARK: - Backdrop

/// The app canvas: the desktop's flat background. `tint` is kept for older call sites.
struct Backdrop: View {
    var tint: Color = Palette.accent
    var body: some View { Palette.bg.ignoresSafeArea() }
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

    /// A raised surface, flat like the desktop's composer and cards: the surface colour with a hairline border.
    /// (Named for the Liquid Glass it used to be; `interactive` is kept for older call sites.)
    func glass(radius: CGFloat = 26, interactive: Bool = false) -> some View {
        self
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.stroke))
    }

    func glassCapsule() -> some View {
        self.background(Palette.surface, in: Capsule()).overlay(Capsule().strokeBorder(Palette.stroke))
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
