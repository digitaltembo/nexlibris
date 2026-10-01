package org.nexlibris.app

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The WebView JavaScript interface, exposed as `window.NexlibrisAndroid`
 * (see client/src/backends/androidBridge.ts). Each call is a JSON estuary-rpc
 * request with an id; the answer goes back asynchronously through
 * `window.__nexlibrisBridge.settle(id, responseJson)`.
 *
 * Requests run one at a time, off the main thread, in the order they arrive.
 */
class NativeBridge(
    private val webView: WebView,
    private val router: StorageRouter,
    /** Whether the page is the app's own; anything else gets no answers. */
    private val isTrustedPage: () -> Boolean,
) {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun call(message: String) {
        if (!isTrustedPage()) {
            Log.w(TAG, "Ignoring bridge call from a page outside the app")
            return
        }
        executor.execute {
            val request = try {
                JSONObject(message)
            } catch (e: Exception) {
                Log.w(TAG, "Unreadable bridge call", e)
                return@execute
            }
            val id = request.optLong("id", -1)
            if (id < 0) return@execute
            val response = router.handle(request)
            // A JSON string literal is a JavaScript string literal, so the response passes through unparsed.
            val script = "window.__nexlibrisBridge && window.__nexlibrisBridge.settle($id, ${JSONObject.quote(response.toString())})"
            main.post { webView.evaluateJavascript(script, null) }
        }
    }

    fun shutdown() = executor.shutdown()

    private companion object {
        const val TAG = "NativeBridge"
    }
}
