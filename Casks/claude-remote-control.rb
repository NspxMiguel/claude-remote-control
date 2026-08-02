cask "claude-remote-control" do
  version "0.1.4"
  sha256 "9586faaeb9894dbd50463a8849d770be2abc7891f702232d020e6e4b7ed3c9b9"

  # Downloads the SOURCE (not a prebuilt binary) and compiles it on the
  # installing machine. A local build means no quarantine attribute on the
  # result, so no Gatekeeper warning, and no paid Developer ID.
  url "https://github.com/NspxMiguel/claude-remote-control/archive/refs/tags/v#{version}.tar.gz"
  name "Claude Remote Control"
  desc "Menu-bar app for the daemon that drives Claude Code from your phone"
  homepage "https://github.com/NspxMiguel/claude-remote-control"

  depends_on macos: :sonoma
  # The app is a controller for the Node daemon: it bundles the daemon's
  # sources, but the runtime has to come from somewhere.
  depends_on formula: "node"

  # Nothing prebuilt to "install" — the postflight below checks for the Command
  # Line Tools, compiles, and puts the app in /Applications.
  stage_only true

  postflight do
    app_path = "#{appdir}/ClaudeRemoteControl.app"

    clt_installed = system_command("/usr/bin/xcode-select", args: ["-p"], print_stderr: false).success?

    if clt_installed
      ohai "Command Line Tools found. Compiling the app…"
    else
      ohai "Xcode Command Line Tools not found — downloading (needed to compile)…"
      system_command "/usr/bin/xcode-select", args: ["--install"]

      ohai "Waiting for the install to finish (click \"Install\" in the window that opened)…"
      waited = 0
      timeout = 30 * 60 # 30 min
      until system_command("/usr/bin/xcode-select", args: ["-p"], print_stderr: false).success?
        if waited >= timeout
          odie "Timed out waiting for the Command Line Tools. Run 'xcode-select --install', " \
               "let it finish, then run 'brew reinstall --cask claude-remote-control'."
        end
        sleep 10
        waited += 10
      end
      ohai "Command Line Tools installed. Compiling the app…"
    end

    source_dir = Dir.glob("#{staged_path}/claude-remote-control-*").first || staged_path.to_s
    mac_dir = "#{source_dir}/mac"

    swift_bin = system_command("/usr/bin/xcrun", args: ["-f", "swift"], print_stderr: false).stdout.strip
    swift_bin = "swift" if swift_bin.empty?

    system_command swift_bin, args: ["build", "-c", "release", "--disable-sandbox"], chdir: mac_dir

    # The app runs the real daemon rather than reimplementing it, so the
    # daemon's three runtime dependencies are installed into the bundle.
    ohai "Installing the daemon's dependencies…"
    npm_bin = "#{HOMEBREW_PREFIX}/bin/npm"
    # `npm` is a script that starts with `#!/usr/bin/env node`, and the PATH a
    # cask hands its children does not include Homebrew's bin — so it has to be
    # put back, or npm dies with "env: node: No such file or directory".
    system_command npm_bin,
                   args:  ["install", "--omit=dev", "--no-audit", "--no-fund"],
                   chdir: source_dir,
                   env:   { "PATH" => "#{HOMEBREW_PREFIX}/bin:/usr/bin:/bin:/usr/sbin:/sbin" }

    ohai "Assembling the app bundle…"
    FileUtils.rm_r(app_path) if File.exist?(app_path)
    FileUtils.mkdir_p("#{app_path}/Contents/MacOS")
    FileUtils.mkdir_p("#{app_path}/Contents/Resources/crc")
    FileUtils.cp("#{mac_dir}/.build/release/ClaudeRemoteControl", "#{app_path}/Contents/MacOS/ClaudeRemoteControl")
    FileUtils.cp("#{mac_dir}/Resources/AppIcon.icns", "#{app_path}/Contents/Resources/AppIcon.icns")
    # `scripts` carries the two helpers the app shells out to: oauth-login.exp
    # (signing an agent in from the phone) and allow-lid-control.sh.
    ["bin", "src", "web", "scripts", "node_modules", "package.json"].each do |item|
      FileUtils.cp_r("#{source_dir}/#{item}", "#{app_path}/Contents/Resources/crc/#{item}")
    end

    File.write("#{app_path}/Contents/Info.plist", <<~XML)
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
          <key>CFBundleExecutable</key>
          <string>ClaudeRemoteControl</string>
          <key>CFBundleIconFile</key>
          <string>AppIcon</string>
          <key>CFBundleIdentifier</key>
          <string>com.miguel.clauderemotecontrol</string>
          <key>CFBundleName</key>
          <string>Claude Remote Control</string>
          <key>CFBundleDisplayName</key>
          <string>Claude Remote Control</string>
          <key>CFBundlePackageType</key>
          <string>APPL</string>
          <key>CFBundleShortVersionString</key>
          <string>#{version}</string>
          <key>CFBundleVersion</key>
          <string>1</string>
          <key>LSMinimumSystemVersion</key>
          <string>14.0</string>
          <key>LSApplicationCategoryType</key>
          <string>public.app-category.developer-tools</string>
          <key>LSUIElement</key>
          <true/>
          <key>NSAppTransportSecurity</key>
          <dict>
              <key>NSAllowsLocalNetworking</key>
              <true/>
          </dict>
          <key>NSHighResolutionCapable</key>
          <true/>
      </dict>
      </plist>
    XML

    # Files copied out of the downloaded tarball (the .icns, the daemon's
    # sources) can carry the quarantine attribute even after being compiled and
    # copied — clear the whole bundle before signing so no part stays flagged.
    system_command "/usr/bin/xattr", args: ["-cr", app_path]
    system_command "/usr/bin/codesign", args: ["--force", "--deep", "-s", "-", app_path]

    ohai "Done. Claude Remote Control is in #{app_path} — open it and look for >_ in the menu bar."
  end

  # The daemon's own config (~/.claude-remote-control) is deliberately left
  # alone: it holds the master token and the paired devices, and it belongs to
  # the CLI, which may well still be in use.
  zap quit:  "com.miguel.clauderemotecontrol",
      trash: [
        "#{appdir}/ClaudeRemoteControl.app",
        "~/Library/Preferences/com.miguel.clauderemotecontrol.plist",
      ]
end
