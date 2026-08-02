import AppKit
import SwiftUI

struct MenuPanelView: View {
    @ObservedObject private var daemon = DaemonController.shared
    @ObservedObject private var addresses = AddressModel.shared
    @ObservedObject private var doctor = DoctorModel.shared
    @ObservedObject private var settings = AppSettings.shared

    @State private var isShowingPairing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            AddressSection(isShowingPairing: $isShowingPairing)
            Divider()
            SetupView()
            Divider()
            switches
            Divider()
            footer
        }
        .frame(width: 340)
        .task {
            daemon.beginWatching()
            settings.refreshLoginItemStatus()
            await addresses.refresh(port: daemon.port, host: daemon.host)
            if doctor.report == nil { await doctor.refresh() }
        }
        .onDisappear { daemon.endWatching() }
        .onChange(of: daemon.port) { _, _ in
            Task { await addresses.refresh(port: daemon.port, host: daemon.host) }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(level: statusLevel)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Claude Remote Control")
                        .font(.system(size: 13, weight: .semibold))
                    Text(statusLine)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if case .failed(let message) = daemon.status {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Button(daemon.isRunning ? "Stop daemon" : "Start daemon") {
                    daemon.isRunning ? daemon.stop() : daemon.start()
                }
                .disabled(daemon.isRunning && !daemon.isManaged)
                .help(daemon.isRunning && !daemon.isManaged
                      ? "This daemon was started outside the app — stop it where you started it."
                      : "")

                Button("Open") {
                    if let url = daemon.baseURL { NSWorkspace.shared.open(url) }
                }
                .disabled(!daemon.isRunning)

                Spacer()
            }
        }
        .padding(12)
    }

    private var statusLevel: StatusDot.Level {
        switch daemon.status {
        case .running: return .ok
        case .starting: return .pending
        case .failed: return .bad
        case .stopped: return .idle
        }
    }

    private var statusLine: String {
        switch daemon.status {
        case .stopped:
            return "Not running"
        case .starting:
            return "Starting on port \(daemon.port)…"
        case .failed:
            return "Stopped after an error"
        case .running(_, let managed):
            let port = "port \(daemon.port)"
            guard managed, let startedAt = daemon.startedAt else { return "Running on \(port) — started elsewhere" }
            return "Running on \(port) — \(Self.uptime(since: startedAt))"
        }
    }

    private static func uptime(since date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "up \(max(seconds, 0))s" }
        if seconds < 3600 { return "up \(seconds / 60)m" }
        let hours = seconds / 3600
        return "up \(hours)h \((seconds % 3600) / 60)m"
    }

    // MARK: - Switches

    private var switches: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Launch at login", isOn: $settings.launchAtLogin)
            Toggle("Start the daemon when this app opens", isOn: $settings.startDaemonOnLaunch)
            Toggle("Keep this Mac awake while plugged in", isOn: $settings.keepAwake)

            if let error = settings.loginItemError {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .font(.system(size: 12))
        .padding(12)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            Spacer()
            if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                Text("v\(version)")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct StatusDot: View {
    enum Level {
        case ok, pending, bad, idle
    }

    let level: Level

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
    }

    private var color: Color {
        switch level {
        case .ok: return .green
        case .pending: return .orange
        case .bad: return .red
        case .idle: return .secondary
        }
    }
}

private struct AddressSection: View {
    @ObservedObject private var addresses = AddressModel.shared
    @Binding var isShowingPairing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reachable at")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)

            if addresses.urls.isEmpty {
                Text("No network interfaces are up.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }

            ForEach(addresses.urls) { address in
                AddressRow(address: address)
            }

            Button("Show pairing code") { isShowingPairing = true }
                .controlSize(.small)
                .disabled(addresses.pairingURL == nil)
                .help(addresses.pairingURL == nil
                      ? "Start the daemon once to create a pairing token."
                      : "")
                .popover(isPresented: $isShowingPairing, arrowEdge: .trailing) {
                    PairingView(url: addresses.pairingURL)
                }
                .padding(.top, 2)
        }
        .padding(12)
    }
}

private struct AddressRow: View {
    let address: ReachableURL
    @State private var didCopy = false

    var body: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                Text(address.url)
                    .font(.system(size: 12, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(address.label)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button(didCopy ? "Copied" : "Copy") { copy() }
                .buttonStyle(.borderless)
                .font(.system(size: 11))
        }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address.url, forType: .string)
        didCopy = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            didCopy = false
        }
    }
}
