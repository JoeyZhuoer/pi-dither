import AppKit
import WebKit
import UniformTypeIdentifiers
import IOKit.hid


// The laptop-motion sensor. macOS exposes the Apple SPU accelerometer as a HID
// device (page 0xFF00, usage 3, transport SPU, 22-byte reports), but it withholds
// its reports from unprivileged processes on some machines: `accel`, `gyro` and
// `devmotion6` never stream here while the light sensors do. The bridge therefore
// never claims success on noise — `available` requires input reports whose resting
// magnitude really is about 1 g — and reports `unavailable`/`denied` otherwise, so
// the interface stays honest and the app is unaffected either way.
final class MotionBridge {
    private weak var webView: WKWebView?
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var runLoop: CFRunLoop?
    private var started = false
    private var delivery: Timer?
    private var validation: Timer?
    private let lock = NSLock()
    private var latest: (x: Double, y: Double, z: Double, at: Double)?
    private var previous: (x: Double, y: Double, z: Double)?
    private var pending = false
    private var peak = 0.0
    private var samples = 0
    private var rejected = 0
    private var magnitude = 0.0
    private var openedAt = 0.0
    private(set) var status = "unavailable"
    private var reason = "not started"
    private var source = "none"

    // Contract C1: the host object exists before any page script runs, keeps
    // latest/peak/status current even with no subscriber, and is never assumed to
    // have been defined by the page.
    func script() -> WKUserScript {
        let source = """
        (() => {
          if (window.__piDitherMotionHost && window.__piDitherMotionHost.version === 1) return;
          const listeners = new Set();
          window.__piDitherMotionHost = {
            version: 1,
            status: "\(status)",
            latest: null,
            peak: 0,
            subscribe(callback) {
              if (typeof callback !== "function") return () => {};
              listeners.add(callback);
              return () => listeners.delete(callback);
            },
            deliver(sample) {
              if (!sample || typeof sample !== "object") return false;
              const x = Number(sample.x), y = Number(sample.y), z = Number(sample.z);
              if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
              const at = Number.isFinite(Number(sample.at)) ? Number(sample.at) : Date.now();
              const peak = Number.isFinite(Number(sample.peak)) ? Number(sample.peak) : 0;
              this.latest = { x: x, y: y, z: z, at: at };
              this.peak = peak;
              for (const callback of Array.from(listeners)) { try { callback({ x: x, y: y, z: z, at: at, peak: peak }); } catch (error) {} }
              return true;
            }
          };
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func start(webView: WKWebView) {
        guard !started else { return }
        started = true
        self.webView = webView
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matches: [[String: Any]] = [[
            kIOHIDPrimaryUsagePageKey as String: 0xFF00,
            kIOHIDPrimaryUsageKey as String: 3,
            kIOHIDTransportKey as String: "SPU",
        ]]
        IOHIDManagerSetDeviceMatchingMultiple(manager, matches as CFArray)
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(manager, motionDeviceMatched, context)
        IOHIDManagerRegisterInputReportCallback(manager, motionInputReport, context)
        self.manager = manager
        let thread = Thread { [weak self] in
            guard let self, let manager = self.manager else { return }
            self.runLoop = CFRunLoopGetCurrent()
            IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            let opened = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
            if opened != kIOReturnSuccess {
                self.resolve(opened == kIOReturnNotPermitted || opened == kIOReturnExclusiveAccess ? "denied" : "unavailable",
                             "HID manager open failed (\(opened))")
            }
            CFRunLoopRun()
        }
        thread.name = "pi-dither-motion"
        thread.stackSize = 512 * 1024
        thread.start()
        delivery = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.deliver() }
        // A sensor that has not produced one plausible resting reading by now is
        // not usable: say so instead of pretending it is running.
        validation = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            guard let self, self.status != "available" else { return }
            self.resolve("unavailable", self.source == "none"
                ? "no accelerometer matched (page 0xFF00 usage 3, transport SPU)"
                : "no validated input reports from \(self.source): the system withheld the sensor from this process")
        }
    }

    func stop() {
        delivery?.invalidate(); delivery = nil
        validation?.invalidate(); validation = nil
        lock.lock(); let device = self.device; lock.unlock()
        if let device {
            IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        if let runLoop { CFRunLoopStop(runLoop) }
    }

    fileprivate func attach(_ device: IOHIDDevice) {
        let product = IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String ?? "?"
        let transport = IOHIDDeviceGetProperty(device, kIOHIDTransportKey as CFString) as? String ?? "?"
        lock.lock(); let already = self.device != nil; lock.unlock()
        guard !already else { return }
        let opened = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        guard opened == kIOReturnSuccess else {
            resolve(opened == kIOReturnNotPermitted || opened == kIOReturnExclusiveAccess ? "denied" : "unavailable",
                    "device open failed (\(opened)) for \(product)")
            return
        }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
        IOHIDDeviceRegisterInputReportCallback(device, buffer, 64, motionInputReport, Unmanaged.passUnretained(self).toOpaque())
        IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        lock.lock()
        self.device = device
        source = "\(product)/\(transport)"
        reason = "waiting for input reports"
        openedAt = ProcessInfo.processInfo.systemUptime
        lock.unlock()
    }

    // Three little-endian Float32 in g. A resting accelerometer reads about 1 g, so
    // the first accepted sample has to be plausible before anything is claimed.
    fileprivate func ingest(x: Double, y: Double, z: Double, at: Double) {
        guard x.isFinite, y.isFinite, z.isFinite else { return }
        let size = (x * x + y * y + z * z).squareRoot()
        guard size > 0.02, size < 8 else { lock.lock(); rejected += 1; lock.unlock(); return }
        lock.lock()
        let first = status != "available"
        if first && !(size >= 0.5 && size <= 1.6) { rejected += 1; lock.unlock(); return }
        if first {
            magnitude = size
            openedAt = at
        } else {
            magnitude += (size - magnitude) * 0.05
        }
        if let previous {
            let dx = x - previous.x, dy = y - previous.y, dz = z - previous.z
            let delta = (dx * dx + dy * dy + dz * dz).squareRoot()
            if delta > peak { peak = delta }
        }
        previous = (x, y, z)
        latest = (x, y, z, at)
        samples += 1
        pending = true
        lock.unlock()
        if first { resolve("available", String(format: "validated %.3f g at rest", size)) }
    }

    private func resolve(_ next: String, _ note: String) {
        status = next
        reason = note
        log()
        let quoted = next.replacingOccurrences(of: "'", with: "")
        webView?.evaluateJavaScript("window.__piDitherMotionHost && (window.__piDitherMotionHost.status = '\(quoted)')", completionHandler: nil)
    }

    private func deliver() {
        lock.lock()
        guard pending, let sample = latest else { lock.unlock(); return }
        let burst = peak
        pending = false
        peak = 0
        lock.unlock()
        // One JSON literal per delivery, at most 60 times a second.
        let payload = String(format: "{\"x\":%.6f,\"y\":%.6f,\"z\":%.6f,\"at\":%.3f,\"peak\":%.4f}",
                             sample.x, sample.y, sample.z, sample.at * 1000, burst)
        webView?.evaluateJavaScript("window.__piDitherMotionHost && window.__piDitherMotionHost.deliver(\(payload))", completionHandler: nil)
    }

    private func log() {
        lock.lock()
        let count = samples, skipped = rejected, resting = magnitude, device = source, startedAt = openedAt
        lock.unlock()
        let seconds = ProcessInfo.processInfo.systemUptime - startedAt
        let rate = count > 1 && seconds > 0 ? Double(count) / seconds : 0
        print("Motion bridge: status=\(status) device=\(device) samples=\(count) rejected=\(skipped) rate=\(String(format: "%.1f", rate))Hz |a|=\(String(format: "%.3f", resting))g reason=\(reason)")
        fflush(stdout)
    }
}

private func motionDeviceMatched(_ context: UnsafeMutableRawPointer?, _ result: IOReturn, _ sender: UnsafeMutableRawPointer?, _ device: IOHIDDevice) {
    guard let context else { return }
    Unmanaged<MotionBridge>.fromOpaque(context).takeUnretainedValue().attach(device)
}

private func motionInputReport(_ context: UnsafeMutableRawPointer?, _ result: IOReturn, _ sender: UnsafeMutableRawPointer?, _ type: IOHIDReportType, _ reportID: UInt32, _ report: UnsafeMutablePointer<UInt8>, _ length: CFIndex) {
    guard let context, length >= 12 else { return }
    func value(_ offset: Int) -> Double {
        var word: UInt32 = 0
        for index in 0..<4 { word |= UInt32(report[offset + index]) << (8 * UInt32(index)) }
        return Double(Float(bitPattern: word))
    }
    Unmanaged<MotionBridge>.fromOpaque(context).takeUnretainedValue()
        .ingest(x: value(0), y: value(4), z: value(8), at: ProcessInfo.processInfo.systemUptime)
}

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
    let resetWindowLayout = ProcessInfo.processInfo.arguments.contains("--reset-window-layout")
    var layoutResetScripts: [WKUserScript] = []
    let motion = MotionBridge()
    var smokePassed = false
    var smokeFailure = false
    var smokeReloading = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(motion.script())
        // Fixed local origin + normal store keep layout preferences. Test
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
            if resetWindowLayout { NSWindow.removeFrame(usingName: "PiDitherMain") }
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
    @objc func reload() {
        guard let url = localURL, var target = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        // The UI removes its token fragment. Loading the bootstrap URL again can
        // become a same-document fragment navigation in WKWebView, not a reload.
        // A nonsecret nonce forces a full load and reboots auth even if storage
        // was lost; app.js strips both nonce and fragment immediately afterward.
        target.queryItems = [URLQueryItem(name: "reload", value: UUID().uuidString)]
        if let refreshed = target.url { webView.load(URLRequest(url: refreshed, cachePolicy: .reloadIgnoringLocalCacheData)) }
    }
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
                if resetWindowLayout { prepareLayoutReset(port: port) }
                webView.load(URLRequest(url: url))
                motion.start(webView: webView)
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
        shuttingDown = true; startupTimer?.invalidate(); quitTimer?.invalidate(); smokeTimer?.invalidate(); motion.stop()
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
    // The background-photo picker stays inside the app: images only, no shell.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.image]
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "Pi Dither"; alert.informativeText = String(prompt.prefix(4000)); alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "OK")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); field.stringValue = defaultText ?? ""; alert.accessoryView = field
        completionHandler(alert.runModal() == .alertSecondButtonReturn ? field.stringValue : nil)
    }
    // Explicit one-shot maintenance only. Never clear a whole website store:
    // credentials, sessions and workspace settings are not layout data.
    func prepareLayoutReset(port: Int) {
        var sources: [String] = []
        if smoke {
            // Seed stale geometry plus unrelated preferences in the ephemeral
            // fixture store, proving a selective reset rather than an empty one.
            sources.append("""
            localStorage.setItem('pi-desktop:layout:v1', JSON.stringify({main:{x:0,y:0,w:650,h:440,sizeMode:'manual',zoomed:true},models:{x:0,y:0,w:500,h:450,hidden:false,sizeMode:'manual',zoomed:true}}));
            localStorage.setItem('pi-dither:smoke-keep','retained');
            sessionStorage.setItem('pi-desktop:delegated-closed:v1:fixture','["old"]');
            sessionStorage.setItem('pi-dither:smoke-keep','retained');
            """)
        }
        sources.append("""
        try {
          localStorage.removeItem('pi-desktop:layout:v1');
          for (let i=sessionStorage.length-1;i>=0;i--) {
            const key=sessionStorage.key(i);
            if (key?.startsWith('pi-desktop:delegated-closed:v1:')) sessionStorage.removeItem(key);
          }
          window.piDitherLayoutResetOK=true;
        } catch { window.piDitherLayoutResetOK=false; }
        """)
        for source in sources {
            let script = WKUserScript(source: "if(location.origin==='http://127.0.0.1:\(port)'){" + source + "}", injectionTime: .atDocumentStart, forMainFrameOnly: true)
            layoutResetScripts.append(script); webView.configuration.userContentController.addUserScript(script)
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !layoutResetScripts.isEmpty, let url = webView.url, url.scheme == "http", allowed(url) {
            let controller = webView.configuration.userContentController
            let retained = controller.userScripts.filter { script in !layoutResetScripts.contains(where: { $0 === script }) }
            controller.removeAllUserScripts(); retained.forEach { controller.addUserScript($0) }; layoutResetScripts.removeAll()
            webView.evaluateJavaScript("window.piDitherLayoutResetOK === true") { result, _ in
                guard result as? Bool == true else { self.fail("Window layout preferences could not be reset."); return }
                print("PASS: window layout reset; unrelated preferences retained."); fflush(stdout)
            }
        }
        guard smoke, localURL != nil, !smokePassed, smokeTimer == nil else { return }
        var attempts = 0
        smokeTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self = self else { return }; attempts += 1
            self.webView.evaluateJavaScript("document.querySelector('.main-window .send')?.disabled === false && document.querySelectorAll('[data-subagent-index]').length === 0 && location.hash === '' && document.title.includes('Pi Dither')") { result, error in
                if let ok = result as? Bool, ok {
                    self.smokeTimer?.invalidate()
                    guard let file = Bundle.main.resourceURL?.appendingPathComponent("validation/SmokeChecks.js"),
                          let checks = try? String(contentsOf: file, encoding: .utf8) else {
                        self.smokeFailure = true; self.shutdown(); return
                    }
                    self.webView.evaluateJavaScript(checks) { _, error in
                        if error != nil { self.smokeFailure = true; self.shutdown() }
                        else { self.runSmokeStage(self.smokeReloading ? "reloaded" : "initial") }
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
    func runSmokeStage(_ stage: String) {
        guard smoke, !shuttingDown else { return }
        print("Native fixture stage: " + stage); fflush(stdout)
        webView.callAsyncJavaScript("return await piDitherSmoke(stage)", arguments: ["stage": stage], in: nil, in: .page) { result in
            guard case .success(let value) = result, value as? Bool == true else {
                var detail = "JavaScript check failed"
                if case .failure(let error) = result,
                   let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String {
                    detail = message.replacingOccurrences(of: "token=[^\\s&]+", with: "token=[redacted]", options: .regularExpression)
                }
                print("Native feature check failed at " + stage + ": " + String(detail.prefix(300)))
                self.smokeFailure = true; self.shutdown(); return
            }
            let next: (String, NSSize)?
            switch stage {
            case "initial": next = ("minimum", NSSize(width: 800, height: 600))
            case "minimum": next = ("narrow", NSSize(width: 980, height: 740))
            case "narrow": next = ("wide", NSSize(width: 1440, height: 940))
            case "wide": next = ("manual-narrow", NSSize(width: 980, height: 740))
            case "manual-narrow": next = ("manual-wide", NSSize(width: 1440, height: 940))
            case "manual-wide":
                // Hide/reopen and Reload must not replace the native-owned session.
                _ = self.windowShouldClose(self.window)
                guard !self.window.isVisible, self.process?.isRunning == true else {
                    self.smokeFailure = true; self.shutdown(); return
                }
                _ = self.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
                guard self.window.isVisible else { self.smokeFailure = true; self.shutdown(); return }
                print("Native fixture: reloading interface"); fflush(stdout)
                self.smokeReloading = true; self.smokeTimer = nil; self.reload()
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                    if !self.shuttingDown && !self.smokePassed && self.smokeTimer == nil {
                        print("Native reload did not complete navigation"); self.smokeFailure = true; self.shutdown()
                    }
                }
                return
            default: next = nil
            }
            if let (name, size) = next {
                self.window.setContentSize(size)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.runSmokeStage(name) }
            } else {
                // State the sensor truth in the pass line itself: the bridge is present
                // either way, but a machine whose system withholds the accelerometer
                // must not be reported as if it streamed.
                var motionTruth = "laptop-motion bridge with live accelerometer samples"
                if self.motion.status != "available" { motionTruth = "laptop-motion bridge present but no sensor reports delivered on this machine (\(self.motion.status))" }
                print("PASS: native feature checks — nine utilities, roomy opening with a narrow main floor, native resize, manual layouts, maximize, draft controls, menus, appearance colours, photo point cloud with reference-site push/pull and spring-back, " + motionTruth + ", synthetic lean and knock, particle field, window settings, hide/reopen, Reload and unchanged conversation.")
                self.smokePassed = true; self.shutdown()
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
