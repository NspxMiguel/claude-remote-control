import Foundation

/// The six digits you type into a phone to pair it.
///
/// The QR carries the master token and is the fast path, but it only helps if
/// the phone's camera can see the screen — and the first thing anyone does is
/// stare at a field asking for a "pairing code" with no idea where to find one.
/// The daemon mints these; this asks it for one and counts it down.
@MainActor
final class PairingCode: ObservableObject {
    struct Live {
        let code: String
        let expiresAt: Date
    }

    @Published private(set) var live: Live?
    @Published private(set) var error: String?
    @Published private(set) var isRequesting = false

    /// Spaced for reading aloud across a room: 418 209, not 418209.
    var display: String {
        guard let code = live?.code, code.count == 6 else { return "——— ———" }
        let middle = code.index(code.startIndex, offsetBy: 3)
        return "\(code[code.startIndex..<middle]) \(code[middle...])"
    }

    var secondsLeft: Int {
        guard let live else { return 0 }
        return max(0, Int(live.expiresAt.timeIntervalSinceNow))
    }

    var isExpired: Bool { live == nil || secondsLeft <= 0 }

    /// Ask the running daemon for a fresh code.
    func request() async {
        guard !isRequesting else { return }
        isRequesting = true
        defer { isRequesting = false }

        guard let config = DaemonConfig.load(), let token = config.token else {
            error = "Start the daemon once, then a code can be made."
            return
        }

        // Always over loopback: the code is only useful while this Mac is
        // answering, and this is the one address that cannot be wrong.
        guard let url = URL(string: "http://127.0.0.1:\(config.port)/api/pair/code") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 6

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                error = "The daemon is not running, so it cannot make a code."
                live = nil
                return
            }
            struct Payload: Decodable {
                let code: String
                let expiresIn: Double
            }
            let payload = try JSONDecoder().decode(Payload.self, from: data)
            live = Live(code: payload.code, expiresAt: Date().addingTimeInterval(payload.expiresIn))
            error = nil
        } catch {
            self.error = "Could not reach the daemon on this Mac."
            live = nil
        }
    }
}
