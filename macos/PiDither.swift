import AppKit
import WebKit

// The web UI is local content inside a native application, not a browser launch.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var process: Process?
    var input: Pipe?
    var output: Pipe?
    var errors: Pipe?
    var buffer = Data()
    var localURL: URL?
    var waitingToQuit = false
    var terminationPending = false
    var shuttingDown = false
    var startupTimer: Timer?
    var quitTimer: Timer?
    var smokeTimer: Timer?
    var dataDirectory: URL!
    let smoke = ProcessInfo.processInfo.arguments.contains("--smoke-test")
    var smokePassed = false
    var smokeFailure = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        let config = WKWebViewConfiguration()
        // Fixed local origin + normal store keep layout/motion preferences. Test
        // instances use an ephemeral web store as well as an isolated Pi profile.
        if smoke {
            config.websiteDataStore = .nonPersistent()
            config.userContentController.addUserScript(WKUserScript(source: "window.nativeSmokeErrors=[];addEventListener('error',e=>nativeSmokeErrors.push(String(e.message).slice(0,300)))", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pi Dither"
        window.minSize = NSSize(width: 800, height: 600)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        if !smoke {
            if !window.setFrameUsingName("PiDitherMain") { window.center() }
            window.setFrameAutosaveName("PiDitherMain")
        } else { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showLoading()
        startService()
    }

    func configureMenu() {
        let bar = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Pi Dither", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Pi Dither", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Pi Dither", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; bar.addItem(appItem)
        let editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; bar.addItem(editItem)
        let viewItem = NSMenuItem(), view = NSMenu(title: "View")
        view.addItem(withTitle: "Show Main Window", action: #selector(showWindow), keyEquivalent: "1")
        view.addItem(withTitle: "Reload Interface", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Open App Data Folder", action: #selector(openData), keyEquivalent: "")
        viewItem.submenu = view; bar.addItem(viewItem)
        NSApp.mainMenu = bar
    }
    @objc func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Pi Dither", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", .credits: NSAttributedString(string: "A dithered workspace for core Pi.\nCore Pi and pi-subagents retain their own execution policies.\nLocal build: ad-hoc signed, not notarized.")])
    }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func reload() { if let url = localURL { webView.load(URLRequest(url: url)) } }
    @objc func openData() { if let url = dataDirectory { NSWorkspace.shared.open(url) } }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }

    func showLoading() {
        webView.loadHTMLString("<html><body style='background:#cd8fa3;color:#222;font:22px monospace;padding:12vh 8vw'><h1>PI DITHER</h1><p>Starting your local workspace…</p><p>No terminal. No browser tab. Core Pi inside.</p></body></html>", baseURL: nil)
    }
    func startService() {
        guard let resources = Bundle.main.resourceURL else { fail("Application resources are missing."); return }
        let runtime = resources.appendingPathComponent("runtime"), app = resources.appendingPathComponent("app")
        let env = ProcessInfo.processInfo.environment
        if smoke {
            guard let root = env["PI_DITHER_SMOKE_ROOT"], root.hasPrefix("/") else { fail("Smoke tests require an isolated absolute root."); return }
            dataDirectory = URL(fileURLWithPath: root).appendingPathComponent("data")
        } else {
            dataDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pi Dither", isDirectory: true)
        }
        let project = smoke ? env["PI_DITHER_SMOKE_ROOT"]! : FileManager.default.homeDirectoryForCurrentUser.path
        let child = Process(), stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
        var childEnv = env
        // Do not inherit host-harness routing/bootstrap flags into the packaged
        // app. Ordinary provider environment variables remain user-controlled.
        for key in childEnv.keys where key.hasPrefix("PI_") { childEnv.removeValue(forKey: key) }
        childEnv.removeValue(forKey: "NODE_OPTIONS"); childEnv.removeValue(forKey: "NODE_PATH")
        childEnv["PATH"] = runtime.appendingPathComponent("bin").path + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        childEnv["PI_WORKSTATION_PI_ROOT"] = runtime.appendingPathComponent("pi").path
        childEnv["PI_DESKTOP_SUBAGENTS_ROOT"] = runtime.appendingPathComponent("extensions/node_modules/pi-subagents").path
        childEnv["PI_OFFLINE"] = "1"
        if smoke {
            childEnv = ["PATH": childEnv["PATH"]!, "HOME": project, "PI_CODING_AGENT_DIR": project + "/profile", "PI_WORKSTATION_PI_ROOT": childEnv["PI_WORKSTATION_PI_ROOT"]!, "PI_DESKTOP_SUBAGENTS_ROOT": childEnv["PI_DESKTOP_SUBAGENTS_ROOT"]!, "PI_OFFLINE": "1"]
        }
        child.environment = childEnv
        child.executableURL = runtime.appendingPathComponent("bin/node")
        child.arguments = [app.appendingPathComponent("desktop/native-host.mjs").path, "--data-dir", dataDirectory.path, "--workspace", project, "--port", smoke ? "0" : "4317"]
        child.currentDirectoryURL = URL(fileURLWithPath: project)
        child.standardInput = stdinPipe; child.standardOutput = stdoutPipe; child.standardError = stderrPipe
        process = child; input = stdinPipe; output = stdoutPipe; errors = stderrPipe
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
        // Drain diagnostics without persisting arbitrary tool/provider stderr.
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        child.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.serviceExited() } }
        do { try child.run() } catch { fail("The bundled Pi runtime could not be started."); return }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in self?.fail("Pi startup timed out. Quit and retry; check that no other Pi Dither instance is running.") }
    }
    func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        buffer.append(data)
        guard buffer.count < 1_000_000 else { fail("Invalid local service response."); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer[..<end]; buffer.removeSubrange(...end)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let event = value["event"] as? String else { continue }
            switch event {
            case "ready":
                guard let raw = value["url"] as? String, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port < 65536,
                      url.path == "/", url.user == nil, url.password == nil, url.query == nil, url.fragment?.hasPrefix("token=") == true else { fail("Invalid local workspace address."); return }
                startupTimer?.invalidate(); localURL = url
                webView.load(URLRequest(url: url))
            case "status":
                guard waitingToQuit && !shuttingDown else { continue }
                quitTimer?.invalidate()
                let busy = value["busy"] as? Int ?? 1, delegated = value["delegated"] as? Int ?? 0, uncertain = value["uncertain"] as? Bool ?? true
                if busy > 0 || delegated > 0 || uncertain {
                    let alert = NSAlert(); alert.messageText = "Quit while work may still be running?"
                    alert.informativeText = "Pi Dither will stop its own agents. Detached extension jobs may continue without delivering results to this window. Finish or stop those jobs in the app first.\n\nDesktop agents: \(busy) · Delegated jobs: \(delegated)\(uncertain ? " · Status incomplete" : "")"
                    alert.addButton(withTitle: "Keep Working"); alert.addButton(withTitle: "Quit Anyway")
                    if alert.runModal() != .alertSecondButtonReturn { waitingToQuit = false; NSApp.reply(toApplicationShouldTerminate: false); continue }
                }
                shutdown()
            case "error": fail(value["message"] as? String ?? "Local service failed.")
            default: break
            }
        }
    }
    func send(_ command: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["command": command]) else { return }
        try? input?.fileHandleForWriting.write(contentsOf: data + Data([10]))
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard process?.isRunning == true else { return .terminateNow }
        if waitingToQuit { return .terminateCancel }
        waitingToQuit = true; terminationPending = true; send("status")
        quitTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            let alert = NSAlert(); alert.messageText = "The local service is not responding."
            alert.informativeText = "Quit will request shutdown, but task state could not be checked. Detached jobs may continue."
            alert.addButton(withTitle: "Keep Working"); alert.addButton(withTitle: "Quit Anyway")
            if alert.runModal() == .alertSecondButtonReturn { self.shutdown() }
            else { self.waitingToQuit = false; NSApp.reply(toApplicationShouldTerminate: false) }
        }
        return .terminateLater
    }
    func shutdown() {
        guard !shuttingDown else { return }
        shuttingDown = true; startupTimer?.invalidate(); quitTimer?.invalidate(); smokeTimer?.invalidate()
        send("shutdown")
        try? input?.fileHandleForWriting.close()
        // SIGTERM follows the same graceful cleanup handler; never blindly kill
        // detached extension jobs or return while owned sessions are still live.
        quitTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in self?.process?.terminate() }
    }
    func serviceExited() {
        startupTimer?.invalidate(); quitTimer?.invalidate()
        output?.fileHandleForReading.readabilityHandler = nil; errors?.fileHandleForReading.readabilityHandler = nil
        if smoke { finishSmoke(); return }
        if waitingToQuit {
            if terminationPending { NSApp.reply(toApplicationShouldTerminate: true) }
            else { NSApp.terminate(nil) }
        }
        else if !shuttingDown { fail("The local Pi service stopped. Quit and reopen Pi Dither to reconnect; saved sessions remain on disk.") }
    }
    func fail(_ message: String) {
        startupTimer?.invalidate()
        if smoke { print("Native startup: " + message); smokeFailure = true; if process?.isRunning == true { shutdown() } else { finishSmoke() }; return }
        let alert = NSAlert(); alert.messageText = "Pi Dither could not continue"; alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal(); waitingToQuit = true
        if process?.isRunning == true { shutdown() } else { NSApp.terminate(nil) }
    }
    func allowed(_ url: URL) -> Bool {
        guard let local = localURL else { return url.absoluteString == "about:blank" }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == local.port && url.user == nil && url.password == nil
    }
    func externalLink(_ url: URL) {
        guard ["http", "https"].contains(url.scheme ?? ""), !smoke else { return }
        let alert = NSAlert(); alert.messageText = "Link outside Pi Dither"
        alert.informativeText = "External pages cannot replace this privileged workspace. Copy the link to open it yourself."
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Copy Link")
        if alert.runModal() == .alertSecondButtonReturn { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if allowed(url) { decisionHandler(.allow) }
        else { decisionHandler(.cancel); if navigationAction.navigationType == .linkActivated { externalLink(url) } }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { if allowed(url) { webView.load(URLRequest(url: url)) } else { externalLink(url) } }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("The local workspace page could not load (\((error as NSError).code)).") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if !shuttingDown { reload() } }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "Pi Dither"; alert.informativeText = String(message.prefix(4000)); alert.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Pi Dither"; alert.informativeText = String(message.prefix(4000)); alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Confirm")
        completionHandler(alert.runModal() == .alertSecondButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "Pi Dither"; alert.informativeText = String(prompt.prefix(4000)); alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "OK")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); field.stringValue = defaultText ?? ""; alert.accessoryView = field
        completionHandler(alert.runModal() == .alertSecondButtonReturn ? field.stringValue : nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard smoke, localURL != nil, !smokePassed, smokeTimer == nil else { return }
        var attempts = 0
        smokeTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self = self else { return }; attempts += 1
            self.webView.evaluateJavaScript("document.querySelector('.main-window .send')?.disabled === false && document.querySelectorAll('[data-subagent-index]').length === 0 && location.hash === '' && document.title.includes('Pi Dither')") { result, error in
                if let ok = result as? Bool, ok {
                    self.smokeTimer?.invalidate()
                    let check = "const s=await (await fetch('/api/state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('pi-desktop:token')}})).json(); const a=s.agents[0]; await document.fonts.ready; return s.agents.length===1 && s.desktopVersion==='0.4.0' && a.kind==='main' && a.connected && a.messages.length===0 && a.phase==='idle' && a.extensionStatus.status==='loaded' && a.activeTools.includes('subagent') && a.activeTools.includes('subagent_supervisor');"
                    self.webView.callAsyncJavaScript(check, arguments: [:], in: nil, in: .page) { result in
                        if case .success(let value) = result, value as? Bool == true { self.smokePassed = true }
                        else { print("Native bundled-runtime/API check failed"); self.smokeFailure = true }
                        self.shutdown()
                    }
                } else if attempts > 100 {
                    self.smokeTimer?.invalidate()
                    self.webView.evaluateJavaScript("JSON.stringify({title:document.title,ready:document.readyState,send:document.querySelector('.main-window .send')?.disabled,errors:window.nativeSmokeErrors,phase:document.querySelector('.main-window .phase')?.textContent})") { detail, _ in
                        print("Native DOM: \(detail ?? "unavailable")"); self.smokeFailure = true; self.shutdown()
                    }
                }
            }
        }
    }
    func finishSmoke() {
        let passed = smokePassed && !smokeFailure
        print(passed ? "PASS: native WKWebView loaded bundled Pi Dither; no startup children or visible token; owned service exited." : "FAIL: native smoke test")
        exit(passed ? 0 : 1)
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
