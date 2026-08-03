import AppKit

/**
 What to do when the menu bar has no room left.

 macOS lays status items out from the right, spills into the space left of the
 notch, and when both run out it puts the item *behind* the notch: drawn, never
 visible, never clickable, with nothing said about it. An app whose only
 interface is a menu bar icon then looks like an app that failed to launch.

 So it says so, once. Not on every launch — a message you cannot act on the
 fourth time is just noise.
 */
@MainActor
enum NotchWarning {
    private static let shownKey = "menubar.notchWarningShown"

    static func show() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: shownKey) else { return }
        defaults.set(true, forKey: shownKey)

        let alert = NSAlert()
        alert.messageText = "There is no room for the icon in your menu bar"
        alert.informativeText = """
            Claude Remote Control is running, but macOS put its ">_" icon behind \
            the notch, where it cannot be seen or clicked. That happens when the \
            menu bar is full.

            Make room by holding Command and dragging an icon you do not need off \
            the bar, then quit and reopen this app.

            Either way the daemon is running, and everything the panel does is \
            also in the terminal: crc status, crc pair, crc doctor.
            """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Copy “crc pair”")

        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("crc pair", forType: .string)
        }
    }
}
