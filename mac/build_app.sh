#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="ClaudeRemoteControl"
BUILD_DIR=".build/release"
APP_BUNDLE="${APP_NAME}.app"
DAEMON_DIR=".."
VERSION="$(node -p "require('${DAEMON_DIR}/package.json').version")"

echo "==> Building (release)..."
swift build -c release

echo "==> Installing the daemon's dependencies..."
# The app runs the real daemon, so its three runtime deps have to travel with
# it. --omit=dev keeps the test tooling out of the bundle.
(cd "${DAEMON_DIR}" && npm install --omit=dev --no-audit --no-fund)

echo "==> Assembling ${APP_BUNDLE}..."
rm -rf "${APP_BUNDLE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources/crc"

cp "${BUILD_DIR}/${APP_NAME}" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"
cp "Resources/AppIcon.icns" "${APP_BUNDLE}/Contents/Resources/AppIcon.icns"

# `scripts` is not optional: the sign-in flow drives `claude setup-token`
# through scripts/oauth-login.exp, and closed-lid mode is granted by
# scripts/allow-lid-control.sh. Leaving it out breaks both, quietly.
for item in bin src web scripts node_modules package.json; do
  cp -R "${DAEMON_DIR}/${item}" "${APP_BUNDLE}/Contents/Resources/crc/${item}"
done

cat > "${APP_BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
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
    <string>${VERSION}</string>
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
PLIST

echo "==> Signing (ad-hoc)..."
xattr -cr "${APP_BUNDLE}"
codesign --force --deep -s - "${APP_BUNDLE}"

echo "==> Done: $(pwd)/${APP_BUNDLE}"
echo "Open it with: open ${APP_BUNDLE}"
