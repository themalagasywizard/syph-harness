import SwiftUI

// The living Syph mark, drawn the same way as the desktop's <cell-loader> and the "Genesis" brand film:
// the outline is resampled into points around the nucleus and bent in polar space every frame, so the
// mark can grow out of a seed, swim while Syph works, beat on each streamed chunk and spring back into
// its exact shape when a reply ends.

/// Easing helpers, named after the film's (syph-brand-film/source/film.html).
enum Ease {
    static func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { max(a, min(b, x)) }
    static func lerp(_ a: Double, _ b: Double, _ k: Double) -> Double { a + (b - a) * k }
    static func seg(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    static func sstep(_ a: Double, _ b: Double, _ x: Double) -> Double { let k = seg(x, a, b); return k * k * (3 - 2 * k) }
    static func eio(_ k: Double) -> Double { k < 0.5 ? 4 * k * k * k : 1 - pow(-2 * k + 2, 3) / 2 }
    static func eout(_ k: Double) -> Double { 1 - pow(1 - k, 3) }
    /// Damped spring from 0 to 1.
    static func spring(_ k: Double, _ w: Double = 9, _ z: Double = 4.2) -> Double { k <= 0 ? 0 : 1 - exp(-z * k) * cos(w * k) }
}

/// The mark's outline as points in polar form (radius, angle), resampled so bends stay smooth.
enum MarkGeometry {
    struct Pt { var r: Double; var a: Double }

    static let subpaths: [[Pt]] = {
        var out: [[CGPoint]] = []
        var cur: [CGPoint]? = nil
        var nums: [Double] = []
        func flush() {
            var i = 0
            while i + 1 < nums.count { cur?.append(CGPoint(x: nums[i], y: nums[i + 1])); i += 2 }
            nums.removeAll()
        }
        var token = ""
        func endToken() { if let v = Double(token) { nums.append(v) }; token = "" }
        for ch in SyphLogo.path {
            switch ch {
            case "M":
                endToken(); flush()
                if let c = cur { out.append(c) }
                cur = []
            case "Z", "z":
                endToken(); flush()
                if let c = cur { out.append(c) }
                cur = nil
            case " ", ",", "\n": endToken()
            case "-": endToken(); token = "-"
            default: token.append(ch)
            }
        }
        endToken(); flush()
        if let c = cur, !c.isEmpty { out.append(c) }

        return out.map { p in
            var r: [Pt] = []
            for i in 0..<p.count {
                let a = p[i], b = p[(i + 1) % p.count]
                let len = hypot(b.x - a.x, b.y - a.y)
                let n = max(1, Int((len / 1.6).rounded(.up)))
                for j in 0..<n {
                    let k = Double(j) / Double(n)
                    let x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k
                    r.append(Pt(r: hypot(x, y), a: atan2(y, x)))
                }
            }
            return r
        }
    }()

    /// How the mark is bent at one moment.
    struct Pose {
        /// Growth 0…1: below 1 the limbs are pulled in towards a seed and twisted.
        var grow: Double = 1
        var seed: Double = 8.5
        var twist: Double = 2.4
        /// How much the tendrils sway.
        var swim: Double = 0
        /// A heartbeat on the outer limbs (one per streamed chunk).
        var beat: Double = 0
        /// Breathing scale (springs past 1 when settling).
        var breath: Double = 1
        var t: Double = 0
    }

    static func deform(_ r: Double, _ th: Double, _ P: Pose) -> CGPoint {
        var rr = r, a = th
        if P.grow < 1 {
            let g = Ease.eio(Ease.clamp(P.grow))
            let R = Ease.lerp(P.seed, 150, g)
            let soft = R * tanh(r / R)
            rr = Ease.lerp(soft, r, Ease.sstep(0.72, 1, P.grow))
            a += P.twist * (1 - g) * pow(r / 100, 1.15)
        }
        if P.swim > 0.0005 || P.beat > 0.0005 {
            let t = P.t, q = r / 100
            a += P.swim * (0.16 * sin(t * 2.1 - r * 0.045 + th * 2) + 0.06 * sin(t * 3.3 + r * 0.03 - th * 3)) * pow(q, 1.4)
            rr *= 1 + P.swim * (0.045 * sin(t * 1.7 + th * 4 - r * 0.02) + 0.03 * sin(t * 2.9 - th * 2))
            rr *= 1 + P.beat * 0.06 * pow(q, 0.6)
        }
        rr *= P.breath
        return CGPoint(x: rr * cos(a), y: rr * sin(a))
    }

    /// The bent outline in logo units (about ±104), centred on the origin.
    static func path(_ P: Pose) -> Path {
        var p = Path()
        for sp in subpaths {
            for (i, pt) in sp.enumerated() {
                let q = deform(pt.r, pt.a, P)
                if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
            }
            p.closeSubpath()
        }
        return p
    }
}

/// Drives one living mark: eases between states, and keeps the birth, pulse and settle clocks.
/// A plain class kept in @State: the Canvas advances it each frame without causing view updates.
final class LivingClock {
    var swim: Double = 0
    var energy: Double = 0.2
    var lastFrame: Double?
    var bornAt: Double?
    var pulseAt: Double = -10
    var settleAt: Double?

    struct Target { var swim: Double; var energy: Double }

