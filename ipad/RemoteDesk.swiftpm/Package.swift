// swift-tools-version: 5.9
import PackageDescription
import AppleProductTypes

let package = Package(
    name: "RemoteDesk",
    platforms: [.iOS(.v17)],
    products: [
        .iOSApplication(
            name: "RemoteDesk",
            targets: ["AppModule"],
            bundleIdentifier: "tw.johnl.remotedesk",
            displayVersion: "0.1.0",
            bundleVersion: "1",
            supportedDeviceFamilies: [.pad],
            supportedInterfaceOrientations: [.landscapeLeft, .landscapeRight],
            capabilities: [
                .localNetwork(purposeString: "連接同一區網內的 RemoteDesk Windows 主機", bonjourServiceTypes: []),
                .outgoingNetworkConnections()
            ]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "153.0.0")
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            dependencies: [.product(name: "WebRTC", package: "WebRTC")],
            path: "Sources"
        )
    ]
)
