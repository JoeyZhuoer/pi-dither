import AppKit
import WebKit

// Standalone fixture host: no bundle launch, app data, provider, or Pi process.
final class Smoke: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let url: URL
    let width: Double
    var window: NSWindow!
    var web: WKWebView!
    var finished = false
    init(url: URL, width: Double) { self.url = url; self.width = width }
    func finish(_ ok: Bool, _ detail: String) {
        guard !finished else { return }; finished = true
        print("\(ok ? "PASS" : "FAIL"): isolated WKWebView \(Int(width))px — \(detail)")
        fflush(stdout)
        web?.stopLoading()
        exit(ok ? 0 : 1)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "fixtureResult")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 20, y: 20, width: width, height: 844), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Pi Dither — isolated component test"
        window.contentView = web
        window.orderBack(nil) // Do not activate or replace the user's running app.
        web.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.finish(false, "fixture deadline exceeded") }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1",
              let result = message.body as? [String: Any], let ok = result["ok"] as? Bool else {
            finish(false, "unexpected fixture response"); return
        }
        finish(ok, String((result["detail"] as? String ?? "no details").prefix(2000)))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url, target.scheme == url.scheme, target.host == url.host, target.port == url.port else {
            decisionHandler(.cancel); finish(false, "non-fixture navigation rejected"); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(false, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false, error.localizedDescription) }
}

guard CommandLine.arguments.count == 3, let url = URL(string: CommandLine.arguments[1]), url.scheme == "http", url.host == "127.0.0.1", let width = Double(CommandLine.arguments[2]), [390.0, 1440.0].contains(width) else { exit(2) }
let application = NSApplication.shared
let smoke = Smoke(url: url, width: width)
application.setActivationPolicy(.accessory)
application.delegate = smoke
application.run()
