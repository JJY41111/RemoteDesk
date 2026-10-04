import UIKit
import WebKit
import GameController

final class PointerController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKDownloadDelegate {
    private let serverURL: URL
    private var web: WKWebView!
    private let label = UILabel()
    private var displayLink: CADisplayLink?
    private var observers: [NSObjectProtocol] = []
    private var mice: [GCMouse] = []
    private var wantsCapture = false
    private var pointerPreferenceQueries = 0
    private var captureQueryBaseline = 0
    private var lastLockDiagnostic = ""
    private var lastViewSize = CGSize.zero
    private var epoch = 0
    private var lastLocked = false
    private var statusDirty = true
    private var pageReady = false
    private var stopped = false
    private var inFlight = false
    private var flightStarted: CFTimeInterval = 0
    private var events: [[String: Any]] = []
    private var escapeHeld = false
    private var keyboard: GCKeyboardInput?
    private var keyboardEnabled = false
    private var padEnabled = false
    private var controlEpoch = 0
    private var controlEvents: [[String: Any]] = []
    private var lastPad = ""
    private var lastPadAt: CFTimeInterval = 0
    private var downloads: [ObjectIdentifier: URL] = [:]
    override var prefersPointerLocked: Bool {
        pointerPreferenceQueries += 1
        return wantsCapture
    }

