// snap <in.html> <out.png>: renders the page's #win element with WebKit at 2x.
import AppKit
import WebKit
let args = CommandLine.arguments
let app = NSApplication.shared
class D: NSObject, WKNavigationDelegate {
  let out: String
  init(_ o: String) { out = o }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      w.evaluateJavaScript("(()=>{const r=document.getElementById('win').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()") { v, _ in
        let a = (v as! [NSNumber]).map { CGFloat($0.doubleValue) }
        let c = WKSnapshotConfiguration(); c.rect = CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
        w.takeSnapshot(with: c) { img, err in
          guard let img = img, let src = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("snapshot failed: \(String(describing: err))"); exit(1) }
          // Transparent outside the window's rounded corners.
          let b = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: src.width, pixelsHigh: src.height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
          NSGraphicsContext.saveGraphicsState()
          NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: b)
          let r = NSRect(x: 0, y: 0, width: src.width, height: src.height)
          let scale = CGFloat(src.width) / a[2]
          NSBezierPath(roundedRect: r, xRadius: 12 * scale, yRadius: 12 * scale).addClip()
          NSGraphicsContext.current!.cgContext.draw(src, in: r)
          NSGraphicsContext.restoreGraphicsState()
          let png = b.representation(using: .png, properties: [:])!
          try! png.write(to: URL(fileURLWithPath: self.out)); print("wrote \(self.out) \(Int(b.pixelsWide))x\(Int(b.pixelsHigh))"); exit(0)
        }
      }
    }
  }
}
let w = WKWebView(frame: NSRect(x: 0, y: 0, width: 1700, height: 1400))
w.setValue(false, forKey: "drawsBackground")
let win = NSWindow(contentRect: w.frame, styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = w; win.backingScaleFactor == 2 ? () : ()
let d = D(args[2]); w.navigationDelegate = d
let url = URL(fileURLWithPath: args[1])
w.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: "/"))
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("timeout"); exit(2) }
app.run()
