import SwiftUI

/// Renders the Markdown Syph writes: headings, paragraphs, bullet and numbered lists,
/// quotes, fenced code (with copy) and inline styles.
struct MarkdownView: View {
    var text: String
    var size: CGFloat = 16

    enum Block: Hashable {
        case heading(Int, String)
        case paragraph(String)
        case bullet([String])
        case numbered([String])
        case quote(String)
        case code(String, String)
        case rule
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(Self.parse(text).enumerated()), id: \.offset) { _, b in
                block(b)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func block(_ b: Block) -> some View {
        switch b {
        case .heading(let level, let s):
            inline(s).font(.system(size: level == 1 ? size + 6 : level == 2 ? size + 3 : size + 1, weight: .bold))
                .padding(.top, 4)
        case .paragraph(let s):
            inline(s).font(.system(size: size)).lineSpacing(3)
        case .bullet(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Circle().fill(Palette.muted).frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + size * 0.28 }
                        inline(it).font(.system(size: size)).lineSpacing(3)
                    }
                }
            }
        case .numbered(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(i + 1).").font(.system(size: size, weight: .semibold).monospacedDigit()).foregroundStyle(Palette.muted)
                        inline(it).font(.system(size: size)).lineSpacing(3)
                    }
                }
            }
        case .quote(let s):
            HStack(spacing: 12) {
                Capsule().fill(Palette.accent.opacity(0.6)).frame(width: 3)
                inline(s).font(.system(size: size)).foregroundStyle(Palette.muted)
            }
        case .code(let lang, let code):
            CodeBlock(lang: lang, code: code)
        case .rule:
            Divider().overlay(Palette.stroke)
        }
    }

    private func inline(_ s: String) -> Text {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if var a = try? AttributedString(markdown: s, options: opts) {
            for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
                a[run.range].font = .system(size: size - 2, design: .monospaced)
                a[run.range].backgroundColor = Palette.surface3
            }
            for run in a.runs where run.link != nil {
                a[run.range].foregroundColor = Palette.accent
            }
            return Text(a).foregroundColor(Palette.text)
        }
        return Text(s).foregroundColor(Palette.text)
    }

    static func parse(_ text: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var bullets: [String] = []
        var nums: [String] = []
        var code: [String]? = nil
        var lang = ""

        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
            if !bullets.isEmpty { out.append(.bullet(bullets)); bullets = [] }
            if !nums.isEmpty { out.append(.numbered(nums)); nums = [] }
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if line.hasPrefix("```") { out.append(.code(lang, code!.joined(separator: "\n"))); code = nil }
                else { code!.append(raw) }
                continue
            }
            if line.hasPrefix("```") { flush(); lang = String(line.dropFirst(3)); code = []; continue }
            if line.isEmpty { flush(); continue }
            if line == "---" || line == "***" { flush(); out.append(.rule); continue }
            if let h = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[h] == " " {
                flush(); out.append(.heading(line.distance(from: line.startIndex, to: h), String(line[h...]).trimmingCharacters(in: .whitespaces))); continue
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                if !para.isEmpty || !nums.isEmpty { let b = bullets; bullets = []; flush(); bullets = b }
                bullets.append(String(line.dropFirst(2))); continue
            }
            if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty, line[line.index(after: dot)...].hasPrefix(" ") {
                if !para.isEmpty || !bullets.isEmpty { let n = nums; nums = []; flush(); nums = n }
                nums.append(String(line[line.index(dot, offsetBy: 2)...])); continue
            }
            if line.hasPrefix(">") { flush(); out.append(.quote(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))); continue }
            if !bullets.isEmpty || !nums.isEmpty { flush() }
            para.append(line)
        }
        if let code { out.append(.code(lang, code.joined(separator: "\n"))) }
        flush()
        return out
    }
}

struct CodeBlock: View {
    var lang: String
    var code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang.isEmpty ? "code" : lang).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    Haptic.success()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.muted)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Palette.surface3.opacity(0.6))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13.5, design: .monospaced))
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
                    .padding(14)
            }
        }
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
    }
}
