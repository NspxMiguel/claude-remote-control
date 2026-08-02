import Foundation
import ServiceManagement

@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard
    private let keepAwakeKey = "daemon.keepAwakeOnPower"
    private let startOnLaunchKey = "daemon.startOnLaunch"

    /// Set while reconciling with the system, so writing a value back does not
    /// re-enter the side effect that produced it.
    private var isSyncing = false

    @Published var launchAtLogin: Bool {
        didSet { applyLoginItem() }
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

    private init() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
        keepAwake = defaults.bool(forKey: keepAwakeKey)
        startDaemonOnLaunch = defaults.bool(forKey: startOnLaunchKey)
    }

    /// Applies the persisted state at launch. Separate from `init` because the
    /// side effects need the app to be running, not merely constructed.
    func applyAtLaunch() {
        if keepAwake { CaffeinateService.shared.setEnabled(true) }
        if startDaemonOnLaunch { DaemonController.shared.start() }
    }

    /// The login item can be switched off in System Settings, behind our back.
    func refreshLoginItemStatus() {
        let enabled = SMAppService.mainApp.status == .enabled
        guard enabled != launchAtLogin else { return }
        isSyncing = true
        launchAtLogin = enabled
        isSyncing = false
    }

    private func applyLoginItem() {
        guard !isSyncing else { return }
        do {
            if launchAtLogin {
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
