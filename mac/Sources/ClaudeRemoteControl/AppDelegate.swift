import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu bar only. Info.plist already says LSUIElement, but a `swift run`
        // build has no Info.plist and would otherwise take over the Dock.
        NSApp.setActivationPolicy(.accessory)

        AppSettings.shared.refreshLoginItemStatus()
        AppSettings.shared.applyAtLaunch()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Children outlive their parent on macOS: quitting has to take the
        // daemon and the sleep assertion with it, or the port stays held and
        // the Mac stays awake for a process nobody can see.
        DaemonController.shared.stopAndWait()
        CaffeinateService.shared.stop()
    }
}
