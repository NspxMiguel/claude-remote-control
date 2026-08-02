import AppKit
import SwiftUI

/// Two ways to pair a phone: point its camera at the QR, or read six digits.
///
/// The code exists because the QR is useless the moment the camera cannot see
/// the screen — a phone across the room, a browser already open on the pairing
/// form asking for a code with no hint of where one comes from. That is the
/// thing people go looking for, so it is the thing shown largest.
struct PairingView: View {
    let url: String?

    @StateObject private var pairing = PairingCode()
    @State private var didCopy = false
    @State private var now = Date()

    /// Drives the countdown; a code is only good for ten minutes.
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 12) {
            if url == nil {
                notRunning
            } else {
                codeSection
                Divider()
                qrSection
            }
        }
        .padding(14)
        .frame(width: 280)
        .task { await pairing.request() }
        .onReceive(tick) { now = $0 }
    }

    // MARK: - The six digits

    private var codeSection: some View {
        VStack(spacing: 6) {
            Text("Pairing code")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)

            Text(pairing.display)
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .kerning(2)
                .foregroundStyle(pairing.isExpired ? Color.secondary : Color.primary)
                .textSelection(.enabled)

            if let error = pairing.error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else if pairing.isExpired {
                Button("Get a code") { Task { await pairing.request() } }
                    .controlSize(.small)
                    .disabled(pairing.isRequesting)
            } else {
                // `now` is read here so the countdown redraws every second.
                Text("Type it into the app on your phone · expires in \(countdown(at: now))")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func countdown(at: Date) -> String {
        let seconds = pairing.secondsLeft
        return seconds >= 60 ? "\(seconds / 60) min" : "\(seconds)s"
    }

    // MARK: - The QR

    @ViewBuilder
    private var qrSection: some View {
        if let url, let image = QRCodeImage.make(from: url, side: 440) {
            VStack(spacing: 8) {
                Image(nsImage: image)
                    .interpolation(.none) // keep the modules square at any scale
                    .resizable()
                    .frame(width: 168, height: 168)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Text("Or scan this — it pairs and opens in one step.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)

                Button(didCopy ? "Link copied" : "Copy link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                    didCopy = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        didCopy = false
                    }
                }
                .controlSize(.small)

                Text("This link carries your token. Anyone who scans it can run commands as you.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var notRunning: some View {
        VStack(spacing: 6) {
            Text("No pairing token yet.")
                .font(.system(size: 12, weight: .medium))
            Text("Start the daemon once — it writes the token to ~/.claude-remote-control/config.json.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
