# The menu-bar app

A native macOS controller for the daemon. It does not reimplement it — it
starts `node bin/crc.js start`, reads `crc doctor --json`, and shows you the
addresses and the pairing QR code without you opening a terminal.

```
  >_  ← the menu bar

  ┌───────────────────────────────────────────┐
  │ Claude Remote Control                     │
  │ Running on port 8787 — up 2h 14m          │
  │ [Stop daemon]  [Open]                     │
  ├───────────────────────────────────────────┤
  │ Reachable at                              │
  │   http://mac.tail1234.ts.net:8787    Copy │
  │   http://192.168.1.20:8787           Copy │
  │   [Show pairing code]                     │
  ├───────────────────────────────────────────┤
  │ Setup                     needs attention │
  │   ✗ Credentials  not signed in  [Sign in] │
  ├───────────────────────────────────────────┤
  │ Launch at login                       off │
  │ Start the daemon when this app opens  off │
  │ Keep this Mac awake while plugged in   on │
  ├───────────────────────────────────────────┤
  │ Quit                               v0.1.0 │
  └───────────────────────────────────────────┘
```

| | |
|---|---|
| **Start and stop** | Spawns the daemon as a child process and shows its port and uptime. A daemon you started in a terminal is detected through `/api/health` and shown as running — the app just will not stop something it did not start. |
| **Setup** | `crc doctor --json`, rendered. Failing checks come with the button that fixes them: `brew install node`, `npm install -g @anthropic-ai/claude-code`, `claude` to sign in, `tailscale up`. Each one opens in your own Terminal window so you see what runs. |
| **Pairing** | The QR code is generated in-process with CoreImage from the same `#token=` URL `crc pair` prints. |
| **Keep this Mac awake while plugged in** | Holds a `caffeinate -s` child while the switch is on. `-s` only asserts on AC power, and `-w <our pid>` ties the assertion to the app, so a crash cannot leave your Mac awake forever. Replaces Amphetamine for this one job. |
| **Launch at login** | `SMAppService`, off by default. |

Quitting stops the daemon and the `caffeinate` child. Nothing survives the app
except a daemon you started yourself.

## Build it

```bash
swift build                                             # debug build, no bundle
swift run ClaudeRemoteControl --check                   # what the app can see: node, daemon sources, doctor
./build_app.sh                                          # release build → ClaudeRemoteControl.app
open ClaudeRemoteControl.app                            # >_ appears in the menu bar
```

`build_app.sh` compiles with `swift build -c release`, runs `npm install
--omit=dev` in the repository root, copies `bin/`, `src/`, `web/`,
`node_modules/` and `package.json` into `Contents/Resources/crc`, writes the
`Info.plist` and signs the bundle ad-hoc. The result is around 290 MB, almost
all of it the agent SDK.

Requires macOS 14 and the Xcode Command Line Tools. There is no `.xcodeproj` —
SwiftPM builds the executable and `build_app.sh` assembles the bundle around
it, the same shape as [mac-task-manager](https://github.com/NspxMiguel/mac-task-manager).

The app icon is generated, not checked in by hand:

```bash
swift scripts/make_icon.swift Resources/AppIcon.icns    # same shapes as web/icons/icon.svg
```

### Finding Node

A GUI app is launched by `launchd`, so its `PATH` is
`/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — Homebrew's `node` is
invisible to it. `NodeRuntime` probes `/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin` and the nvm
version directories, and hands children a widened `PATH` so the doctor's own
probes for `claude` and `tailscale` behave as they do in a terminal. If Node is
missing entirely, the Setup view says so with the command that fixes it.

## How the cask consumes this

`Casks/claude-remote-control.rb` in the repository root is the source of the
cask published to [NspxMiguel/tap](https://github.com/NspxMiguel/homebrew-tap).
It downloads the tagged source tarball, checks for the Command Line Tools
(installing them and waiting, if needed), then does what `build_app.sh` does
and installs the bundle into `/Applications`. Building on the installing
machine means no Gatekeeper warning and no paid Developer ID.

```bash
brew tap NspxMiguel/tap
brew install --cask claude-remote-control
```

Releasing a new version means: tag it, then update `version` and `sha256` in
the cask and copy it into the tap.

## Layout

```
Package.swift                     # SwiftPM, macOS 14, one executable target
build_app.sh                      # release build → signed .app
scripts/make_icon.swift           # draws Resources/AppIcon.icns
Sources/ClaudeRemoteControl/
├── ClaudeRemoteControlApp.swift  # @main, the MenuBarExtra scene
├── AppDelegate.swift             # launch, --check, cleanup on quit
├── NodeRuntime.swift             # finds node and the bundled daemon; runs both
├── DaemonConfig.swift            # reads ~/.claude-remote-control/config.json
├── DaemonController.swift        # start, stop, health, uptime
├── DoctorModel.swift             # crc doctor --json → typed checks
├── DoctorFix.swift               # what the app can do about a failing check
├── AddressModel.swift            # LAN + Tailscale discovery (mirrors src/net.js)
├── CaffeinateService.swift       # the sleep assertion
├── AppSettings.swift             # login item and switches
├── MenuBarIcon.swift             # the >_ mark, as a template image
├── QRCodeImage.swift             # CoreImage QR generation
└── Views/
    ├── MenuPanelView.swift       # the panel
    ├── SetupView.swift           # the doctor's checks
    └── PairingView.swift         # the QR popover
```
