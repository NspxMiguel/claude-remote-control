import AppKit
import SwiftUI

/**
 The `>_` in the menu bar, and the panel it opens.

 This was a SwiftUI `MenuBarExtra`, which on this macOS installs no status item
 at all: the app launches, registers as a UIElement, runs its daemon — and the
 menu bar stays empty. Verified by reducing the label to a plain `Text` and by
 dropping the activation-policy call; neither made it appear. So it is done in
 AppKit, which has drawn status items since long before SwiftUI and does not
 depend on the scene graph being alive.

 The panel itself is still the same SwiftUI view, in a popover — or in a
 plain window when the bar turns out to have no room for the icon at all.
 */
@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    static let shared = StatusItemController()

    /// Held for the lifetime of the app: releasing it removes the icon.
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    /// Closes the panel when you click anywhere else, the way a menu does.
    private var dismissMonitor: Any?
    /// True once the icon is known to be somewhere nobody can click.
    private var isUnreachable = false
    private var panelWindow: NSWindow?

    func install() {
        guard statusItem == nil else { return }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Named so macOS remembers the slot it was given. Without this the
        // item is anonymous and gets re-placed from scratch on every launch,
        // which on a full menu bar means a different bad spot each time.
        item.autosaveName = "crc.menubar"
        item.isVisible = true
        item.button?.image = MenuBarIcon.prompt
        item.button?.image?.isTemplate = true
        item.button?.toolTip = "Claude Remote Control"
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item

        warnIfHiddenByNotch(item)
    }

    /**
     A menu bar with no room left puts new items in the dead zone behind the
     notch, where they are drawn but can never be seen or clicked, and says
     nothing about it. Rather than let that read as "the app did not start",
     say so once, in the place someone will actually look.
     */
    private func warnIfHiddenByNotch(_ item: NSStatusItem) {
        Task { @MainActor in
            // The bar lays out on a later turn of the run loop; asking now
            // gives a zero-height window at the origin.
            try? await Task.sleep(for: .seconds(3))
            guard let frame = item.button?.window?.frame,
                  let screen = NSScreen.main,
                  screen.safeAreaInsets.top > 0,
                  let left = screen.auxiliaryTopLeftArea,
                  let right = screen.auxiliaryTopRightArea else { return }

            let visible = frame.maxX <= left.maxX || frame.minX >= right.minX
            guard !visible else { return }
            // The popover anchors to a button nobody can reach, so from here
            // on the panel opens as a window instead.
            isUnreachable = true
            NotchWarning.show()
        }
    }

    /**
     Show the panel without going through the menu bar.

     Used when the icon is stuck behind the notch, and whenever the app is
     reopened from Finder or the Dock — which is what someone does when they
     cannot find the icon.
     */
    func showPanelWindow() {
        if let window = panelWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 560),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        window.title = "Claude Remote Control"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(rootView: MenuPanelView())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panelWindow = window
    }

    @objc private func toggle() {
        if isUnreachable {
            showPanelWindow()
            return
        }
        if let popover, popover.isShown {
            close()
            return
        }
        open()
    }

    private func open() {
        guard let button = statusItem?.button else { return }

        let panel = NSPopover()
        panel.behavior = .transient
        panel.animates = true
        panel.delegate = self
        panel.contentViewController = NSHostingController(rootView: MenuPanelView())
        panel.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover = panel

        // `.transient` alone leaves the panel up when the click lands on
        // another app's window, which reads as a panel that will not close.
        dismissMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.close() }
        }

        // A popover from a status item opens behind the frontmost app unless
        // the app is brought forward first.
        NSApp.activate(ignoringOtherApps: true)
    }

    private func close() {
        popover?.performClose(nil)
        popover = nil
        if let monitor = dismissMonitor {
            NSEvent.removeMonitor(monitor)
            dismissMonitor = nil
        }
    }

    nonisolated func popoverDidClose(_ notification: Notification) {
        Task { @MainActor in
            if let monitor = self.dismissMonitor {
                NSEvent.removeMonitor(monitor)
                self.dismissMonitor = nil
            }
            self.popover = nil
        }
    }
}
