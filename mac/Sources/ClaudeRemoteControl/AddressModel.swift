import Darwin
import Foundation

struct ReachableURL: Identifiable, Equatable {
    enum Kind {
        case tailscale, lan, publicNet, local
    }

    let url: String
    let kind: Kind
    let label: String

    var id: String { url }
}

/// Every address the daemon can be reached on, plus the pairing URL a phone
/// scans.
///
/// This mirrors `src/net.js` in Swift rather than shelling out to `crc status`,
/// because the addresses are worth showing *before* the daemon is running —
/// and `crc status` prints a table for humans, not a payload for a client.
@MainActor
final class AddressModel: ObservableObject {
    static let shared = AddressModel()

    @Published private(set) var urls: [ReachableURL] = []
    @Published private(set) var pairingURL: String?

    private init() {}

    func refresh(port: Int, host: String) async {
        // A daemon bound to one address cannot answer on the others, and an
        // address that cannot answer is worse than no address at all — you only
        // find out standing in another room holding a phone.
        let boundToAll = ["0.0.0.0", "::", ""].contains(host)
        if !boundToAll {
            let loopback = ["127.0.0.1", "localhost", "::1"].contains(host)
            let bound = loopback
                ? [ReachableURL(url: "http://localhost:\(port)", kind: .local, label: "This machine only")]
                : [ReachableURL(url: "http://\(host):\(port)", kind: .lan, label: "Bound to \(host)")]
            urls = bound
            pairingURL = pairing(for: bound)
            return
        }

        let status = await Task.detached { Self.tailscaleStatus() }.value
        var found: [ReachableURL] = []

        if let status, status.running, let dnsName = status.dnsName {
            found.append(ReachableURL(
                url: "http://\(dnsName):\(port)",
                kind: .tailscale,
                label: "Tailscale — anywhere"
            ))
        }
        for address in Self.localAddresses() {
            if address.kind == .tailscale && status?.running == false { continue }
            let label: String
            switch address.kind {
            case .tailscale: label = "Tailscale IP — anywhere"
            case .lan: label = "LAN via \(address.interface)"
            default: label = "Public via \(address.interface)"
            }
            found.append(ReachableURL(url: "http://\(address.ip):\(port)", kind: address.kind, label: label))
        }
        found.append(ReachableURL(url: "http://localhost:\(port)", kind: .local, label: "This machine"))

        urls = found
        pairingURL = pairing(for: found)
    }

    /// Same shape `crc pair` prints: the phone reads the token out of the
    /// fragment, which never reaches a server log.
    private func pairing(for candidates: [ReachableURL]) -> String? {
        guard let token = DaemonConfig.load()?.token, let best = best(of: candidates) else { return nil }
        return "\(best.url)/#token=\(token)"
    }

    /// The address that works from the most places.
    func best(of candidates: [ReachableURL]? = nil) -> ReachableURL? {
        let list = candidates ?? urls
        return list.first { $0.kind == .tailscale }
            ?? list.first { $0.kind == .lan }
            ?? list.first
    }

    // MARK: - Interfaces

    private struct LocalAddress {
        let interface: String
        let ip: String
        let kind: ReachableURL.Kind
    }

    private static func localAddresses() -> [LocalAddress] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }

        var found: [LocalAddress] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(pointer.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = pointer.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            ) == 0 else { continue }

            let ip = String(cString: host)
            let name = String(cString: pointer.pointee.ifa_name)
            found.append(LocalAddress(interface: name, ip: ip, kind: kind(of: ip)))
        }

        // Tailscale first: it is the address worth scanning into a phone.
        let rank: [ReachableURL.Kind: Int] = [.tailscale: 0, .lan: 1, .publicNet: 2, .local: 3]
        return found.sorted { (rank[$0.kind] ?? 9) < (rank[$1.kind] ?? 9) }
    }

    private static func kind(of ip: String) -> ReachableURL.Kind {
        let octets = ip.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return .publicNet }
        // Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range.
        if octets[0] == 100, (64...127).contains(octets[1]) { return .tailscale }
        if octets[0] == 10 { return .lan }
        if octets[0] == 192, octets[1] == 168 { return .lan }
        if octets[0] == 172, (16...31).contains(octets[1]) { return .lan }
        return .publicNet
    }

    // MARK: - Tailscale

    /// Only the tailnet name matters here: whether Tailscale is healthy is the
    /// doctor's job to report, not this list's.
    private struct TailscaleStatus {
        let running: Bool
        let dnsName: String?
    }

    private struct TailscalePayload: Decodable {
        struct SelfNode: Decodable {
            let DNSName: String?
        }
        let BackendState: String?
        let Self_: SelfNode?

        enum CodingKeys: String, CodingKey {
            case BackendState
            case Self_ = "Self"
        }
    }

    /// Returns nil when Tailscale is not installed — the same "optional, not
    /// broken" verdict the doctor gives it.
    private nonisolated static func tailscaleStatus() -> TailscaleStatus? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
        let binary = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            .map { URL(fileURLWithPath: $0) } ?? NodeRuntime.locate("tailscale")
        guard let binary else { return nil }

        guard let capture = try? NodeRuntime.capture(binary, ["status", "--json"], timeout: 5),
              let data = capture.stdout.data(using: .utf8),
              let payload = try? JSONDecoder().decode(TailscalePayload.self, from: data)
        else { return nil }

        let dnsName = payload.Self_?.DNSName?.hasSuffix(".") == true
            ? String(payload.Self_!.DNSName!.dropLast())
            : payload.Self_?.DNSName

        return TailscaleStatus(
            running: payload.BackendState == "Running",
            dnsName: (dnsName?.isEmpty == false) ? dnsName : nil
        )
    }
}
