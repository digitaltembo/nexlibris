package org.nexlibris.app

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * Serves the library's stored files (covers, books) to the web app at `/library/files/…`, and the
 * thumbnails made of covers at `/library/local/thumbs/…`, so it can fetch them directly instead of
 * reading them through the bridge as base64 chunks. In a folder of the user's, the books placed in
 * it are served too, and its own files under `/library/.nexlibris/` (as the desktop app serves them,
 * `servedLibraryPath` in common/src/placedLibrary.ts). Only those: never library.json and the like.
 * [library] gives the open library's storage, and whether it's laid out in a folder.
 */
class LibraryFilesPathHandler(private val library: () -> Pair<LibraryTree, Boolean>) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val (tree, placed) = library()
        val input = servedFile(tree, placed, path)
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        // A placed book can be renamed, and its path then names another file; stored files never change.
        val headers = if (placed && !path.startsWith(".nexlibris/")) mapOf("Cache-Control" to "no-cache") else IMMUTABLE
        return WebResourceResponse("application/octet-stream", null, 200, "OK", headers, input)
    }

    private companion object {
        // Content-addressed, so a file at a path never changes.
        val IMMUTABLE = mapOf("Cache-Control" to "private, max-age=31536000, immutable")
    }
}

/** The library paths the page may fetch: `servedLibraryPath` in common/src/placedLibrary.ts. */
fun servedLibraryPath(path: String, placed: Boolean): Boolean {
    val data = "${LibraryFolderService.DATA_DIR}/"
    if (placed && !path.startsWith(data)) return !path.startsWith(".") && !path.contains("/.")
    val inner = if (placed) path.removePrefix(data) else path
    return inner.startsWith("files/") || inner.startsWith("local/thumbs/")
}

/** The file a `/library/` path names (e.g. `files/ab/abcd…`), or null if there's none or it isn't served. */
fun servedFile(tree: LibraryTree, placed: Boolean, path: String): InputStream? {
    val relative = path.substringBefore('?')
    if (!servedLibraryPath(relative, placed)) return null
    return try {
        tree.open(relative)
    } catch (e: IllegalArgumentException) {
        null
    }
}
