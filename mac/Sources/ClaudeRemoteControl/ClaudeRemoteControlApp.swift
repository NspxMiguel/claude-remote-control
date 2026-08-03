import SwiftUI

@main
struct ClaudeRemoteControlApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The menu bar item is an NSStatusItem installed by the delegate — see
        // StatusItemController for why it is not a MenuBarExtra any more.
        //
        // An App still needs a Scene, and Settings is the only one that opens
        // no window on launch. It holds the panel rather than an EmptyView: as
        // an empty scene it was still reachable — through ⌘, and the app menu —
        // and opened a large blank window titled "Settings", which is a worse
        // thing to ship than a duplicate route to the panel.
        Settings {
            MenuPanelView()
        }
    }
}
