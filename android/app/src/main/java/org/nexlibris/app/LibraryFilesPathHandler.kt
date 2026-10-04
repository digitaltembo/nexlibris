package org.nexlibris.app

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Serves the library's stored files (covers, books) to the web app at
 * `/library/files/…`, and the thumbnails made of covers at `/library/local/thumbs/…`,
 * so it can fetch them directly instead of reading them through the bridge as
 * base64 chunks. Only those are served: they're named by the content they hold
 * (a thumbnail by its cover's hash) and never change, unlike library.json.
 */
class LibraryFilesPathHandler(private val storage: StorageService) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val file = storedFile(storage, path)
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        return WebResourceResponse("application/octet-stream", null, 200, "OK", HEADERS, file.inputStream())
    }

    private companion object {
        // Content-addressed, so a file at a path never changes.
        val HEADERS = mapOf("Cache-Control" to "private, max-age=31536000, immutable")
    }
}

/** The parts of the library the page may fetch: stored files, and the thumbnails made of covers. */
private val SERVED_PATHS = listOf("files/", "local/thumbs/")

/** The stored file a `/library/` path names (e.g. `files/ab/abcd…`), or null if there's none or it isn't allowed. */
fun storedFile(storage: StorageService, path: String): File? {
    val relative = path.substringBefore('?')
    if (SERVED_PATHS.none { relative.startsWith(it) }) return null
    val file = try {
        storage.resolve(relative)
    } catch (e: IllegalArgumentException) {
        return null
    }
    return file.takeIf { it.isFile }
}
