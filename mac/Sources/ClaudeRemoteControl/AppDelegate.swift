import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Dev-only: `ClaudeRemoteControl --check` prints what the app can see of
        // this machine and exits. A menu-bar app has nowhere to print, so when
        // it quietly does nothing this is how you find out which of the two
        // paths — Node or the bundled daemon — it failed to resolve.
        guard CommandLine.arguments.contains("--check") else { return }
        runSelfCheck()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu bar only. Info.plist already says LSUIElement, but a `swift run`
        // build has no Info.plist and would otherwise take over the Dock.
        NSApp.setActivationPolicy(.accessory)

        // Before anything that can be slow: an app whose icon shows up three
        // seconds late reads as an app that did not launch.
        StatusItemController.shared.install()

        AppSettings.shared.refreshLoginItemStatus()
        AppSettings.shared.applyAtLaunch()
    }

    /// Opening the app again when it is already running is what someone does
    /// when they cannot find its icon. Show them the panel.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        StatusItemController.shared.showPanelWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Children outlive their parent on macOS: quitting has to take the
        // daemon and the sleep assertion with it, or the port stays held and
        // the Mac stays awake for a process nobody can see.
        DaemonController.shared.stopAndWait()
        CaffeinateService.shared.stop()
    }

    private func runSelfCheck() {
        print("node     \(NodeRuntime.node?.path ?? "NOT FOUND")")
        print("daemon   \(NodeRuntime.payload?.path ?? "NOT FOUND")")
        print("config   \(DaemonConfig.path.path)")

        if let config = DaemonConfig.load() {
            print("listen   \(config.host):\(config.port)  token \(config.token == nil ? "missing" : "present")")
        } else {
            print("listen   no config yet — the daemon writes one on first start")
        }

        let report = DoctorModel.selfCheckReport()
        print("doctor   \(report.healthy ? "healthy" : "not ready")")
        for check in report.checks {
            print("  \(check.level.rawValue.padding(toLength: 4, withPad: " ", startingAt: 0)) \(check.label) — \(check.detail)")
        }
        exit(report.healthy ? 0 : 1)
    }
}
