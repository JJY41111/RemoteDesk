import SwiftUI

@main
struct RemoteDeskApp: App {
    @State private var showRemote = false

    var body: some Scene {
        WindowGroup {
            Group {
                if showRemote {
                    ContentView()
                        .onAppear { print("RemoteDesk diagnostic: remote UI appeared") }
                } else {
                    VStack(spacing: 18) {
                        Text("RemoteDesk")
                            .font(.largeTitle)
                        Text("原生 App 已啟動")
                        Button("開啟遠端介面") {
                            print("RemoteDesk diagnostic: opening remote UI")
                            showRemote = true
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .onAppear { print("RemoteDesk diagnostic: launch screen appeared") }
                }
            }
        }
    }
}
