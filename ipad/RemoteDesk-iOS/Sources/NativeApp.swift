import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "RemoteDesk", sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        self.window = window
        NativeWindow.shared.attach(window)
        window.makeKeyAndVisible()
    }
    func sceneDidDisconnect(_ scene: UIScene) { NativeWindow.shared.close() }
}

// The receiver is the actual window root, not a Playgrounds presentation.
final class NativeWindow {
    static let shared = NativeWindow()
    private weak var window: UIWindow?
    private var receiver: PointerController?
    func attach(_ window: UIWindow) {
        self.window = window
        window.rootViewController = LaunchController()
    }
    func open(_ url: URL) {
        guard let window else { return }
        receiver?.shutdown()
        let receiver = PointerController(url: url)
        self.receiver = receiver
        window.rootViewController = receiver
        window.makeKeyAndVisible()
    }
    func close() {
        receiver?.shutdown()
        receiver = nil
        window?.rootViewController = LaunchController()
    }
}

final class LaunchController: UIViewController, UITextFieldDelegate {
    private let address = UITextField()
    private let status = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "RemoteDesk App · 0.4.0"
        title.font = .boldSystemFont(ofSize: 28)
        let detail = UILabel()
        detail.text = "輸入主機 HTTPS 網址。跨區使用前先連線 Tailscale。\n配對後啟用遠端操作；鍵盤、滑鼠與手把可同時使用。"
        detail.numberOfLines = 0
        address.borderStyle = .roundedRect
        address.placeholder = "https://主機位址:9443/"
        address.text = UserDefaults.standard.string(forKey: "serverAddress")
        address.keyboardType = .URL
        address.autocapitalizationType = .none
        address.autocorrectionType = .no
        address.returnKeyType = .go
        address.delegate = self
        let button = UIButton(type: .system)
        button.setTitle("開啟遠端介面", for: .normal)
        button.addTarget(self, action: #selector(open), for: .touchUpInside)
        status.numberOfLines = 0
        status.text = "正式安裝測試版。游標是否鎖定，以接收器頂端狀態為準。"
        let stack = UIStackView(arrangedSubviews: [title, detail, address, button, status])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 600),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            address.heightAnchor.constraint(equalToConstant: 48)
        ])
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { open(); return true }
    @objc private func open() {
        let value = (address.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else {
            status.text = "請輸入完整 HTTPS 網址，不要附上帳號或密碼。"
            return
        }
        view.endEditing(true)
        UserDefaults.standard.set(value, forKey: "serverAddress")
        NativeWindow.shared.open(url)
    }
}
