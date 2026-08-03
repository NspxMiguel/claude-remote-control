import Foundation
import ServiceManagement

@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard
    private let keepAwakeKey = "daemon.keepAwakeOnPower"
    private let startOnLaunchKey = "daemon.startOnLaunch"
    private let firstRunKey = "app.hasRunBefore"
    /**
     What you asked for, kept apart from what the system currently reports.

     Upgrading replaces the app bundle, and a replaced bundle can leave
     `SMAppService.mainApp.status` reading not-registered while the old
     registration is still sitting in the background-task database. Read
     only from the system, the switch silently flipped itself off every
     time this app updated.
     */
    private let wantsLoginKey = "app.wantsLaunchAtLogin"

    /// Set while reconciling with the system, so writing a value back does not
    /// re-enter the side effect that produced it.
    private var isSyncing = false

    @Published var launchAtLogin: Bool {
        didSet {
            guard !isSyncing else { return }
            defaults.set(launchAtLogin, forKey: wantsLoginKey)
            applyLoginItem()
        }
    }

    @Published var keepAwake: Bool {
        didSet {
            guard !isSyncing else { return }
            defaults.set(keepAwake, forKey: keepAwakeKey)
            CaffeinateService.shared.setEnabled(keepAwake)
        }
    }

    @Published var startDaemonOnLaunch: Bool {
        didSet {
            guard !isSyncing else { return }
            defaults.set(startDaemonOnLaunch, forKey: startOnLaunchKey)
        }
    }

    /// Registration can be refused (an unsigned build, a user who disabled it
    /// in System Settings) and silence would look like a broken toggle.
    @Published private(set) var loginItemError: String?

    /// True until the app has stored anything, i.e. the very first launch.
    private var isFirstRun: Bool { defaults.object(forKey: firstRunKey) == nil }

    private init() {
        launchAtLogin = defaults.object(forKey: wantsLoginKey) as? Bool
            ?? (SMAppService.mainApp.status == .enabled)
        keepAwake = defaults.bool(forKey: keepAwakeKey)
        // An app whose whole job is to be reachable from a phone is useless
        // sitting idle in the menu bar, so out of the box it starts the daemon
        // and comes back after a reboot. Both are switches in the panel.
        startDaemonOnLaunch = defaults.object(forKey: startOnLaunchKey) == nil
            ? true
            : defaults.bool(forKey: startOnLaunchKey)
    }

    /// Applies the persisted state at launch. Separate from `init` because the
    /// side effects need the app to be running, not merely constructed.
    func applyAtLaunch() {
        if isFirstRun {
            defaults.set(true, forKey: firstRunKey)
            defaults.set(startDaemonOnLaunch, forKey: startOnLaunchKey)
            if !launchAtLogin { launchAtLogin = true }
        }
        // Put it back if an upgrade dropped it. Only when you asked for it —
        // this re-asserts your choice, it does not make one for you.
        if launchAtLogin && SMAppService.mainApp.status != .enabled { applyLoginItem() }
        if keepAwake { CaffeinateService.shared.setEnabled(true) }
        if startDaemonOnLaunch { DaemonController.shared.start() }
    }

    /// The login item can be switched off in System Settings, behind our back.
    func refreshLoginItemStatus() {
        let enabled = SMAppService.mainApp.status == .enabled
        // Only downgrade the switch when you never expressed a wish, or when
        // the system agrees with the one you did. An upgrade that loses the
        // registration is repaired in applyAtLaunch, not reported as a
        // setting you turned off.
        if launchAtLogin && !enabled && defaults.object(forKey: wantsLoginKey) != nil { return }
        guard enabled != launchAtLogin else { return }
        isSyncing = true
        launchAtLogin = enabled
        isSyncing = false
    }

    private func applyLoginItem() {
        guard !isSyncing else { return }
        do {
            if launchAtLogin {
                // Registering something already registered throws; clearing
                // first makes this safe to re-run after an upgrade.
                try? SMAppService.mainApp.unregister()
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginItemError = nil
        } catch {
            loginItemError = error.localizedDescription
            isSyncing = true
            launchAtLogin.toggle()
            isSyncing = false
        }
    }
}
