import SwiftUI

/// The launch screen, like the desktop's new-chat logo: a small white dot appears in the middle of the
/// screen and grows into the Syph mark, swims for a moment, then springs into its exact shape.
/// Nothing else is on screen. It doubles as the loading page: the app connects to Syph underneath,
/// and the screen hands over once the mark has settled and the first load is done (tap to skip).
struct LaunchView: View {
    /// Called once when the screen is ready to hand over.
    var onFinish: () -> Void
    /// True once the app has finished its first load (or has nothing to load).
    var ready: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var finished = false
    @State private var haptics = Set<Int>()

    /// When the mark has settled into its exact shape.
    static let duration: Double = 2.8
    /// The mark's size on screen, close to the desktop's new-chat logo.
    private static let size: CGFloat = 72

    // Timings, in seconds from launch.
    private static let dotIn: (Double, Double) = (0.05, 0.5)    // the dot pops in
    private static let growth: (Double, Double) = (0.5, 2.0)    // the mark grows out of it
    private static let settleAt: Double = 2.0                   // and springs into shape

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            if reduceMotion {
                SyphMark(size: Self.size)
            } else {
                TimelineView(.animation) { tl in
                    let t = tl.date.timeIntervalSince(start)
                    Canvas { ctx, size in draw(&ctx, size: size, t: t) }
                        .frame(width: Self.size * 2, height: Self.size * 2)
                        .onChange(of: Int(t * 30)) { tick(t) }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { finish(force: true) }
        .onAppear { start = Date() }
        .onChange(of: ready) { _, r in if r, Date().timeIntervalSince(start) >= (reduceMotion ? 0.6 : Self.duration) { finish() } }
        .accessibilityElement()
        .accessibilityLabel("Syph is starting")
        .accessibilityAddTraits(.updatesFrequently)
        .task {
            if reduceMotion {
                try? await Task.sleep(nanoseconds: 600_000_000)
                if ready { finish() }
            }
        }
        .statusBarHidden(true)
    }

    private func tick(_ t: Double) {
        if t >= 0.12 && !haptics.contains(0) {
            haptics.insert(0)
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6)
        }
        if t >= Self.settleAt && !haptics.contains(1) {
            haptics.insert(1)
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.5)
        }
        if t >= Self.duration && ready { finish() }
        // Don't hold the app behind the animation while a slow network makes up its mind.
        if t >= Self.duration + 2.5 { finish(force: true) }
    }

    private func finish(force: Bool = false) {
        guard !finished, ready || force else { return }
        finished = true
        onFinish()
    }

    // MARK: Frame

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, t: Double) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let unit: Double = Double(Self.size) / 208          // points per logo unit
        let ink = Palette.text

        // The dot: pops in with a small spring, then hands over to the growing mark.
        let dotR: Double = 4.5 * Ease.spring(Ease.seg(t, Self.dotIn.0, Self.dotIn.1))
        let dotA: Double = 1 - Ease.sstep(0.55, 0.95, t)

        // The mark: grows out of the dot, swims a little, then springs into its exact shape.
        let markA: Double = Ease.sstep(0.45, 0.7, t)
        let grow: Double = Ease.seg(t, Self.growth.0, Self.growth.1)
        let swim: Double = 0.55 * Ease.sstep(0.6, 1.2, t) * (1 - Ease.sstep(1.9, 2.5, t))
        let st: Double = t - Self.settleAt
        let breath: Double = st > 0 ? 1 + 0.06 * exp(-st * 4.2) * sin(st * 12) : 1
        let lock: Double = st > 0 ? exp(-st * 3.2) * (1 - exp(-st * 30)) : 0

        if markA > 0.001 {
            let seed: Double = max(2, dotR / unit)
            let pose = MarkGeometry.Pose(grow: grow, seed: seed, twist: 1.6, swim: swim, beat: 0, breath: breath, t: t)
            let mark = MarkGeometry.path(pose)
                .applying(CGAffineTransform(translationX: c.x, y: c.y).scaledBy(x: unit, y: unit))
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: Self.size * 0.09))
                l.opacity = (0.22 + 0.45 * lock) * markA
                l.fill(mark, with: .color(ink), style: FillStyle(eoFill: true))
            }
            var m = ctx
            m.opacity = markA
            m.fill(mark, with: .color(ink), style: FillStyle(eoFill: true))
        }

        if dotA > 0.001 && dotR > 0.01 {
            let dot = Path(ellipseIn: CGRect(x: c.x - dotR, y: c.y - dotR, width: dotR * 2, height: dotR * 2))
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 6))
                l.opacity = 0.35 * dotA
                l.fill(dot, with: .color(ink))
            }
            var d = ctx
            d.opacity = dotA
            d.fill(dot, with: .color(ink))
        }
    }
}

#Preview {
    LaunchView(onFinish: {}, ready: true)
}
