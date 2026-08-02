import Foundation

/// Locates the Node runtime and the daemon's own sources, and runs them.
///
/// A GUI app is launched by `launchd`, not by a login shell, so it inherits
/// `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — Homebrew's `node`, npm's
/// global `claude` and `tailscale` are all invisible unless we go looking for
/// them and hand the child an augmented PATH.
enum NodeRuntime {
    struct Capture {
        let stdout: String
        let stderr: String
        let status: Int32
    }

    enum RuntimeError: LocalizedError {
        case nodeMissing
        case payloadMissing

        var errorDescription: String? {
            switch self {
            case .nodeMissing: return "Node.js was not found on this Mac."
            case .payloadMissing: return "The bundled daemon sources are missing from this app."
            }
        }
    }

    /// Directories worth searching, best guess first. Order matters: a Homebrew
    /// Node should win over an ancient `/usr/local/bin` leftover.
    static var searchPaths: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var paths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.volta/bin",
            "\(home)/.bun/bin",
        ]
        paths.append(contentsOf: nvmVersionPaths())
        paths.append(contentsOf: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])

        // Whatever the process did inherit still goes last: it is rarely useful
        // under launchd, but it is what a developer running from a terminal has.
        let inherited = ProcessInfo.processInfo.environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        paths.append(contentsOf: inherited)

        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }

    /// nvm installs live under a version directory, so probe them newest first.
    private static func nvmVersionPaths() -> [String] {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node")
        guard let versions = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        return versions
            .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            .map { root.appendingPathComponent($0).appendingPathComponent("bin").path }
    }

    static func locate(_ executable: String) -> URL? {
        for directory in searchPaths {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent(executable)
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    static var node: URL? { locate("node") }

    /// The environment children get: our own, with PATH widened so the doctor's
    /// probes for `claude`, `security` and `tailscale` behave as they do in a
    /// terminal.
    static var childEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = searchPaths.joined(separator: ":")
        return environment
    }

    /// Directory holding `bin/crc.js` — inside the app bundle once installed,
    /// and the repository itself when running from `swift run`.
    static var payload: URL? {
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("crc")
            if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("bin/crc.js").path) {
                return bundled
            }
        }
        if let override = ProcessInfo.processInfo.environment["CRC_SOURCE_DIR"] {
            let directory = URL(fileURLWithPath: override)
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("bin/crc.js").path) {
                return directory
            }
        }
        // .build/release/ClaudeRemoteControl → up to the repository root.
        var directory = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<6 {
            guard let current = directory else { break }
            if FileManager.default.fileExists(atPath: current.appendingPathComponent("bin/crc.js").path) {
                return current
            }
            directory = current.deletingLastPathComponent()
        }
        return nil
    }

    static var crcScript: URL? { payload?.appendingPathComponent("bin/crc.js") }

    /// Runs `crc <arguments>` to completion and returns what it printed.
    /// The exit status is handed back rather than thrown on: `crc doctor`
    /// exits non-zero precisely when its output is most worth reading.
    static func runCRC(_ arguments: [String], timeout: TimeInterval = 45) throws -> Capture {
        guard let node else { throw RuntimeError.nodeMissing }
        guard let crcScript, let payload else { throw RuntimeError.payloadMissing }
        return try capture(node, [crcScript.path] + arguments, workingDirectory: payload, timeout: timeout)
    }

    static func capture(
        _ executable: URL,
        _ arguments: [String],
        workingDirectory: URL? = nil,
        timeout: TimeInterval = 45
    ) throws -> Capture {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = childEnvironment
        if let workingDirectory { process.currentDirectoryURL = workingDirectory }

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        try process.run()

        // A wedged probe must not wedge the UI behind it.
        let watchdog = DispatchWorkItem { [weak process] in
            guard let process, process.isRunning else { return }
            process.terminate()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)

        // Both pipes are drained concurrently: a child that fills the 64 KB
        // buffer of the pipe we are not reading blocks forever.
        var errData = Data()
        let errDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            errDone.signal()
        }
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        errDone.wait()
        process.waitUntilExit()
        watchdog.cancel()

        return Capture(
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self),
            status: process.terminationStatus
        )
    }
}
