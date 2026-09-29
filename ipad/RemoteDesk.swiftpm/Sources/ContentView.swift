import SwiftUI
import UIKit
import WebRTC

struct ContentView: View {
    @StateObject private var session = RemoteSession()
    @AppStorage("hostIPv4") private var host = "192.168.0.95"
    @State private var code = ""
    @State private var textToSend = ""

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Text("RemoteDesk")
                    .font(.headline)
                TextField("Windows 區網 IPv4", text: $host)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.numbersAndPunctuation)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 180)
                TextField("8 位配對碼", text: $code)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 130)
                if session.connected {
                    Button("斷線") { session.disconnect() }
                } else {
                    Button("連線") { session.connect(host: host, code: code) }
                        .buttonStyle(.borderedProminent)
                }
                Spacer()
                Text(session.status)
                    .font(.caption)
                    .lineLimit(2)
                    .frame(maxWidth: 310, alignment: .trailing)
            }

            RemoteSurface(session: session)
                .background(.black)
                .clipShape(RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 12) {
                Toggle("遠端操作", isOn: Binding(
                    get: { session.controlRequested },
                    set: { session.setControl($0) }
                ))
                .disabled(!session.controlAvailable)
                .fixedSize()

                Button(session.gamepadEnabled ? "停用虛擬手把" : "啟用虛擬手把") {
                    session.setGamepad(!session.gamepadEnabled)
                }
                .disabled(!session.controlEnabled || !session.gamepadAvailable)

                Button("遠端 Win") { session.tapKey("MetaLeft") }
                    .disabled(!session.controlEnabled)
                Button("遠端 F5") { session.tapKey("F5") }
                    .disabled(!session.controlEnabled)

                TextField("傳送文字", text: $textToSend)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 220)
                    .onSubmit {
                        session.sendText(textToSend)
                        textToSend = ""
                    }
                Button("送出") {
                    session.sendText(textToSend)
                    textToSend = ""
                }
                .disabled(!session.controlEnabled)
            }
            .font(.subheadline)

            HStack {
                Text(session.gamepadStatus)
                Spacer()
                Text(session.audioAvailable ? "音訊由 App 自動播放" : "主機未啟用音訊")
                Spacer()
                Text("實體鍵盤：點畫面取得焦點")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(12)
    }
}

struct RemoteSurface: UIViewRepresentable {
    let session: RemoteSession

    func makeUIView(context: Context) -> RemoteSurfaceView {
        RemoteSurfaceView(session: session)
    }

    func updateUIView(_ uiView: RemoteSurfaceView, context: Context) {
        uiView.session = session
    }
}

final class RemoteSurfaceView: UIView {
    var session: RemoteSession
    private let hover = UIHoverGestureRecognizer()
    private let scroll = UIPanGestureRecognizer()
    private var pressedButton = 0

    init(session: RemoteSession) {
        self.session = session
        super.init(frame: .zero)
        backgroundColor = .black
        isMultipleTouchEnabled = false
        session.videoView.contentMode = .scaleAspectFit
        addSubview(session.videoView)
        hover.addTarget(self, action: #selector(hoverChanged(_:)))
        addGestureRecognizer(hover)
        scroll.allowedScrollTypesMask = .all
        scroll.allowedTouchTypes = []
        scroll.addTarget(self, action: #selector(scrollChanged(_:)))
        addGestureRecognizer(scroll)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override var canBecomeFirstResponder: Bool { true }
    override func layoutSubviews() {
        super.layoutSubviews()
        session.videoView.frame = bounds
    }

    private func move(to point: CGPoint) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let ratio = CGFloat(session.videoWidth) / CGFloat(max(1, session.videoHeight))
        let frame: CGRect
        if bounds.width / bounds.height > ratio {
            let width = bounds.height * ratio
            frame = CGRect(x: (bounds.width - width) / 2, y: 0,
                           width: width, height: bounds.height)
        } else {
            let height = bounds.width / ratio
            frame = CGRect(x: 0, y: (bounds.height - height) / 2,
                           width: bounds.width, height: height)
        }
        session.sendPointer(x: (point.x - frame.minX) / frame.width,
                            y: (point.y - frame.minY) / frame.height)
    }

    @objc private func hoverChanged(_ recognizer: UIHoverGestureRecognizer) {
        move(to: recognizer.location(in: self))
    }

    @objc private func scrollChanged(_ recognizer: UIPanGestureRecognizer) {
        let delta = recognizer.translation(in: self).y
        guard abs(delta) >= 8 else { return }
        session.sendWheel(delta > 0 ? -120 : 120)
        recognizer.setTranslation(.zero, in: self)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        becomeFirstResponder()
        if let touch = touches.first { move(to: touch.location(in: self)) }
        pressedButton = event?.buttonMask.contains(.secondary) == true ? 2 : 0
        session.sendButton(pressedButton, down: true)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let touch = touches.first { move(to: touch.location(in: self)) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        session.sendButton(pressedButton, down: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        session.sendButton(pressedButton, down: false)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if let key = press.key, let code = domKeyCode(key) { session.sendKey(code, down: true) }
        }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if let key = press.key, let code = domKeyCode(key) { session.sendKey(code, down: false) }
        }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if let key = press.key, let code = domKeyCode(key) { session.sendKey(code, down: false) }
        }
    }

    private func domKeyCode(_ key: UIKey) -> String? {
        let usage = Int(key.keyCode.rawValue)
        if (4...29).contains(usage) {
            let letter = UnicodeScalar(usage - 4 + 65)!
            return "Key\(Character(letter))"
        }
        if (30...38).contains(usage) { return "Digit\(usage - 29)" }
        if usage == 39 { return "Digit0" }
        if (58...69).contains(usage) { return "F\(usage - 57)" }
        let named: [Int: String] = [
            40: "Enter", 41: "Escape", 42: "Backspace", 43: "Tab", 44: "Space",
            45: "Minus", 46: "Equal", 47: "BracketLeft", 48: "BracketRight",
            49: "Backslash", 51: "Semicolon", 52: "Quote", 53: "Backquote",
            54: "Comma", 55: "Period", 56: "Slash", 57: "CapsLock",
            73: "Insert", 74: "Home", 75: "PageUp", 76: "Delete",
            77: "End", 78: "PageDown", 79: "ArrowRight", 80: "ArrowLeft",
            81: "ArrowDown", 82: "ArrowUp",
            224: "ControlLeft", 225: "ShiftLeft", 226: "AltLeft", 227: "MetaLeft",
            228: "ControlRight", 229: "ShiftRight", 230: "AltRight", 231: "MetaRight"
        ]
        return named[usage]
    }
}
