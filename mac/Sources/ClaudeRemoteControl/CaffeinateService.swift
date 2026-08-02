import Foundation

/// Holds a sleep assertion for as long as the toggle is on, by keeping a
/// `caffeinate` child alive.
///
/// `-s` asserts only while the Mac is on AC power, which is the honest
/// behaviour for "keep it reachable at my desk": on battery the machine still
/// sleeps and the daemon still goes away, as it should.
final class CaffeinateService {
    static let shared = CaffeinateService()

    private var process: Process?
    private let executable = URL(fileURLWithPath: "/usr/bin/caffeinate")

    private init() {}

    var isActive: Bool { process?.isRunning ?? false }

    func setEnabled(_ enabled: Bool) {
        enabled ? start() : stop()
    }

    private func start() {
        guard process == nil else { return }

        let process = Process()
        process.executableURL = executable
        // -w ties the assertion to this app's lifetime, so even a crash cannot
        // leave the Mac awake forever with nothing to show for it.
        process.arguments = ["-s", "-w", String(ProcessInfo.processInfo.processIdentifier)]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] finished in
            // Compare identities: a quick off/on cycle must not let the dying
            // child clear the reference to the one that replaced it.
            let pid = finished.processIdentifier
            DispatchQueue.main.async {
                guard let self, self.process?.processIdentifier == pid else { return }
                self.process = nil
            }
        }

        do {
            try process.run()
            self.process = process
        } catch {
            self.process = nil
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }
}
