import Foundation

/// The daemon's own config file, read straight from disk.
///
/// Going through the CLI would mean parsing output meant for a human; the file
/// is the daemon's source of truth, it belongs to this user, and the app only
/// ever reads it.
struct DaemonConfig: Decodable {
    let port: Int
    let token: String?

    static let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude-remote-control/config.json")

    static let defaultPort = 8787

    static func load() -> DaemonConfig? {
        guard let data = try? Data(contentsOf: path) else { return nil }
        return try? JSONDecoder().decode(DaemonConfig.self, from: data)
    }

    enum CodingKeys: String, CodingKey {
        case port, token
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        port = try container.decodeIfPresent(Int.self, forKey: .port) ?? DaemonConfig.defaultPort
        token = try container.decodeIfPresent(String.self, forKey: .token)
    }
}
