import Foundation

struct DoctorCheck: Decodable, Identifiable, Equatable {
    enum Level: String, Decodable {
        case ok, warn, bad
    }

    let level: Level
    let label: String
    let detail: String
    let fix: String?

    var id: String { label }
}

struct DoctorReport: Decodable, Equatable {
    let healthy: Bool
    let checks: [DoctorCheck]
}

/// Wraps `crc doctor --json`.
///
/// The checks live in `src/doctor.js` and nowhere else: duplicating them in
/// Swift would give the app and the CLI two different opinions about whether
/// this machine is ready.
@MainActor
final class DoctorModel: ObservableObject {
    static let shared = DoctorModel()

    @Published private(set) var report: DoctorReport?
    @Published private(set) var isChecking = false
    @Published private(set) var lastCheckedAt: Date?

    private init() {}

    var isHealthy: Bool { report?.healthy ?? false }

    var problems: [DoctorCheck] { report?.checks.filter { $0.level != .ok } ?? [] }

    func refresh() async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }

        report = await Task.detached { Self.run() }.value
        lastCheckedAt = Date()
    }

    /// The same round-trip the panel makes, callable before the UI exists.
    nonisolated static func selfCheckReport() -> DoctorReport { run() }

    private nonisolated static func run() -> DoctorReport {
        do {
            let capture = try NodeRuntime.runCRC(["doctor", "--json"])
            // `crc doctor` exits 1 when unhealthy, so the payload is what counts.
            guard let data = capture.stdout.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(DoctorReport.self, from: data)
            else {
                let detail = capture.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return failureReport(detail.isEmpty ? "crc doctor printed nothing usable." : detail)
            }
            return decoded
        } catch NodeRuntime.RuntimeError.nodeMissing {
            // The doctor cannot report on a machine that cannot run it, and a
            // missing runtime is the only finding that would matter anyway.
            return DoctorReport(healthy: false, checks: [
                DoctorCheck(
                    level: .bad,
                    label: "Node.js",
                    detail: "not found on this Mac",
                    fix: "Install it with `brew install node`, or from nodejs.org — version 20 or newer."
                ),
            ])
        } catch {
            return failureReport(error.localizedDescription)
        }
    }

    private nonisolated static func failureReport(_ detail: String) -> DoctorReport {
        DoctorReport(healthy: false, checks: [
            DoctorCheck(
                level: .bad,
                label: "Setup",
                detail: detail,
                fix: "Reinstall the app: brew reinstall --cask claude-remote-control"
            ),
        ])
    }
}
