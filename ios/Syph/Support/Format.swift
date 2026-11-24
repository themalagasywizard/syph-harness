import Foundation

/// Human-readable descriptions for the common 5-field cron shapes (port of ui/src/cron.ts).
enum Cron {
    private static let days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private static func pad(_ s: Substring) -> String { s.count < 2 ? "0" + s : String(s) }

    private static func dayText(_ dow: Substring) -> String {
        switch dow {
        case "*": return "every day"
        case "1-5": return "weekdays"
        case "0,6", "6,0": return "weekends"
        default: return dow.split(separator: ",").map { d in Int(d).map { days[$0 % 7] } ?? String(d) }.joined(separator: ", ")
        }
    }

    static func describe(_ expr: String) -> String {
        let f = expr.split(whereSeparator: \.isWhitespace)
        guard f.count == 5 else { return "Invalid: needs 5 fields (min hour day month weekday)" }
        let (min, hour, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4])
        let num = { (s: Substring) in !s.isEmpty && s.allSatisfy(\.isNumber) }
        if min.hasPrefix("*/") && hour == "*" && dom == "*" && mon == "*" && dow == "*" { return "Every \(min.dropFirst(2)) minutes" }
        if min == "*" && hour == "*" { return "Every minute" }
        if num(min) && hour == "*" && dom == "*" && dow == "*" { return min == "0" ? "Every hour" : "Every hour at :\(pad(min))" }
        if num(min) && num(hour) && dom == "*" && mon == "*" {
            let d = dayText(dow)
            return d.prefix(1).uppercased() + d.dropFirst() + " at \(pad(hour)):\(pad(min))"
        }
        if num(min) && num(hour) && num(dom) && mon == "*" { return "Day \(dom) of every month at \(pad(hour)):\(pad(min))" }
        return "Custom schedule"
    }

    static let presets: [(String, String)] = [
        ("Every 30 min", "*/30 * * * *"),
        ("Hourly", "0 * * * *"),
        ("Daily 8:00", "0 8 * * *"),
        ("Weekdays 8:00", "0 8 * * 1-5"),
        ("Sundays 18:00", "0 18 * * 0"),
    ]
}

enum Fmt {
    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return ISO8601DateFormatter.syph.date(from: iso) ?? ISO8601DateFormatter.plain.date(from: iso)
    }

    /// "just now", "5 min ago", "in 3 h", or a short date (port of relTime).
    static func rel(_ iso: String?) -> String {
        guard let d = date(iso) else { return "" }
        let diff = Date().timeIntervalSince(d)
        let fut = diff < 0
        let s = abs(diff)
        func f(_ n: Int, _ u: String) -> String { fut ? "in \(n) \(u)" : "\(n) \(u) ago" }
        if s < 60 { return fut ? "in under a minute" : "just now" }
        if s < 3600 { return f(Int((s / 60).rounded()), "min") }
        if s < 86400 { return f(Int((s / 3600).rounded()), "h") }
        return d.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// "320 ms", "4.2 s", "1 m 05 s".
    static func duration(_ s: TimeInterval) -> String {
        if s < 1 { return "\(max(1, Int((s * 1000).rounded()))) ms" }
        if s < 60 { return String(format: "%.1f s", s) }
        let m = Int(s) / 60, r = Int(s) % 60
        return m < 60 ? String(format: "%d m %02d s", m, r) : "\(m / 60) h \(m % 60) m"
    }

    static func pct(_ x: Double) -> String { "\(Int((x * 100).rounded()))%" }

    static func usd(_ n: Double?, digits: Int = 2) -> String {
        guard let n else { return "" }
        // Budgets are in USD on the server, so always show dollars, whatever the phone's region.
        return "$" + n.formatted(.number.locale(Locale(identifier: "en_US")).precision(.fractionLength(digits)))
    }

    /// Friendly model name, e.g. "openrouter:deepseek/deepseek-chat-v3.1" → "DeepSeek Chat V3.1".
    static func model(_ ref: String?) -> String {
        guard let ref, !ref.isEmpty else { return "" }
        let i = ref.firstIndex(of: ":")
        let provider = i.map { String(ref[..<$0]) } ?? "openrouter"
        let model = i.map { String(ref[ref.index(after: $0)...]) } ?? ref
        if provider == "minimax" {
            return model.replacingOccurrences(of: "MiniMax-", with: "MiniMax ").replacingOccurrences(of: "-", with: " ")
        }
        if provider == "gemini" {
            var m = model.replacingOccurrences(of: "models/", with: "")
            if m.hasPrefix("gemini-") { m = "Gemini " + m.dropFirst(7) }
            return m.replacingOccurrences(of: "-", with: " ").split(separator: " ").map { w in w.prefix(1).uppercased() + w.dropFirst() }.joined(separator: " ")
        }
        if provider != "openrouter" { return "\(model) · \(provider)" }
        var name = String(model.split(separator: "/").last ?? Substring(model))
        if name.hasPrefix("deepseek-") { name = "DeepSeek " + name.dropFirst(9) }
        name = name.replacingOccurrences(of: "-", with: " ")
        return name.split(separator: " ").map { w in w.prefix(1).uppercased() + w.dropFirst() }.joined(separator: " ")
    }

    static func providerLabel(_ p: String) -> String {
        switch p {
        case "openrouter": return "OpenRouter"
        case "minimax": return "MiniMax"
        case "gemini": return "Google Gemini"
        case "ollama": return "Local · Ollama"
        case "lmstudio": return "Local · LM Studio"
        default: return p
        }
    }

    /// When a usage window resets, from ms since 1970: "in 42m", "in 3h 5m", "Tue 9:00 AM".
    static func resetsIn(_ ms: Double) -> String {
        let s = max(0, Int(((ms / 1000) - Date().timeIntervalSince1970).rounded()))
        if s < 60 { return "in under a minute" }
        let m = s / 60
        if m < 60 { return "in \(m)m" }
        if m < 60 * 24 { return "in \(m / 60)h \(m % 60)m" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    static func greeting() -> String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
    }
}
