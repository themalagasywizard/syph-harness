import SwiftUI

/// First launch: pair with Syph on your computer by QR code, or try the demo.
struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    @State private var scanning = false
    @State private var appeared = false

    var body: some View {
        ZStack {
            Backdrop()
            VStack(spacing: 0) {
                Spacer()
                LivingMark(size: 104, mode: .loading, birth: true)
                    .scaleEffect(appeared ? 1 : 0.6)
                    .opacity(appeared ? 1 : 0)
                Text("syph")
                    .font(.system(size: 52, weight: .semibold, design: .rounded))
                    .tracking(-1.5)
                    .padding(.top, 26)
                Text("Your agent harness,\nin your pocket.")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
                    .opacity(appeared ? 1 : 0)
                Spacer()

                VStack(alignment: .leading, spacing: 14) {
                    step(1, "Open Syph on your computer")
                    step(2, "Go to Settings → Phone → Show QR code")
                    step(3, "Scan it here")
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glass(radius: 24)
                .padding(.bottom, 20)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 16)

                VStack(spacing: 12) {
                    Button {
                        Haptic.tap()
                        scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)

                    Button {
                        Haptic.tap()
                        app.connect(.standalone)
                        app.open(.settings)
                    } label: {
                        Label("Use on this phone only", systemImage: "iphone").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.tonal)

                    Button {
                        Haptic.tap()
                        app.connect(.demo)
                    } label: {
                        Text("Explore the demo").font(.subheadline.weight(.semibold))
                    }
                    .padding(.top, 2)
                }
                Text("Paired, your keys and files stay on your computer. On the phone alone, bring your own key; chats sync once you pair.")
                    .font(.footnote)
                    .foregroundStyle(Palette.faint)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .fullScreenCover(isPresented: $scanning) { PairSheet() }
        .onAppear { withAnimation(.spring(response: 0.9, dampingFraction: 0.75).delay(0.1)) { appeared = true } }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(spacing: 12) {
            Text("\(n)")
                .font(.footnote.weight(.bold))
                .frame(width: 26, height: 26)
                .background(Palette.surface3, in: Circle())
            Text(text).font(.subheadline.weight(.medium))
        }
    }
}
