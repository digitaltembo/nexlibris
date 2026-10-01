package org.nexlibris.app

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the built web app (client/dist, copied into assets/www) with the MIME
 * types modules and WebAssembly need. Paths without an extension get index.html.
 */
class WebAppPathHandler(private val assets: AssetManager) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val file = path.substringBefore('?').ifEmpty { INDEX }
        if (file.split('/').any { it == ".." }) return notFound()
        val extension = file.substringAfterLast('.', "")
        return try {
            open(file)
        } catch (e: IOException) {
            if (extension.isEmpty()) open(INDEX) else notFound()
        }
    }

    private fun open(file: String): WebResourceResponse {
        val type = MIME_TYPES[file.substringAfterLast('.', "")] ?: "application/octet-stream"
        val encoding = if (type.startsWith("text/") || type == "application/json") "utf-8" else null
        return WebResourceResponse(type, encoding, assets.open("www/$file"))
    }

    private fun notFound() =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private companion object {
        const val INDEX = "index.html"
        val MIME_TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "map" to "application/json",
            "wasm" to "application/wasm",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "ico" to "image/x-icon",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "ttf" to "font/ttf",
            "txt" to "text/plain",
        )
    }
}
