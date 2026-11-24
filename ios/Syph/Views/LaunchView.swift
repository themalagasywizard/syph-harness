import SwiftUI

/// The launch screen: the Syph mark is born, a short cut of the "Genesis" brand film.
/// A signal dot beats and sends out sonar rings, drifting particles spiral into it, the mark grows out
/// of the seed inside its membrane, swims for a moment, then springs into its exact shape as the
/// wordmark arrives. It doubles as the loading page: the app connects to Syph underneath, and the
/// screen hands over once the animation has played and the first load is done (tap to skip).
struct LaunchView: View {
    /// Called once when the screen is ready to hand over.
    var onFinish: () -> Void
    /// True once the app has finished its first load (or has nothing to load).
    var ready: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var finished = false
    @State private var haptics = Set<Int>()

    /// When the mark has resolved and the wordmark is in.
    static let duration: Double = 3.7

    private static let ink = Color(hex: "#ECEBE6")
    private static let accent = (r: 169.0 / 255, g: 184.0 / 255, b: 204.0 / 255)
    private static let beats: [Double] = [0.25, 0.42, 0.95, 1.12]

    private struct Particle { var x, y, z, s, ph, d, b: Double }
    private static let particles: [Particle] = {
        var seed: UInt32 = 7
        func rnd() -> Double {
            // Mulberry32, as in the film, so every launch draws the same field.
            seed = seed &+ 0x6D2B79F5
            var t = seed
            t = (t ^ (t >> 15)) &* (1 | t)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4294967296
        }
        return (0..<160).map { _ in
            Particle(x: (rnd() - 0.5) * 2.2, y: (rnd() - 0.5) * 2.6, z: 0.35 + rnd() * 1.4, s: 0.6 + rnd() * 1.4, ph: rnd() * 100, d: rnd(), b: 0.3 + rnd() * 0.7)
        }
    }()