    func advance(now: Double, target: Target, calm: Bool) -> (swim: Double, energy: Double, grow: Double, beat: Double, breath: Double, lock: Double) {
        let dt = min(0.05, max(0, now - (lastFrame ?? now)))
        lastFrame = now
        let k = 1 - exp(-dt * (settleAt != nil ? 4.5 : 2.6))
        swim += (target.swim * (calm ? 0.25 : 1) - swim) * k
        energy += (target.energy - energy) * k

        var grow = 1.0
        if let b = bornAt {
            let bt = now - b
            grow = Ease.eio(Ease.clamp((bt - 0.15) / 1.6))
            if bt > 1.9 { bornAt = nil }
        }
        let beat = calm ? 0 : exp(-(now - pulseAt) * 7)
        var breath = 1.0, lock = 0.0
        if let s = settleAt {
            let st = now - s
            // Springs past its shape once, then locks in with a brief glow, like the film's resolve.
            swim *= exp(-dt * 6)
            breath = 1 + (calm ? 0 : 0.06 * exp(-st * 4.2) * sin(st * 12))
            lock = exp(-st * 3.2) * (1 - exp(-st * 30))
            if st > 2 { settleAt = nil }
        }
        return (swim, energy, grow, beat, breath, lock)
    }
}

/// The Syph mark, alive. Grows on first appearance, swims while thinking and streaming, beats when
/// `beat` changes (pass the streamed text length) and springs back into the exact mark on `.idle`.
struct LivingMark: View {
    enum Mode: Equatable { case idle, loading, streaming }

    var size: CGFloat = 30
    var mode: Mode = .loading
    var beat: Int = 0
    var birth = true
    var color: Color = Palette.text
    /// A soft glow and nucleus light around the mark (off for small inline uses).
    var glow = true
    /// Appear mid-swim and spring back into the exact mark (for a reply that has just finished).
    var settle = false

    private static let overscan: CGFloat = 1.6
    @State private var clock = LivingClock()
    @State private var settling = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var target: LivingClock.Target {
        switch mode {
        case .idle: return .init(swim: 0, energy: 0.2)
        case .loading: return .init(swim: 0.8, energy: 0.7)
        case .streaming: return .init(swim: 0.6, energy: 1)
        }
    }

    private var animating: Bool { mode != .idle || settling }

    var body: some View {
        TimelineView(.animation(paused: !animating)) { tl in
            Canvas { ctx, sz in
                let now = tl.date.timeIntervalSinceReferenceDate
                let s = clock.advance(now: now, target: target, calm: reduceMotion)
                let pose = MarkGeometry.Pose(grow: s.grow, swim: s.swim, beat: s.beat, breath: s.breath, t: now)
                // The canvas is larger than the mark so the glow's blur fades out before the edge
                // (a blur clipped at the canvas bounds showed as a faint square).
                let scale = size / 208
                let mark = MarkGeometry.path(pose)
                    .applying(CGAffineTransform(translationX: sz.width / 2, y: sz.height / 2).scaledBy(x: scale, y: scale))

                if glow {
                    let g = 0.18 + 0.22 * s.energy + 0.35 * s.beat + 0.5 * s.lock
                    ctx.drawLayer { l in
                        l.addFilter(.blur(radius: max(2, size * 0.09)))
                        l.opacity = g
                        l.fill(mark, with: .color(color), style: FillStyle(eoFill: true))
                    }
                }
                ctx.fill(mark, with: .color(color), style: FillStyle(eoFill: true))
                if glow {
                    // Nucleus light: brighter while working and on each beat.
                    let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
                    let r = size * 0.16
                    let a = (0.15 + 0.35 * s.energy + 0.4 * s.beat) * s.grow
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                             with: .radialGradient(Gradient(colors: [.white.opacity(a), .white.opacity(0)]), center: c, startRadius: 0, endRadius: r))
                }
            }
        }
        .frame(width: size * Self.overscan, height: size * Self.overscan)
        .frame(width: size, height: size)
        .onAppear {
            if settle && !reduceMotion {
                clock.swim = 0.6
                clock.energy = 1
                clock.settleAt = Date().timeIntervalSinceReferenceDate
                settling = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.1) { if mode == .idle { settling = false } }
                return
            }
            guard birth && !reduceMotion else { return }
            clock.bornAt = Date().timeIntervalSinceReferenceDate
            settling = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { if mode == .idle { settling = false } }
        }
        .onChange(of: beat) { clock.pulseAt = Date().timeIntervalSinceReferenceDate }
        .onChange(of: mode) { old, new in
            guard new == .idle, old != .idle else { return }
            clock.settleAt = Date().timeIntervalSinceReferenceDate
            settling = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.1) { if mode == .idle { settling = false } }
        }
        .accessibilityLabel(mode == .idle ? "Syph" : mode == .loading ? "Thinking" : "Writing")
    }
}

/// The loader used across the app. Kept as a name so older call sites read the same.
struct CellLoader: View {
    typealias Mode = LivingMark.Mode
    var size: CGFloat = 30
    var mode: Mode = .loading
    var beat: Int = 0
    var body: some View { LivingMark(size: size, mode: mode, beat: beat, birth: false, glow: size >= 28) }
}

#Preview {
    VStack(spacing: 30) {
        LivingMark(size: 120, mode: .loading)
        LivingMark(size: 60, mode: .streaming)
        SyphMark(size: 60)
    }
    .padding()
    .background(Palette.bg)
}
