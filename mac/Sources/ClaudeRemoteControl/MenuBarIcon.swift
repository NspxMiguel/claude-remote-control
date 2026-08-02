import AppKit

enum MenuBarIcon {
    /// The project's `>_` mark, drawn rather than shipped as an asset so it can
    /// be a template image: the menu bar tints template art black or white to
    /// match the wallpaper behind it, which a coloured PNG cannot do.
    ///
    /// The geometry is `web/icons/icon.svg` without its badge, scaled to the
    /// 18pt box the menu bar gives a status item.
    static let prompt: NSImage = {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let stroke = NSBezierPath()
            stroke.lineWidth = 1.8
            stroke.lineCapStyle = .round
            stroke.lineJoinStyle = .round

            stroke.move(to: NSPoint(x: 2.6, y: 14.4))
            stroke.line(to: NSPoint(x: 8.0, y: 9.0))
            stroke.line(to: NSPoint(x: 2.6, y: 3.6))

            stroke.move(to: NSPoint(x: 9.8, y: 3.6))
            stroke.line(to: NSPoint(x: 15.4, y: 3.6))

            NSColor.black.setStroke()
            stroke.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }()
}