    var body: some View {
        ZStack {
            Color(hex: "#060606").ignoresSafeArea()
            if reduceMotion {
                still
            } else {
                TimelineView(.animation) { tl in
                    let t = tl.date.timeIntervalSince(start)
                    ZStack {
                        Canvas { ctx, size in draw(&ctx, size: size, t: t) }
                            .ignoresSafeArea()
                        wordmark(t)
                    }
                    .onChange(of: Int(t * 30)) { tick(t) }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { finish(force: true) }
        .onAppear { start = Date() }
        .onChange(of: ready) { _, r in if r, Date().timeIntervalSince(start) >= (reduceMotion ? 0.8 : Self.duration) { finish() } }
        .accessibilityElement()
        .accessibilityLabel("Syph is starting")
        .accessibilityAddTraits(.updatesFrequently)
        .task {
            if reduceMotion {
                try? await Task.sleep(nanoseconds: 800_000_000)
                if ready { finish() }
            }
        }
        .statusBarHidden(true)
    }

    // MARK: Frames

    private func tick(_ t: Double) {
        for (i, b) in Self.beats.enumerated() where t >= b && !haptics.contains(i) {
            haptics.insert(i)
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: i % 2 == 0 ? 0.7 : 0.4)
        }
        if t >= 2.75 && !haptics.contains(99) {
            haptics.insert(99)
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.6)
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

    private func heartbeat(_ t: Double) -> Double {
        var v = 0.0
        for b in Self.beats where t >= b { v = max(v, exp(-(t - b) * 7)) }
        return v
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, t: Double) {
        let c = CGPoint(x: size.width / 2, y: size.height * 0.44)
        let unit = min(size.width, size.height) / 2
        let hb = heartbeat(t)
        let (ar, ag, ab) = Self.accent
        let accent = Color(red: ar, green: ag, blue: ab)

        // Cool bloom behind the subject, lifting as the mark grows.
        let lift = 0.35 + 0.65 * Ease.sstep(0.9, 2.4, t)
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(
            Gradient(stops: [.init(color: Color(red: 40 / 255, green: 46 / 255, blue: 56 / 255).opacity(0.55 * lift), location: 0),
                             .init(color: Color(red: 20 / 255, green: 22 / 255, blue: 26 / 255).opacity(0.4 * lift), location: 0.5),
                             .init(color: .clear, location: 1)]),
            center: c, startRadius: 0, endRadius: unit * 1.9))

        // Particles drift, then spiral into the seed.
        let conv = Ease.seg(t, 0.15, 1.45)
        let pA = Ease.sstep(0, 0.3, t) * (1 - Ease.sstep(1.3, 1.7, t)) + 0.3 * Ease.sstep(2.2, 3.2, t)
        if pA > 0.01 {
            for p in Self.particles {
                var x = p.x + sin(t * 0.4 + p.ph) * 0.03
                var y = p.y + cos(t * 0.33 + p.ph * 1.3) * 0.03 - t * 0.01
                x /= p.z; y /= p.z
                var a = pA * p.b * (0.4 + 0.6 * (0.5 + 0.5 * sin(t * 3 + p.ph))) * Ease.clamp(1.4 - p.z * 0.5)
                if conv > 0 && t < 1.8 {
                    let k = Ease.eio(Ease.seg(conv, p.d * 0.45, p.d * 0.45 + 0.55))
                    let r = hypot(x, y) * (1 - k), an = atan2(y, x) + k * 2.6
                    x = r * cos(an); y = r * sin(an)
                    a *= (1 - Ease.sstep(0.85, 1, k)) * (1 + k * 1.5)
                }
                let sx = c.x + x * unit, sy = c.y + y * unit
                let rad = p.s / p.z * 1.2
                guard a > 0.01, sx > -10, sx < size.width + 10, sy > -10, sy < size.height + 10 else { continue }
                ctx.fill(Path(ellipseIn: CGRect(x: sx - rad, y: sy - rad, width: rad * 2, height: rad * 2)),
                         with: .color((p.z > 1 ? Color(red: 0.78, green: 0.82, blue: 0.88) : Self.ink).opacity(Ease.clamp(a))))
            }
        }

        // The signal: a beating dot and its sonar rings.
        let dotA = Ease.sstep(0.05, 0.3, t) * (1 - Ease.sstep(1.25, 1.6, t))
        if dotA > 0 {
            let r = Ease.lerp(3, 16, Ease.eio(Ease.seg(t, 0.4, 1.4))) * (1 + hb * 0.35)
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 2, y: c.y - r * 2, width: r * 4, height: r * 4)), with: .radialGradient(
                Gradient(stops: [.init(color: .white.opacity(dotA), location: 0), .init(color: Self.ink.opacity(dotA), location: 0.45),
                                 .init(color: Self.ink.opacity(dotA * 0.25), location: 0.5), .init(color: Self.ink.opacity(0), location: 1)]),
                center: c, startRadius: 0, endRadius: r * 2))
            for b in Self.beats {
                let d = t - b
                guard d >= 0, d < 1.6 else { continue }
                let rr = 8 + Ease.eout(d / 1.6) * unit * 0.95
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2)),
                           with: .color(accent.opacity((1 - d / 1.6) * 0.4 * dotA)), lineWidth: 1.2)
            }
        }

        // The mark: grows out of the seed, swims, then springs into shape.
        guard t >= 1.1 else { return }
        let G = Ease.seg(t, 1.2, 2.45)
        let swimIn = Ease.sstep(1.9, 2.4, t) * 0.9
        let resolve = Ease.spring(Ease.seg(t, 2.55, 3.55), 11, 4.5)
        let swim = max(0, swimIn * (1 - resolve))
        let alpha = Ease.sstep(1.1, 1.35, t)
        let markR = unit * 0.5
        let scale = markR / 104
        let rot = -0.25 * (1 - Ease.eio(Ease.seg(t, 1.2, 2.6)))
        let pose = MarkGeometry.Pose(grow: G, seed: 8.5, twist: 2.4, swim: swim, beat: hb * 0.6, t: t)
        let mark = MarkGeometry.path(pose).applying(
            CGAffineTransform(translationX: c.x, y: c.y).rotated(by: rot).scaledBy(x: scale, y: scale))

        // Membrane: a soft ring that grows with the bloom and fades as the mark resolves.
        let mr = Ease.lerp(markR * 0.25, markR * 1.32, Ease.eio(Ease.seg(t, 1.15, 2.4)))
        let mAlpha = Ease.sstep(1.0, 1.5, t) * (1 - Ease.sstep(3.0, 3.6, t)) * 0.85
        if mAlpha > 0.01 {
            var ring = Path()
            for j in 0...96 {
                let an = Double(j) / 96 * 2 * .pi
                let w = 1 + 0.012 * sin(5 * an + t * 0.9) + 0.008 * sin(7 * an - t * 1.3) + hb * 0.02
                let p = CGPoint(x: c.x + mr * w * cos(an), y: c.y + mr * w * sin(an))
                if j == 0 { ring.move(to: p) } else { ring.addLine(to: p) }
            }
            ring.closeSubpath()
            ctx.fill(ring, with: .color(.white.opacity(0.035 * mAlpha)))
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 8))
                l.stroke(ring, with: .color(accent.opacity(mAlpha * 0.6)), lineWidth: 3)
            }
            ctx.stroke(ring, with: .color(Color(red: ar + 0.12, green: ag + 0.12, blue: ab + 0.12).opacity(mAlpha)), lineWidth: 1.1)
        }

        // Bloom under the mark, then the mark itself with the film's ink gradient.
        let lock = Ease.sstep(2.55, 2.75, t) * (1 - Ease.sstep(2.9, 3.8, t))
        ctx.drawLayer { l in
            l.addFilter(.blur(radius: 18))
            l.opacity = alpha * (0.35 + 0.35 * lock + 0.3 * hb)
            l.fill(mark, with: .color(Self.ink), style: FillStyle(eoFill: true))
        }
        ctx.drawLayer { l in
            l.opacity = alpha
            l.fill(mark, with: .radialGradient(
                Gradient(stops: [.init(color: .white, location: 0), .init(color: Self.ink, location: 0.45),
                                 .init(color: Color(red: ar + 0.08, green: ag + 0.07, blue: ab + 0.05), location: 1)]),
                center: c, startRadius: 0, endRadius: markR * 1.02), style: FillStyle(eoFill: true))
        }

        // Energy pulses along the four spokes while it swims.
        let work = Ease.sstep(1.9, 2.2, t) * (1 - Ease.sstep(2.6, 3.0, t))
        if work > 0.01 {
            for s in 0..<4 {
                for j in 0..<3 {
                    let ph = (t * 0.9 + Double(j) / 3 + Double(s) * 0.17).truncatingRemainder(dividingBy: 1)
                    let q = MarkGeometry.deform(12 + ph * 76, Double(s) * .pi / 2, pose)
                    let pt = CGPoint(x: c.x + (q.x * cos(rot) - q.y * sin(rot)) * scale, y: c.y + (q.x * sin(rot) + q.y * cos(rot)) * scale)
                    let a = sin(ph * .pi) * work, rr = 5.0
                    ctx.fill(Path(ellipseIn: CGRect(x: pt.x - rr, y: pt.y - rr, width: rr * 2, height: rr * 2)),
                             with: .radialGradient(Gradient(colors: [.white.opacity(a), .white.opacity(0)]), center: pt, startRadius: 0, endRadius: rr))
                }
            }
        }

        // Nucleus glow.
        let nr = markR * 0.3
        ctx.fill(Path(ellipseIn: CGRect(x: c.x - nr, y: c.y - nr, width: nr * 2, height: nr * 2)), with: .radialGradient(
            Gradient(colors: [.white.opacity(alpha * (0.5 + hb * 0.3 + lock * 0.3)), .white.opacity(0)]), center: c, startRadius: 0, endRadius: nr))

        // Vignette.
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(
            Gradient(colors: [.clear, .black.opacity(0.6)]), center: CGPoint(x: size.width / 2, y: size.height / 2),
            startRadius: unit * 0.7, endRadius: unit * 2.1))
    }

    /// "syph", word by word like the film's captions: each letter rises out of a blur.
    private func wordmark(_ t: Double) -> some View {
        GeometryReader { geo in
            let unit = min(geo.size.width, geo.size.height) / 2
            VStack(spacing: 10) {
                HStack(spacing: 0) {
                    ForEach(Array("syph".enumerated()), id: \.offset) { i, ch in
                        let k = Ease.eout(Ease.seg(t, 2.75 + Double(i) * 0.08, 3.35 + Double(i) * 0.08))
                        Text(String(ch))
                            .opacity(k)
                            .blur(radius: (1 - k) * 8)
                            .offset(y: (1 - k) * 12)
                    }
                }
                .font(.system(size: 46, weight: .semibold, design: .rounded))
                .tracking(-1.2)
                .foregroundStyle(Self.ink)
                let k2 = Ease.eout(Ease.seg(t, 3.15, 3.8))
                Text("DIGITAL LIFE")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .tracking(2.4)
                    .foregroundStyle(Color(red: 0.78, green: 0.8, blue: 0.83).opacity(0.45 * k2))
            }
            .frame(maxWidth: .infinity)
            .position(x: geo.size.width / 2, y: geo.size.height * 0.44 + unit * 0.5 * 1.32 + 64)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Reduce Motion: the finished mark and wordmark, no movement.
    private var still: some View {
        VStack(spacing: 22) {
            SyphMark(size: 120, color: Self.ink)
            Text("syph").font(.system(size: 46, weight: .semibold, design: .rounded)).tracking(-1.2).foregroundStyle(Self.ink)
        }
    }
}

#Preview {
    LaunchView(onFinish: {}, ready: true)
}
