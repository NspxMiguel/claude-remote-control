import SwiftUI

@main
struct ClaudeRemoteControlApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanelView()
        } label: {
            Image(nsImage: MenuBarIcon.prompt)
        }
        // .window rather than .menu: the panel holds a QR code, switches and a
        // list of checks, none of which fit in an NSMenu.
        .menuBarExtraStyle(.window)
    }
}
