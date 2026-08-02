import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

enum QRCodeImage {
    /// CoreImage renders the pairing QR in-process. Shelling out to the CLI's
    /// terminal renderer would give us block characters, not something a phone
    /// camera can read off a Retina display.
    static func make(from text: String, side: CGFloat) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        // The pairing URL is short and the code is read from a bright screen at
        // arm's length, so the lowest correction level keeps the modules large.
        filter.correctionLevel = "L"

        guard let output = filter.outputImage else { return nil }

        let scale = side / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let representation = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}
