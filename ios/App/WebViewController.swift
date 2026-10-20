import NexlibrisKit
import UIKit
import WebKit

/**
 * Hosts the web app in a WKWebView, as Android's MainActivity does in a WebView. The app is served
 * by [AppSchemeHandler] at `app://nexlibris/` (a secure origin of the app's own, so modules,
 * workers and storage behave as on https), and its library is stored in the app's files, or a
 * folder the user picks in Files ([LibraryFolderService]), through [NativeBridge] rather than in
 * the web view's storage.
 */
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private lazy var pickers = Pickers(self)
    private var bluetoothHost: BluetoothHostService?
    private var darkBars = false

    override var preferredStatusBarStyle: UIStatusBarStyle { darkBars ? .lightContent : .darkContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        do {
            try load()
        } catch {
            showFailure(error)
        }
    }

    private func load() throws {
        let files = FileManager.default
        let support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let caches = files.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let documents = files.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let defaults = UserDefaults.standard
        guard let webApp = Bundle.main.url(forResource: "www", withExtension: nil) else {
            throw NexlibrisError("The web app isn’t in this build. Run npm run build, then build the app again.")
        }

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let syncFolders = SyncFolderService(defaults) { [pickers] in pickers.folder(startingAt: documents) }
        let library = LibraryFolderService(
            home: try FileStorage(root: support.appendingPathComponent("libraries/default", isDirectory: true)),
            // The library's folder starts in the app's own folder in Files, where one can be made.
            folders: BookmarkedFolders(Bookmarks(defaults, key: "libraryFolders")) { [pickers] in pickers.folder(startingAt: documents) },
            chosen: DefaultsSetting(defaults, key: "libraryFolder"),
            reload: { [weak self] in DispatchQueue.main.async { self?.webView.reload() } }
        )
        configuration.setURLSchemeHandler(AppSchemeHandler(webApp: webApp) { (library.root, library.placed) }, forURLScheme: AppOrigin.scheme)

        let saves = try SaveService(dir: caches.appendingPathComponent("saves")) { [pickers] file, _ in pickers.export(file) }
        let imports = ImportService(storage: { library.data }) { [pickers] folder in Self.chooseImportSources(pickers, folder: folder) }
        let bluetoothHost = BluetoothHostService(defaults: defaults)
        self.bluetoothHost = bluetoothHost
        let bridge = NativeBridge(router: RpcRouter(
            storageRoutes("api/storage") { library.root },
            libraryFolderRoutes(library),
            saveRoutes(saves),
            importRoutes(imports),
            peerRoutes(PeerService { library.data }),
            localHttpRoutes(try LocalHttpService(dir: caches.appendingPathComponent("local-http"))),
            bluetoothHostRoutes(bluetoothHost),
            usbFolderRoutes(folder: syncFolders.folder, library: { library.data }, info: syncFolders.info, choose: syncFolders.choose),
            windowRoutes { [weak self] background, dark in DispatchQueue.main.async { self?.setBarColors(background, dark: dark) } }
        ))
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // The page keeps clear of the screen's edges itself (below), so the scroll view adds no insets of its own.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // Below the status bar, and down to the screen's bottom, or above the keyboard while it's up (as
        // Android's adjustResize). Across the whole width: the page keeps clear of the notch and the home
        // indicator itself (`--safe-*`, from env(safe-area-inset-*), in client/src/styles/GlobalStyle.ts).
        // iOS 16's keyboard guide always stops at the home indicator, so there the page stops there too.
        if #available(iOS 17.0, *) { view.keyboardLayoutGuide.usesBottomSafeArea = false }
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])

        bluetoothHost.resume()
        webView.load(URLRequest(url: AppOrigin.start))
    }

    /// Files, or a folder's files with their paths, to import; let go of once they're stored.
    private static func chooseImportSources(_ pickers: Pickers, folder: Bool) -> Picked {
        if folder {
            guard let url = pickers.folder() else { return Picked([]) }
            let entered = url.startAccessingSecurityScopedResource()
            return Picked(folderFiles(url)) { if entered { url.stopAccessingSecurityScopedResource() } }
        }
        let urls = pickers.files()
        let entered = urls.filter { $0.startAccessingSecurityScopedResource() }
        let sources = urls.map { url in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            return PickedSource(name: url.lastPathComponent, size: size) {
                guard let stream = InputStream(url: url) else { throw NexlibrisError("Couldn’t open \(url.lastPathComponent)") }
                return stream
            }
        }
        return Picked(sources) { entered.forEach { $0.stopAccessingSecurityScopedResource() } }
    }

    /// Paints behind the status bar and home indicator, which the page doesn't cover, in the page's colour, with a status bar to suit.
    private func setBarColors(_ background: RGB, dark: Bool) {
        view.backgroundColor = UIColor(red: background.red, green: background.green, blue: background.blue, alpha: 1)
        darkBars = dark
        setNeedsStatusBarAppearanceUpdate()
    }

    private func showFailure(_ error: Error) {
        let label = UILabel()
        label.text = messageOf(error)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    // MARK: Navigation

    /// Schemes book content's frames are made of, which stay in the app.
    private static let framed: Set<String> = ["about", "blob", "data"]

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if AppOrigin.contains(url) || (Self.framed.contains(url.scheme ?? "") && action.targetFrame?.isMainFrame == false) {
            return decisionHandler(.allow)
        }
        // Links out of the app (e.g. in book descriptions) open in the browser; nothing else leaves.
        if action.navigationType == .linkActivated || action.targetFrame?.isMainFrame != false {
            openOutside(url)
        }
        decisionHandler(.cancel)
    }

    /// `target="_blank"` and `window.open`: out of the app, as other links.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, !AppOrigin.contains(url) { openOutside(url) }
        return nil
    }

    private func openOutside(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) else { return }
        UIApplication.shared.open(url)
    }

    /// The web content process ended (iOS reclaims it under memory pressure): start the page again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // The camera, for scanning ISBN barcodes. Only the app's own pages get it, and nothing else is granted.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let ours = origin.protocol == AppOrigin.scheme && origin.host == AppOrigin.host && frame.isMainFrame
        decisionHandler(ours && type == .camera ? .grant : .deny)
    }
}
