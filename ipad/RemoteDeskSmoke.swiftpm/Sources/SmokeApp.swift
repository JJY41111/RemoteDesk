import SwiftUI

@main
struct SmokeApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("RemoteDesk 基礎啟動測試")
                    .font(.largeTitle)
                Text("看到這行代表 SwiftUI App 可在這台 iPad 啟動。")
            }
            .onAppear { print("RemoteDesk smoke: SwiftUI launched") }
        }
    }
}
