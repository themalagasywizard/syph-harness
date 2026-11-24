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

#Preview {
    VStack(spacing: 30) {
        SyphMark(size: 80)
        LivingMark(size: 60)
    }
    .padding()
    .background(Palette.bg)
}
