import Foundation

/// Starts, stops and watches `node bin/crc.js start`.
///
/// The daemon is the product; this app is a remote control for it. That means
/// a daemon someone started in a terminal has to be recognised rather than
/// fought with, so state comes from the health endpoint and not just from our
/// own child process.
@MainActor
final class DaemonController: ObservableObject {
    static let shared = DaemonController()

    enum Status: Equatable {
        case stopped
        case starting
        /// `managed` is false for a daemon this app did not spawn — someone's
        /// `npm start`, or a LaunchAgent.
        case running(version: String?, managed: Bool)
        case failed(String)
    }

    @Published private(set) var status: Status = .stopped
    @Published private(set) var startedAt: Date?
    @Published private(set) var lastMessage: String?
    @Published private(set) var port: Int = DaemonConfig.defaultPort

    private var child: Process?
    private var poller: Task<Void, Never>?

    private init() {
        port = DaemonConfig.load()?.port ?? DaemonConfig.defaultPort
    }

    var isRunning: Bool {
        if case .running = status { return true }
        return false
    }

    var isManaged: Bool {
        if case .running(_, let managed) = status { return managed }
        return false
    }

    var baseURL: URL? { URL(string: "http://localhost:\(port)") }

    func start() {
        guard !isRunning, child == nil else { return }

        port = DaemonConfig.load()?.port ?? DaemonConfig.defaultPort
        status = .starting
        lastMessage = nil

        guard let node = NodeRuntime.node else {
            status = .failed(NodeRuntime.RuntimeError.nodeMissing.localizedDescription)
            return
        }
        guard let script = NodeRuntime.crcScript, let payload = NodeRuntime.payload else {
            status = .failed(NodeRuntime.RuntimeError.payloadMissing.localizedDescription)
            return
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [script.path, "start"]
        process.currentDirectoryURL = payload
        process.environment = NodeRuntime.childEnvironment

        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        output.fileHandleForReading.readabilityHandler = { handle in
            let text = String(decoding: handle.availableData, as: UTF8.self)
            guard let line = Self.interestingLine(in: text) else { return }
            Task { @MainActor in self.lastMessage = line }
        }

        process.terminationHandler = { finished in
            let code = finished.terminationStatus
            let reason = finished.terminationReason
            output.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                self.child = nil
                self.startedAt = nil
                // 0 and SIGTERM both mean "we asked for this".
                if code == 0 || reason == .uncaughtSignal {
                    self.status = .stopped
                } else {
                    self.status = .failed(self.lastMessage ?? "The daemon exited unexpectedly.")
                }
            }
        }

        do {
            try process.run()
            child = process
            startedAt = Date()
            Task { await refresh() }
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func stop() {
        guard let child else {
            status = .stopped
            return
        }
        // SIGTERM: bin/crc.js traps it and closes sessions before exiting.
        child.terminate()
    }

    /// Blocking stop, for `applicationWillTerminate` — a child process outlives
    /// its parent on macOS, and an orphaned daemon would keep the port.
    func stopAndWait() {
        guard let child, child.isRunning else { return }
        child.terminate()
        let deadline = Date().addingTimeInterval(3)
        while child.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }

    func refresh() async {
        port = DaemonConfig.load()?.port ?? port
        let health = await Self.probeHealth(port: port)

        if let health {
            let managed = child?.isRunning ?? false
            status = .running(version: health, managed: managed)
            if managed, startedAt == nil { startedAt = Date() }
            if !managed { startedAt = nil }
            return
        }

        // A daemon that is still booting has not opened its port yet.
        if case .starting = status, child?.isRunning == true { return }
        if child?.isRunning == true { return }
        if case .failed = status { return }
        status = .stopped
        startedAt = nil
    }

    /// Polls while the panel is open so the status is never stale in front of
    /// the user, and stops when it closes so an idle app costs nothing.
    func beginWatching() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func endWatching() {
        poller?.cancel()
        poller = nil
    }

    private static func probeHealth(port: Int) async -> String? {
        struct Health: Decodable {
            let ok: Bool
            let version: String?
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let health = try? JSONDecoder().decode(Health.self, from: data),
              health.ok
        else { return nil }
        return health.version ?? ""
    }

    /// The daemon prints a QR code on startup; block-drawing rows are noise in
    /// a one-line status, so keep the last line that reads like prose.
    private static func interestingLine(in text: String) -> String? {
        text
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { line in
                !line.isEmpty && !line.unicodeScalars.contains { (0x2580...0x259F).contains(Int($0.value)) }
            }
    }
}
