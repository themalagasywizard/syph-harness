import SwiftUI

/// The Syph mark (a nucleus with four spokes and eight tendrils), drawn from the same outline as the desktop logo.
struct SyphMarkShape: Shape {
    private static let parsed: Path = {
        var p = Path()
        var nums: [CGFloat] = []
        var started = false
        func flush() {
            var i = 0
            while i + 1 < nums.count {
                let pt = CGPoint(x: nums[i], y: nums[i + 1])
                if !started { p.move(to: pt); started = true } else { p.addLine(to: pt) }
                i += 2
            }
            nums.removeAll()
        }
        var token = ""
        func endToken() {
            if let v = Double(token) { nums.append(CGFloat(v)) }
            token = ""
        }
        for ch in SyphLogo.path {
            switch ch {
            case "M":
                endToken(); flush(); started = false
            case "Z", "z":
                endToken(); flush(); p.closeSubpath(); started = false
            case " ", ",", "\n":
                endToken()
            case "-":
                endToken(); token = "-"
            default:
                token.append(ch)
            }
        }
        endToken(); flush()
        return p
    }()

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 208
        return Self.parsed.applying(CGAffineTransform(translationX: rect.midX, y: rect.midY).scaledBy(x: s, y: s))
    }
}

struct SyphMark: View {
    var size: CGFloat = 22
    var color: Color = Palette.text
    var body: some View {
        SyphMarkShape().fill(color, style: FillStyle(eoFill: true)).frame(width: size, height: size)
    }
}

/// The living-cell loader: the mark breathes and slowly turns while Syph works.
struct CellLoader: View {
    enum Mode { case loading, streaming, idle }
    var size: CGFloat = 30
    var mode: Mode = .loading

    var body: some View {
        TimelineView(.animation(paused: mode == .idle)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let speed = mode == .streaming ? 2.6 : 1.4
            ZStack {
                SyphMarkShape()
                    .fill(Palette.text, style: FillStyle(eoFill: true))
                    .blur(radius: 6)
                    .opacity(mode == .idle ? 0 : 0.25 + 0.15 * sin(t * speed))
                SyphMarkShape()
                    .fill(mode == .idle ? AnyShapeStyle(Palette.warn) : AnyShapeStyle(Palette.text), style: FillStyle(eoFill: true))
            }
            .scaleEffect(mode == .idle ? 1 : 0.92 + 0.08 * sin(t * speed))
            .rotationEffect(.degrees(mode == .idle ? 0 : t * (mode == .streaming ? 40 : 18)))
            .frame(width: size, height: size)
        }
    }
}

#Preview {
    VStack(spacing: 30) {
        SyphMark(size: 80)
        CellLoader(size: 60)
    }
    .padding()
    .background(Palette.bg)
}
