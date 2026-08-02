import AppKit
import Foundation

/// What the app can actually do about a failing check.
///
/// Everything here is either a command the user watches run in their own
/// Terminal or a file revealed in Finder — nothing is installed or edited
/// behind their back, and the two checks that need an interactive login
/// (`claude`, `tailscale up`) genuinely cannot be done any other way.
enum DoctorFix {
    case terminal(command: String, button: String)
    case open(url: URL, button: String)
    case revealConfig(button: String)

    var buttonTitle: String {
        switch self {
        case .terminal(_, let button), .open(_, let button), .revealConfig(let button): return button
        }
    }

    static func action(for check: DoctorCheck) -> DoctorFix? {
        guard check.level != .ok else { return nil }

        switch check.label {
        case "Node.js":
            return hasHomebrew
                ? .terminal(command: "brew install node", button: "Install")
                : .open(url: URL(string: "https://nodejs.org/en/download")!, button: "Download")
        case "Claude Code":
            return .terminal(command: "npm install -g @anthropic-ai/claude-code", button: "Install")
        case "Credentials":
            // `claude` drops into its own prompt, where /login runs.
            return .terminal(command: "claude", button: "Sign in")
        case "Tailscale":
            return check.detail.contains("not installed")
                ? .open(url: URL(string: "https://tailscale.com/download")!, button: "Get it")
                : .terminal(command: "tailscale up", button: "Connect")
        case "Port", "Allowed roots":
            return .revealConfig(button: "Open config")
        default:
            return nil
        }
    }

    func perform() {
        switch self {
        case .terminal(let command, _):
            TerminalLauncher.run(command)
        case .open(let url, _):
            NSWorkspace.shared.open(url)
        case .revealConfig:
            let path = DaemonConfig.path
            if FileManager.default.fileExists(atPath: path.path) {
                NSWorkspace.shared.activateFileViewerSelecting([path])
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([path.deletingLastPathComponent()])
            }
        }
    }

    private static var hasHomebrew: Bool {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].contains {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }
}

enum TerminalLauncher {
    /// Hands the command to Terminal as a temporary `.command` file.
    ///
    /// Driving Terminal with AppleScript would ask for Automation access and
    /// run the command out of sight; opening a script shows the user exactly
    /// what is about to happen, in a window they own.
    static func run(_ command: String) {
        let script = """
        #!/bin/bash
        cd "$HOME"
        printf '\\n  Claude Remote Control is running:\\n\\n    %s\\n\\n' '\(command)'
        \(command)
        """

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("claude-remote-control-fix-\(UUID().uuidString.prefix(8)).command")
        do {
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch {
            NSSound.beep()
        }
    }
}