    init(url: URL) { serverURL = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(url:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "remoteDeskMouse")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.remoteDeskNative = Object.freeze({version:2,keyboard:true,gamepad:true,appVersion:'0.4.0'});",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .black
        web.translatesAutoresizingMaskIntoConstraints = false
        let releaseButton = UIButton(type: .system)
        releaseButton.setTitle("釋放滑鼠", for: .normal)
        releaseButton.addTarget(self, action: #selector(releaseCapture), for: .touchUpInside)
        let closeButton = UIButton(type: .system)
        closeButton.setTitle("返回", for: .normal)
        closeButton.addTarget(self, action: #selector(closeReceiver), for: .touchUpInside)
        label.text = "RemoteDesk App · 載入中"
        label.textColor = .white
        label.font = .systemFont(ofSize: 12)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let retryButton = UIButton(type: .system)
        retryButton.setTitle("重試鎖定", for: .normal)
        retryButton.addTarget(self, action: #selector(retryPointerLock), for: .touchUpInside)
        let bar = UIStackView(arrangedSubviews: [label, retryButton, releaseButton, closeButton])
        bar.axis = .horizontal; bar.spacing = 14
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar); view.addSubview(web)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            bar.heightAnchor.constraint(equalToConstant: 40),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        observe(.GCMouseDidConnect) { [weak self] in self?.refreshMice() }
        observe(.GCMouseDidDisconnect) { [weak self] in
            self?.releaseCapture(); self?.refreshMice()
        }
        observe(UIApplication.willResignActiveNotification) { [weak self] in self?.releaseCapture() }
        observe(UIPointerLockState.didChangeNotification) { [weak self] in self?.statusDirty = true }
        observe(.GCKeyboardDidConnect) { [weak self] in self?.refreshKeyboard() }
        observe(.GCKeyboardDidDisconnect) { [weak self] in
            self?.web.evaluateJavaScript("window.remoteDeskNativeKeyboardReset?.();", completionHandler: nil)
            self?.controlEvents.removeAll(); self?.refreshKeyboard()
        }
        refreshKeyboard()
        refreshMice()
        displayLink = CADisplayLink(target: self, selector: #selector(tick))
        displayLink?.preferredFramesPerSecond = 60
        displayLink?.add(to: .main, forMode: .common)
        web.load(URLRequest(url: serverURL))
        print("RemoteDesk pointer: receiver created; no third-party WebRTC SDK")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        statusDirty = true
        setNeedsUpdateOfPrefersPointerLocked()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if view.bounds.size != lastViewSize {
            lastViewSize = view.bounds.size
            statusDirty = true
        }
    }

    @objc private func retryPointerLock() {
        guard pageReady, trusted(web.url), !stopped else { return }
        if wantsCapture {
            view.window?.endEditing(true)
            captureQueryBaseline = pointerPreferenceQueries
            statusDirty = true
            setNeedsUpdateOfPrefersPointerLocked()
        } else {
            web.evaluateJavaScript("document.getElementById('gameMouse')?.click();", completionHandler: nil)
        }
    }

    private var lockDiagnostic: String {
        guard wantsCapture else { return mice.isEmpty ? "未連接滑鼠" : "尚未要求鎖定" }
        guard let window = view.window, let scene = window.windowScene else { return "接收器未附加視窗" }
        guard scene.activationState == .foregroundActive else { return "App 不在活動前景" }
        guard scene.pointerLockState != nil else { return "此執行場景不提供游標鎖定" }
        if locked { return "已鎖定" }
        let sceneSize = scene.coordinateSpace.bounds.size
        let screenSize = scene.screen.coordinateSpace.bounds.size
        if abs(sceneSize.width - screenSize.width) > 2 || abs(sceneSize.height - screenSize.height) > 2 {
            return "系統回報場景未滿版"
        }
        if presentedViewController != nil { return "另有介面覆蓋接收器" }
        if !window.isKeyWindow { return "接收器視窗不是主視窗" }
        return "系統未鎖定 · 鎖定要求查詢 \(pointerPreferenceQueries - captureQueryBaseline) 次"
    }

    private func observe(_ name: NSNotification.Name, action: @escaping () -> Void) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in action() })
    }
    private func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == serverURL.host &&
            (url.port ?? 443) == (serverURL.port ?? 443)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !stopped, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url),
              let body = message.body as? [String: Any] else { return }
        if body["action"] as? String == "input-state" {
            controlEpoch = body["epoch"] as? Int ?? 0
            keyboardEnabled = body["keyboard"] as? Bool == true
            padEnabled = body["gamepad"] as? Bool == true
            controlEvents.removeAll(); lastPad = ""; statusDirty = true
            return
        }
        guard body["action"] as? String == "capture",
              let enabled = body["enabled"] as? Bool, let nextEpoch = body["epoch"] as? Int else { return }
        epoch = nextEpoch
        events.removeAll()
        wantsCapture = enabled && !mice.isEmpty && UIApplication.shared.applicationState == .active
        captureQueryBaseline = pointerPreferenceQueries
        if wantsCapture { view.window?.endEditing(true) }
        statusDirty = true
        setNeedsUpdateOfPrefersPointerLocked()
    }

    private func refreshKeyboard() {
        keyboard?.keyChangedHandler = nil
        keyboard = GCKeyboard.coalesced?.keyboardInput
        keyboard?.keyChangedHandler = { [weak self] input, _, code, pressed in
            DispatchQueue.main.async {
                guard let self, self.keyboard === input, self.keyboardEnabled, !self.stopped,
                      UIApplication.shared.applicationState == .active,
                      let name = Self.keyName(Int(code.rawValue)) else { return }
                guard self.controlEvents.count < 128 else { self.releaseCapture(); return }
                self.controlEvents.append(["type":"key", "code":name, "down":pressed])
            }
        }
    }
    private static func keyName(_ hid: Int) -> String? {
        if (4...29).contains(hid) { return "Key" + String(UnicodeScalar(65 + hid - 4)!) }
        if (30...38).contains(hid) { return "Digit" + String(hid - 29) }
        if hid == 39 { return "Digit0" }
        if (58...69).contains(hid) { return "F" + String(hid - 57) }
        return [40:"Enter",41:"Escape",42:"Backspace",43:"Tab",44:"Space",
            45:"Minus",46:"Equal",47:"BracketLeft",48:"BracketRight",49:"Backslash",
            51:"Semicolon",52:"Quote",53:"Backquote",54:"Comma",55:"Period",56:"Slash",
            57:"CapsLock",73:"Insert",74:"Home",75:"PageUp",76:"Delete",77:"End",78:"PageDown",
            79:"ArrowRight",80:"ArrowLeft",81:"ArrowDown",82:"ArrowUp",
            224:"ControlLeft",225:"ShiftLeft",226:"AltLeft",227:"MetaLeft",
            228:"ControlRight",229:"ShiftRight",230:"AltRight",231:"MetaRight"][hid]
    }
    private func sampleGamepad() -> [String: Any]? {
        guard padEnabled, UIApplication.shared.applicationState == .active else { return nil }
        guard let pad = GCController.controllers().compactMap({ $0.extendedGamepad }).first else {
            if !lastPad.isEmpty { lastPad = ""; return ["type":"gamepad", "buttons":Array(repeating:0, count:17), "axes":[0,0,0,0]] }
            return nil
        }
        let buttons: [Float] = [pad.buttonA.value,pad.buttonB.value,pad.buttonX.value,pad.buttonY.value,
            pad.leftShoulder.value,pad.rightShoulder.value,pad.leftTrigger.value,pad.rightTrigger.value,
            pad.buttonOptions?.value ?? 0,pad.buttonMenu.value,pad.leftThumbstickButton?.value ?? 0,
            pad.rightThumbstickButton?.value ?? 0,pad.dpad.up.value,pad.dpad.down.value,
            pad.dpad.left.value,pad.dpad.right.value,pad.buttonHome?.value ?? 0]
        let axes: [Float] = [pad.leftThumbstick.xAxis.value,-pad.leftThumbstick.yAxis.value,
                           pad.rightThumbstick.xAxis.value,-pad.rightThumbstick.yAxis.value]
        let state: [String: Any] = ["type":"gamepad", "buttons":buttons, "axes":axes]
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]),
              let serialized = String(data: data, encoding: .utf8) else { return nil }
        let now = CACurrentMediaTime()
        guard serialized != lastPad || now - lastPadAt >= 0.1 else { return nil }
        lastPad = serialized; lastPadAt = now
        return state
    }

    private func clearMouseHandlers() {
        for mouse in mice {
            mouse.mouseInput?.mouseMovedHandler = nil
            mouse.mouseInput?.leftButton.pressedChangedHandler = nil
            mouse.mouseInput?.rightButton?.pressedChangedHandler = nil
            mouse.mouseInput?.middleButton?.pressedChangedHandler = nil
            mouse.mouseInput?.scroll.valueChangedHandler = nil
        }
    }
    private func refreshMice() {
        clearMouseHandlers()
        mice = GCMouse.mice()
        statusDirty = true
        for mouse in mice {
            mouse.mouseInput?.mouseMovedHandler = { [weak self] _, dx, dy in
                DispatchQueue.main.async { self?.enqueueMove(Double(dx), -Double(dy)) }
            }
            installButton(mouse.mouseInput?.leftButton, index: 0)
            installButton(mouse.mouseInput?.middleButton, index: 1)
            installButton(mouse.mouseInput?.rightButton, index: 2)
            mouse.mouseInput?.scroll.valueChangedHandler = { [weak self] _, _, y in
                guard y != 0 else { return }
                DispatchQueue.main.async { self?.enqueue(["type": "wheel", "delta": y > 0 ? 120 : -120]) }
            }
        }
    }
    private func installButton(_ button: GCControllerButtonInput?, index: Int) {
        button?.pressedChangedHandler = { [weak self] _, _, pressed in
            DispatchQueue.main.async { self?.enqueue(["type": "button", "button": index, "down": pressed]) }
        }
    }
    private var locked: Bool {
        wantsCapture && view.window?.windowScene?.pointerLockState?.isLocked == true
    }
    private func enqueueMove(_ dx: Double, _ dy: Double) {
        guard dx.isFinite, dy.isFinite, locked else { return }
        if let last = events.last, last["type"] as? String == "move" {
            events[events.count - 1] = ["type": "move", "dx": (last["dx"] as? Double ?? 0) + dx,
                                       "dy": (last["dy"] as? Double ?? 0) + dy]
        } else { enqueue(["type": "move", "dx": dx, "dy": dy]) }
    }
    private func enqueue(_ event: [String: Any]) {
        guard locked else { return }
        guard events.count < 128 else {
            // Never drop just a release and leave attack held indefinitely.
            releaseCapture(); return
        }
        events.append(event)
    }

    @objc private func tick() {
        guard !stopped else { return }
        let escape = GCKeyboard.coalesced?.keyboardInput?.button(forKeyCode: .escape)?.isPressed ?? false
        if escape && !escapeHeld && wantsCapture { releaseCapture() }
        escapeHeld = escape
        let isLocked = locked
        let diagnostic = lockDiagnostic
        if diagnostic != lastLockDiagnostic {
            lastLockDiagnostic = diagnostic; statusDirty = true
            print("RemoteDesk pointer: \(diagnostic); requested=\(wantsCapture); queries=\(pointerPreferenceQueries)")
        }
        if isLocked != lastLocked {
            lastLocked = isLocked; statusDirty = true
            if !isLocked { events.removeAll() }
        }
        label.text = isLocked ? "游標已鎖定 · Esc 可釋放" :
            mice.isEmpty ? "未偵測到滑鼠" : wantsCapture ? diagnostic : "滑鼠已偵測 · 功能 → 遊戲滑鼠"
        label.text = (label.text ?? "") + " · 鍵盤" + (keyboard == nil ? "未連接" : "已連接") +
            " · 手把" + (GCController.controllers().contains { $0.extendedGamepad != nil } ? "已連接" : "未連接")
        guard pageReady, trusted(web.url) else { return }
        if inFlight {
            if CACurrentMediaTime() - flightStarted > 1 && (wantsCapture || keyboardEnabled || padEnabled) { releaseCapture() }
            return
        }
        let padEvent = sampleGamepad()
        guard statusDirty || !events.isEmpty || !controlEvents.isEmpty || padEvent != nil else { return }
        let payload: [String: Any] = ["epoch": epoch, "locked": isLocked,
            "error": wantsCapture && !isLocked ? diagnostic : "", "requested": wantsCapture,
            "queries": pointerPreferenceQueries - captureQueryBaseline,
            "available": view.window?.windowScene?.pointerLockState != nil,
            "sceneWidth": view.window?.windowScene?.coordinateSpace.bounds.width ?? 0,
            "sceneHeight": view.window?.windowScene?.coordinateSpace.bounds.height ?? 0]
        guard let statusData = try? JSONSerialization.data(withJSONObject: payload),
              let inputData = try? JSONSerialization.data(withJSONObject: events),
              let controlData = try? JSONSerialization.data(withJSONObject: controlEvents + (padEvent.map { [$0] } ?? [])),
              let controlJSON = String(data: controlData, encoding: .utf8),
              let statusJSON = String(data: statusData, encoding: .utf8),
              let inputJSON = String(data: inputData, encoding: .utf8) else { releaseCapture(); return }
        events.removeAll(); controlEvents.removeAll(); statusDirty = false
        inFlight = true; flightStarted = CACurrentMediaTime()
        web.evaluateJavaScript("window.remoteDeskNativeStatus?.(\(statusJSON));window.remoteDeskNativeInput?.(\(inputJSON),\(epoch));window.remoteDeskNativeControlInput?.(\(controlJSON),\(controlEpoch));") { [weak self] _, error in
            guard let self else { return }
            self.inFlight = false
            if let error {
                self.releaseCapture()
                self.setNeedsUpdateOfPrefersPointerLocked()
                self.label.text = "輸入橋接失敗：\(error.localizedDescription)"
            }
        }
    }
    @objc func releaseCapture() {
        wantsCapture = false; events.removeAll(); controlEvents.removeAll(); keyboardEnabled = false; padEnabled = false; statusDirty = true
        setNeedsUpdateOfPrefersPointerLocked()
        if pageReady && trusted(web.url) { web.evaluateJavaScript("window.remoteDeskNativeRelease?.();", completionHandler: nil) }
    }
    @objc private func closeReceiver() { NativeWindow.shared.close() }
    func shutdown() {
        releaseCapture(); stopped = true
        keyboard?.keyChangedHandler = nil; keyboard = nil
        clearMouseHandlers(); mice.removeAll()
        displayLink?.invalidate(); displayLink = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "remoteDeskMouse")
        web.evaluateJavaScript("document.getElementById('disconnect')?.click();", completionHandler: nil)
        web.navigationDelegate = nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let ownBlob = url?.scheme == "blob" && trusted(URL(string: String(url!.absoluteString.dropFirst(5))))
        guard trusted(url) || ownBlob else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload || ownBlob {
            releaseCapture(); decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let filename = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let destination = folder.appendingPathComponent(filename.isEmpty ? "remotedesk-download" : filename)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { completionHandler(nil); label.text = "下載暫存失敗：\(error.localizedDescription)" }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)), !stopped else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 40, width: 1, height: 1)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        present(sheet, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        label.text = "下載失敗：\(error.localizedDescription)"
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false; releaseCapture()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true; statusDirty = true
        print("RemoteDesk pointer: HTTPS page loaded")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageReady = false; releaseCapture()
        label.text = "載入失敗：\(error.localizedDescription)；請確認 VPN 與 CA 完全信任。"
        print("RemoteDesk pointer: navigation error \(error)")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false; releaseCapture()
        label.text = "網頁程序中止；請返回後重新開啟。"
    }
}
