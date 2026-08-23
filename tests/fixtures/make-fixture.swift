// Test fixture generator for picturereader macOS OCR tests (macOS only).
// Renders "Hello OCR 123 你好世界" in black on white and saves a PNG.
// Usage: make-fixture <out.png>
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let W = 900, H = 220
guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: make-fixture <out.png>\n".utf8)); exit(1)
}

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

let font = CTFontCreateWithName("PingFang SC" as CFString, 48, nil)
let attrs: [CFString: Any] = [
    kCTFontAttributeName: font,
    kCTForegroundColorAttributeName: CGColor(red: 0, green: 0, blue: 0, alpha: 1)
]
let attrString = CFAttributedStringCreate(nil, "Hello OCR 123 你好世界" as CFString, attrs as CFDictionary)!
let line = CTLineCreateWithAttributedString(attrString)
ctx.textPosition = CGPoint(x: 30, y: 80)
CTLineDraw(line, ctx)

let image = ctx.makeImage()!
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("fixture written: \(CommandLine.arguments[1])")
