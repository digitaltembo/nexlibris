// swift-tools-version: 6.0
import PackageDescription

/// The iOS app's native side, apart from its UIKit shell (ios/App): storage, the bridge's
/// endpoints, serving the web app, and Bluetooth. Only Foundation, WebKit and CoreBluetooth, so it
/// builds for macOS too, and `swift test` runs its tests without a simulator.
let package = Package(
    name: "NexlibrisKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "NexlibrisKit", targets: ["NexlibrisKit"])],
    targets: [
        .target(name: "NexlibrisKit"),
        .testTarget(name: "NexlibrisKitTests", dependencies: ["NexlibrisKit"]),
    ],
    swiftLanguageModes: [.v5]
)
