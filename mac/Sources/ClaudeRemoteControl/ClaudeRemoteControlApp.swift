import SwiftUI

@main
struct ClaudeRemoteControlApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The menu bar item is an NSStatusItem installed by the delegate — see
        // StatusItemController for why it is not a MenuBarExtra any more. An
        // App still needs a Scene, and Settings is the one that opens nothing.
        Settings {
            EmptyView()
        }
    }
}
