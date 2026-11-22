import SwiftUI
import AVFoundation

/// Live camera that reports the first QR code it sees.
struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        return c
    }
    func updateUIViewController(_ vc: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            session.addInput(input)
            let out = AVCaptureMetadataOutput()
            guard session.canAddOutput(out) else { return }
            session.addOutput(out)
            out.setMetadataObjectsDelegate(self, queue: .main)
            out.metadataObjectTypes = [.qr]
            let p = AVCaptureVideoPreviewLayer(session: session)
            p.videoGravity = .resizeAspectFill
            view.layer.addSublayer(p)
            preview = p
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let s = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true
            onCode?(s)
            // Let the next scan through if this one is rejected.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.done = false }
        }
    }
}

/// Full-screen pairing: point the camera at the QR in Syph on your computer (Settings → Phone).
struct PairSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var busy = false
    @State private var error: String?
    @State private var manual = false
    @State private var pulse = false

    private var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if camera == .authorized && hasCamera {
                QRScannerView { code in handle(code) }.ignoresSafeArea()
                viewfinder
            } else {
                noCamera
            }

            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.white)
                            .frame(width: 40, height: 40).glassCapsule()
                    }
                }
                .padding(.horizontal, 20)
                Spacer()
                VStack(spacing: 14) {
                    if busy {
                        HStack(spacing: 10) { ProgressView().tint(.white); Text("Connecting to your computer…") }
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    } else if let error {
                        Text(error).font(.subheadline).foregroundStyle(.white).multilineTextAlignment(.center)
                    } else {
                        Text("Scan the QR code").font(.title3.weight(.semibold)).foregroundStyle(.white)
                        Text("In Syph on your computer, open **Settings → Phone** and click **Show QR code**. Both devices need to be on the same Wi-Fi.")
                            .font(.subheadline).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center)
                    }
                    Button("Enter code or address instead") { manual = true }
                        .font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.85))
                }
                .padding(20)
                .frame(maxWidth: .infinity)
                .glass(radius: 26)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $manual) { ManualConnectSheet { dismiss() } }
        .task {
            if camera == .notDetermined {
                let ok = await AVCaptureDevice.requestAccess(for: .video)
                camera = ok ? .authorized : .denied
            }
        }
    }

    private var viewfinder: some View {
        RoundedRectangle(cornerRadius: 34, style: .continuous)
            .strokeBorder(Palette.accentGradient, lineWidth: 4)
            .frame(width: 250, height: 250)
            .scaleEffect(pulse ? 1.03 : 0.97)
            .shadow(color: Palette.accent.opacity(0.6), radius: 18)
            .onAppear { withAnimation(.easeInOut(duration: 1.2).repeatForever()) { pulse = true } }
            .offset(y: -60)
    }

    private var noCamera: some View {
        VStack(spacing: 16) {
            IconTile(system: "camera.fill", color: Palette.muted, size: 64)
            Text(hasCamera ? "Camera access is off" : "No camera here").font(.title3.bold()).foregroundStyle(.white)
            Text(hasCamera ? "Allow camera access in Settings to scan the QR code, or enter the code instead." : "Enter the pairing link or the computer's address instead.")
                .font(.subheadline).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center)
            if hasCamera {
                Button("Open Settings") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }.buttonStyle(.tonalCompact)
            }
        }
        .padding(32)
        .offset(y: -80)
    }

    private func handle(_ code: String) {
        guard !busy else { return }
        busy = true
        error = nil
        Haptic.tap()
        Task {
            do {
                try await app.pair(link: code)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                Haptic.warning()
            }
            busy = false
        }
    }
}

/// Type a pairing link or an address (from the Simulator, 127.0.0.1:7337 works without pairing).
struct ManualConnectSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var connected: () -> Void
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("syph://pair?… or 192.168.1.20:7338", text: $text, axis: .vertical)
                        .lineLimit(1...4)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } footer: {
                    Text("Paste the pairing link from Settings → Phone on your computer. In the iOS Simulator you can also use http://127.0.0.1:7337.")
                }
                if let error { Section { Text(error).foregroundStyle(Palette.err) } }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Connecting…" : "Connect") { go() }
                        .fontWeight(.semibold)
                        .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { if text.isEmpty, UIPasteboard.general.hasStrings, let s = UIPasteboard.general.string, s.hasPrefix("syph://") { text = s } }
    }

    private func go() {
        busy = true
        error = nil
        Task {
            do {
                try await app.connectManually(text)
                dismiss()
                connected()
            } catch {
                self.error = error.localizedDescription
                Haptic.warning()
            }
            busy = false
        }
    }
}
