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

        let outcome = await Task.detached { () -> Result<DoctorReport, Error> in
            do {
                let capture = try NodeRuntime.runCRC(["doctor", "--json"])
                guard let data = capture.stdout.data(using: .utf8),
                      let decoded = try? JSONDecoder().decode(DoctorReport.self, from: data)
                else {
                    let detail = capture.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    throw DoctorFailure.unreadable(detail.isEmpty ? "crc doctor printed nothing usable." : detail)
                }
                return .success(decoded)
            } catch {
                return .failure(error)
            }
        }.value

        switch outcome {
        case .success(let decoded):
            report = decoded
        case .failure(let error):
            report = Self.substituteReport(for: error)
        }
        lastCheckedAt = Date()
    }

    private enum DoctorFailure: LocalizedError {
        case unreadable(String)

        var errorDescription: String? {
            switch self {
            case .unreadable(let detail): return detail
            }
        }
    }

    /// The doctor cannot report on a machine that cannot run it, so stand in
    /// for it — the missing runtime is the only finding that matters anyway.
    private static func substituteReport(for error: Error) -> DoctorReport {
        if case NodeRuntime.RuntimeError.nodeMissing = error {
            return DoctorReport(healthy: false, checks: [
                DoctorCheck(
                    level: .bad,
                    label: "Node.js",
                    detail: "not found on this Mac",
                    fix: "Install it with `brew install node`, or from nodejs.org. Node 20 or newer."
                ),
            ])
        }
        return DoctorReport(healthy: false, checks: [
            DoctorCheck(
                level: .bad,
                label: "Setup",
                detail: error.localizedDescription,
                fix: "Reinstall the app: brew reinstall --cask claude-remote-control"
            ),
        ])
    }
}

extension DoctorCheck {
    init(level: Level, label: String, detail: String, fix: String?) {
        self.level = level
        self.label = label
        self.detail = detail
        self.fix = fix
    }
}
