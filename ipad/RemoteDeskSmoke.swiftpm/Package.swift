// swift-tools-version: 5.9
import PackageDescription
import AppleProductTypes

let package = Package(
    name: "RemoteDeskSmoke",
    platforms: [.iOS(.v17)],
    products: [
        .iOSApplication(
            name: "RemoteDeskSmoke",
            targets: ["AppModule"],
            bundleIdentifier: "tw.johnl.remotedesk.smoke",
            displayVersion: "0.1.0",
            bundleVersion: "1",
            supportedDeviceFamilies: [.pad],
            supportedInterfaceOrientations: [.landscapeLeft, .landscapeRight],
            capabilities: [
                .localNetwork(purposeString: "測試 RemoteDesk iPad App 啟動", bonjourServiceTypes: []),
                .outgoingNetworkConnections()
            ]
        )
    ],
    targets: [
        .executableTarget(name: "AppModule", path: "Sources")
    ]
)
