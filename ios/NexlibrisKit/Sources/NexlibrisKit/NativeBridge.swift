import Foundation
import WebKit

/**
 * The bridge to the web app: a script message handler with replies, `nexlibris`, which the page
 * reaches as `window.webkit.messageHandlers.nexlibris` (see client/src/backends/iosBridge.ts).
 * Each message is a JSON estuary-rpc request; the reply, which the page's `postMessage` promise
 * resolves with, is the JSON response (`{ok, value}` or `{ok: false, message}`).
 *
 * Only the main frame on the app's own origin is answered (book content shown in frames is
 * not). Requests run one at a time, off the main thread, in the order they arrive; calls to a sync
 * hub (the peer API) run on a queue of their own, so a slow network doesn't hold up the library,
 * and Bluetooth hosting calls each on a thread of their own, as the page waits on events while it
 * sends. As Android's `NativeBridge.kt`.
 */
public final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    public static let name = "nexlibris"

    private let router: RpcRouter
    private let queue = DispatchQueue(label: "org.nexlibris.bridge")
    private let peerQueue = DispatchQueue(label: "org.nexlibris.bridge.peer")
    private let bluetoothQueue = DispatchQueue(label: "org.nexlibris.bridge.bluetooth", attributes: .concurrent)

    public init(router: RpcRouter) {
        self.router = router
    }

    public func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == AppOrigin.scheme, origin.host == AppOrigin.host else {
            return replyHandler(nil, "Not allowed")
        }
        guard let text = message.body as? String, let request = parseObject(text) else {
            return replyHandler(nil, "Unreadable bridge message")
        }
        let url = request["url"] as? String ?? ""
        let runOn = url.hasPrefix("api/peer/") ? peerQueue : url.hasPrefix("api/bluetoothHost/") ? bluetoothQueue : queue
        runOn.async { [router] in
            let reply = router.reply(to: request)
            DispatchQueue.main.async { replyHandler(reply, nil) }
        }
    }
}
