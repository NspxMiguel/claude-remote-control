// Writes Resources/AppIcon.icns from the same shapes as web/icons/icon.svg —
// dark squircle, ">_" glyph — drawn in code so it stays sharp at 1024px without
// pulling in an SVG renderer.
//
//   swift scripts/make_icon.swift Resources/AppIcon.icns
import AppKit
import Foundation

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Resources/AppIcon.icns"

/// icon.svg draws in a 512 viewBox; every number here is a fraction of that.
func renderPNG(size: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!

    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx

    let s = CGFloat(size) / 512.0
    let rect = CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))

    let badge = NSBezierPath(roundedRect: rect, xRadius: 114 * s, yRadius: 114 * s)
    NSColor(calibratedRed: 0.059, green: 0.059, blue: 0.063, alpha: 1).setFill()
    badge.fill()

    // The SVG's coordinates run downwards; NSBezierPath's origin is bottom-left.
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: x * s, y: (512 - y) * s)
    }

    let glyph = NSBezierPath()
    glyph.lineWidth = 38 * s
    glyph.lineCapStyle = .round
    glyph.lineJoinStyle = .round
    glyph.move(to: point(150, 154))
    glyph.line(to: point(254, 256))
    glyph.line(to: point(150, 358))
    glyph.move(to: point(286, 358))
    glyph.line(to: point(394, 358))

    NSColor(calibratedRed: 0.878, green: 0.522, blue: 0.373, alpha: 1).setStroke()
    glyph.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let iconset = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("ClaudeRemoteControl-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }

for size in [16, 32, 128, 256, 512] {
    try renderPNG(size: size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try renderPNG(size: size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}

let output = URL(fileURLWithPath: outputPath)
try? FileManager.default.createDirectory(
    at: output.deletingLastPathComponent(),
    withIntermediateDirectories: true
)

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { exit(iconutil.terminationStatus) }

print("wrote \(output.path)")
