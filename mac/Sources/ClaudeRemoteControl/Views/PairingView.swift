import AppKit
import SwiftUI

/// The same pairing URL `crc pair` prints, as something a phone camera can read.
struct PairingView: View {
    let url: String?

    @State private var didCopy = false

    var body: some View {
        VStack(spacing: 10) {
            if let url, let image = QRCodeImage.make(from: url, side: 440) {
                Image(nsImage: image)
                    .interpolation(.none) // keep the modules square at any scale
                    .resizable()
                    .frame(width: 220, height: 220)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Text("Scan it, then Share ▸ Add to Home Screen.")
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
            } else {
                Text("No pairing token yet.")
                    .font(.system(size: 12, weight: .medium))
                Text("Start the daemon once — it writes the token to ~/.claude-remote-control/config.json.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: 260)
    }
}
