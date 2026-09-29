import AVFoundation
import Combine
import Foundation
import GameController
import WebRTC

final class RemoteSession: NSObject, ObservableObject {
    @Published private(set) var status = "尚未連線"
    @Published private(set) var connected = false
    @Published private(set) var controlAvailable = false
    @Published private(set) var controlRequested = false
    @Published private(set) var controlEnabled = false
    @Published private(set) var gamepadAvailable = false
    @Published private(set) var gamepadEnabled = false
    @Published private(set) var audioAvailable = false
    @Published private(set) var gamepadStatus = "未偵測手把"
    @Published private(set) var videoWidth = 1920
    @Published private(set) var videoHeight = 1080

    let videoView = RTCMTLVideoView(frame: .zero)

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()

    private var urlSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var videoTrack: RTCVideoTrack?
    private var pendingCandidates: [(sdp: String, mid: String)] = []
    private var remoteMids: [String] = []
    private var pairingCode = ""
    private var controllerTimer: Timer?
    private var lastGamepadJSON = ""
    private var lastGamepadSent = Date.distantPast
    private var heldKeys = Set<String>()
    private var gamepadWanted = false

    func connect(host: String, code: String) {
        disconnect()
        let address = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, !address.contains("/"), !address.contains(":"),
              code.range(of: #"^\d{8}$"#, options: .regularExpression) != nil,
              let url = URL(string: "wss://\(address):8443/signal") else {
            status = "請輸入區網 IP 和 8 位數配對碼"
            return
        }
        pairingCode = code
        var request = URLRequest(url: url)
        request.setValue("ipad-native-v1", forHTTPHeaderField: "X-RemoteDesk-Client")
        request.setValue("https://\(address):8443", forHTTPHeaderField: "Origin")
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        urlSession = session
        let task = session.webSocketTask(with: request)
        socket = task
        status = "正在連接 \(address)…"
        task.resume()
        receive(on: task)
    }

    func disconnect() {
        sendNeutralGamepad()
        releaseKeys()
        if controlEnabled { sendSignal(["type": "set-control", "enabled": false]) }
        videoTrack?.remove(videoView)
        videoTrack = nil
        channel?.close()
        channel = nil
        peer?.close()
        peer = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        controllerTimer?.invalidate()
        controllerTimer = nil
        pendingCandidates.removeAll()
        remoteMids.removeAll()
        heldKeys.removeAll()
        lastGamepadJSON = ""
        connected = false
        controlAvailable = false
        controlRequested = false
        controlEnabled = false
        gamepadAvailable = false
        gamepadEnabled = false
        gamepadWanted = false
        audioAvailable = false
        status = "已斷線"
    }

    func setControl(_ enabled: Bool) {
        guard controlAvailable, connected else { return }
        controlRequested = enabled
        if !enabled {
            sendNeutralGamepad()
            releaseKeys()
            gamepadWanted = false
            sendSignal(["type": "set-gamepad", "enabled": false])
        }
        sendSignal(["type": "set-control", "enabled": enabled])
    }

    func setGamepad(_ enabled: Bool) {
        guard gamepadAvailable, controlEnabled else { return }
        gamepadWanted = enabled
        if !enabled { sendNeutralGamepad() }
        sendSignal(["type": "set-gamepad", "enabled": enabled])
        status = enabled ? "正在建立 Windows 虛擬手把…" : "已要求停用虛擬手把"
    }

    func sendPointer(x: CGFloat, y: CGFloat) {
        sendInput(["type": "move", "x": max(0, min(1, x)), "y": max(0, min(1, y))])
    }

    func sendButton(_ button: Int, down: Bool) {
        sendInput(["type": "button", "button": button, "down": down])
    }

    func sendWheel(_ delta: Int) {
        sendInput(["type": "wheel", "delta": delta])
    }

    func sendKey(_ code: String, down: Bool) {
        guard controlEnabled else { return }
        if down == heldKeys.contains(code) { return }
        sendInput(["type": "key", "code": code, "down": down])
        if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
    }

    func tapKey(_ code: String) {
        sendKey(code, down: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
            self?.sendKey(code, down: false)
        }
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        sendInput(["type": "text", "text": String(text.prefix(32))])
    }

    private func releaseKeys() {
        for code in heldKeys { sendInput(["type": "key", "code": code, "down": false]) }
        heldKeys.removeAll()
    }

    private func sendSignal(_ value: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { [weak self] error in
            if let error { DispatchQueue.main.async { self?.status = "傳送失敗：\(error.localizedDescription)" } }
        }
    }

    private func sendInput(_ value: [String: Any]) {
        guard controlEnabled else { return }
        if let channel, channel.readyState == .open,
           let data = try? JSONSerialization.data(withJSONObject: value) {
            _ = channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        } else {
            sendSignal(["type": "control", "input": value])
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.socket === task else { return }
            switch result {
            case .success(let message):
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let payload): data = payload
                @unknown default: return
                }
                if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async { self.handleSignal(object) }
                }
                self.receive(on: task)
            case .failure(let error):
                DispatchQueue.main.async {
                    if self.socket === task { self.disconnect(); self.status = "連線中斷：\(error.localizedDescription)" }
                }
            }
        }
    }

    private func handleSignal(_ message: [String: Any]) {
        guard let type = message["type"] as? String else { return }
        switch type {
        case "paired":
            connected = true
            controlAvailable = message["inputEnabled"] as? Bool ?? false
            gamepadAvailable = message["gamepadEnabled"] as? Bool ?? false
            audioAvailable = message["audioEnabled"] as? Bool ?? false
            status = "已配對，等待桌面畫面"
            startPeer()
            startControllerPolling()
        case "description":
            guard message["descriptionType"] as? String == "offer",
                  let sdp = message["sdp"] as? String else { return }
            acceptOffer(sdp)
        case "candidate":
            guard let sdp = message["candidate"] as? String,
                  let mid = message["mid"] as? String else { return }
            if peer?.remoteDescription == nil { pendingCandidates.append((sdp, mid)) }
            else { addRemoteCandidate(sdp: sdp, mid: mid) }
        case "control-state":
            controlEnabled = message["enabled"] as? Bool ?? false
            controlRequested = controlEnabled
            if !controlEnabled { gamepadEnabled = false; gamepadWanted = false }
            status = controlEnabled ? "遠端操作已啟用" : "遠端操作已停用"
        case "gamepad-state":
            gamepadEnabled = message["enabled"] as? Bool ?? false
            gamepadWanted = gamepadEnabled
            status = message["text"] as? String ?? (gamepadEnabled ? "手把已啟用" : "手把已停用")
        case "gamepad-status", "status", "error", "audio-error":
            status = message["text"] as? String ?? type
        case "stats":
            if let width = message["width"] as? Int, width > 0 { videoWidth = width }
            if let height = message["height"] as? Int, height > 0 { videoHeight = height }
        default: break
        }
    }

    private func startPeer() {
        let config = RTCConfiguration()
        config.iceServers = []
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            status = "音訊初始化失敗：\(error.localizedDescription)"
        }
    }

    private func acceptOffer(_ sdp: String) {
        guard let peer else { return }
        remoteMids = sdp.split(separator: "\n").compactMap { line in
            line.hasPrefix("a=mid:") ? String(line.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines) : nil
        }
        peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { [weak self] error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async { self.status = "SDP 設定失敗：\(error.localizedDescription)" }
                return
            }
            for candidate in self.pendingCandidates {
                self.addRemoteCandidate(sdp: candidate.sdp, mid: candidate.mid)
            }
            self.pendingCandidates.removeAll()
            DispatchQueue.main.async { self.attachVideo() }
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            peer.answer(for: constraints) { [weak self] answer, error in
                guard let self, let answer else {
                    DispatchQueue.main.async { self?.status = "WebRTC 回答失敗：\(error?.localizedDescription ?? "未知錯誤")" }
                    return
                }
                peer.setLocalDescription(answer) { error in
                    DispatchQueue.main.async {
                        if let error { self.status = "WebRTC 回答設定失敗：\(error.localizedDescription)" }
                        else {
                            self.sendSignal(["type": "description", "descriptionType": "answer", "sdp": answer.sdp])
                            self.attachVideo()
                        }
                    }
                }
            }
        }
    }

    private func attachVideo() {
        guard let track = peer?.transceivers.first(where: { $0.mediaType == .video })?.receiver.track as? RTCVideoTrack,
              videoTrack !== track else { return }
        videoTrack?.remove(videoView)
        videoTrack = track
        track.add(videoView)
        status = "桌面畫面已接收"
    }

    private func addRemoteCandidate(sdp: String, mid: String) {
        let index = Int32(remoteMids.firstIndex(of: mid) ?? 0)
        let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: mid)
        peer?.add(candidate, completionHandler: { _ in })
    }

    private func startControllerPolling() {
        controllerTimer?.invalidate()
        controllerTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.pollController()
        }
    }

    private func pollController() {
        guard let pad = GCController.controllers().compactMap({ $0.extendedGamepad }).first else {
            if gamepadStatus != "iPad 未偵測到手把" { gamepadStatus = "iPad 未偵測到手把" }
            sendNeutralGamepad()
            return
        }
        if gamepadStatus != "iPad 已偵測到手把" { gamepadStatus = "iPad 已偵測到手把" }
        guard controlEnabled, gamepadEnabled else { return }
        let buttons: [Float] = [
            pad.buttonA.value, pad.buttonB.value, pad.buttonX.value, pad.buttonY.value,
            pad.leftShoulder.value, pad.rightShoulder.value,
            pad.leftTrigger.value, pad.rightTrigger.value,
            pad.buttonOptions?.value ?? 0, pad.buttonMenu.value,
            pad.leftThumbstickButton?.value ?? 0, pad.rightThumbstickButton?.value ?? 0,
            pad.dpad.up.value, pad.dpad.down.value, pad.dpad.left.value, pad.dpad.right.value,
            pad.buttonHome?.value ?? 0
        ]
        let axes: [Float] = [pad.leftThumbstick.xAxis.value, -pad.leftThumbstick.yAxis.value,
                             pad.rightThumbstick.xAxis.value, -pad.rightThumbstick.yAxis.value]
        let state: [String: Any] = ["type": "gamepad", "buttons": buttons, "axes": axes]
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let text = String(data: data, encoding: .utf8) else { return }
        let now = Date()
        if text != lastGamepadJSON || now.timeIntervalSince(lastGamepadSent) >= 0.1 {
            sendInput(state)
            lastGamepadJSON = text
            lastGamepadSent = now
        }
    }

    private func sendNeutralGamepad() {
        guard !lastGamepadJSON.isEmpty, controlEnabled, gamepadEnabled else { return }
        sendInput(["type": "gamepad", "buttons": Array(repeating: 0, count: 17),
                   "axes": Array(repeating: 0, count: 4)])
        lastGamepadJSON = ""
    }
}

extension RemoteSession: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.socket === webSocketTask else { return }
            self.status = "正在配對…"
            self.sendSignal(["type": "pair", "code": self.pairingCode])
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.socket === webSocketTask else { return }
            self.disconnect()
            self.status = "主機已中斷連線（\(closeCode.rawValue)）"
        }
    }
}

extension RemoteSession: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        DispatchQueue.main.async { [weak self] in self?.attachVideo() }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if newState == .connected || newState == .completed { self.attachVideo() }
            if newState == .failed || newState == .disconnected { self.status = "WebRTC 連線中斷" }
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        sendSignal(["type": "candidate", "candidate": candidate.sdp, "mid": candidate.sdpMid ?? "0"])
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        DispatchQueue.main.async { [weak self] in self?.channel = dataChannel }
    }
}
