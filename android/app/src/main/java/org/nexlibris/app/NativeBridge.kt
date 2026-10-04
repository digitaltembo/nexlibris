package org.nexlibris.app

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The bridge to the web app, exposed as `window.NexlibrisAndroid` (see
 * client/src/backends/androidBridge.ts). Each message is a JSON estuary-rpc
 * request with an id; the answer is posted back as `{id, response}`.
 *
 * Registered with an allowed-origin list, so WebView only gives the object to
 * the app's own pages: no origin check of our own is needed (or could race).
 * Requests run one at a time, off the main thread, in the order they arrive; calls to a sync hub
 * (the peer API) run on a thread of their own, so a slow network doesn't hold up the library, and
 * Bluetooth hosting calls each on a thread of their own, as the page waits on events while it sends.
 */
class NativeBridge(private val router: RpcRouter) : WebViewCompat.WebMessageListener {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val peerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val bluetoothExecutor: ExecutorService = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    // Messages only arrive if MainActivity registered this listener, which it does only when WEB_MESSAGE_LISTENER is supported.
    @SuppressLint("RequiresFeature")
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame) return
        val text = message.data ?: return
        val request = try {
            JSONObject(text)
        } catch (e: Exception) {
            Log.w(TAG, "Unreadable bridge message", e)
            return
        }
        val id = request.optLong("id", -1)
        if (id < 0) return
        val url = request.optString("url")
        val runOn = when {
            url.startsWith("api/peer/") -> peerExecutor
            url.startsWith("api/bluetoothHost/") -> bluetoothExecutor
            else -> executor
        }
        runOn.execute {
            val reply = JSONObject().put("id", id).put("response", router.handle(request)).toString()
            main.post { replyProxy.postMessage(reply) }
        }
    }

    fun shutdown() {
        executor.shutdown()
        peerExecutor.shutdown()
        bluetoothExecutor.shutdownNow()
    }

    private companion object {
        const val TAG = "NativeBridge"
    }
}
