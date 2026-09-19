import AppKit
import CoreText
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let fontURL = URL(fileURLWithPath: CommandLine.arguments[2])
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
func drawIcon(_ pixels: Int) -> Data {
    let image = NSImage(size: NSSize(width: pixels, height: pixels))
    image.lockFocus()
    let scale = CGFloat(pixels) / 1024
    let transform = NSAffineTransform(); transform.scale(by: scale); transform.concat()
    NSColor(calibratedRed: 0.80, green: 0.55, blue: 0.63, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 20, y: 20, width: 984, height: 984), xRadius: 210, yRadius: 210).fill()
    NSColor(calibratedWhite: 0.13, alpha: 1).setFill()
    for y in stride(from: 100, to: 930, by: 24) { for x in stride(from: 100, to: 930, by: 24) {
        if (x / 24 + y / 24) % 3 == 0 { NSRect(x: x, y: y, width: 7, height: 7).fill() }
    } }
    NSRect(x: 174, y: 226, width: 704, height: 564).fill()
    NSColor(calibratedWhite: 0.89, alpha: 1).setFill(); NSRect(x: 154, y: 246, width: 704, height: 564).fill()
    NSColor(calibratedWhite: 0.13, alpha: 1).setStroke()
    let border = NSBezierPath(rect: NSRect(x: 154, y: 246, width: 704, height: 564)); border.lineWidth = 12; border.stroke()
    NSColor(calibratedWhite: 0.13, alpha: 1).setFill(); NSRect(x: 166, y: 706, width: 680, height: 90).fill()
    let font = NSFont(name: "VT323", size: 380) ?? NSFont.monospacedSystemFont(ofSize: 300, weight: .bold)
    ("PI" as NSString).draw(at: NSPoint(x: 284, y: 298), withAttributes: [.font: font, .foregroundColor: NSColor(calibratedWhite: 0.13, alpha: 1)])
    NSColor(calibratedRed: 0.80, green: 0.55, blue: 0.63, alpha: 1).setFill()
    NSRect(x: 752, y: 728, width: 44, height: 44).fill()
    image.unlockFocus()
    let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try drawIcon(size).write(to: folder.appendingPathComponent("icon_\(size)x\(size).png"))
    try drawIcon(size * 2).write(to: folder.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
