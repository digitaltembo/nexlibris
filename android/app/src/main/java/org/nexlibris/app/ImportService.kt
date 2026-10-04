package org.nexlibris.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.util.UUID

/**
 * A file the user picked: its name, its size if the system knows it (else 0), and a way to read
 * it. In a folder pick, [path] is where it is, from the folder's name on
 * (`Calibre Library/Frank Herbert/Dune (7)/Dune.epub`).
 */
class PickedSource(val name: String, val path: String? = null, val size: Long = 0, val open: () -> InputStream)

/**
 * Importing files: the native side of common/src/importApi.ts. Picked files are copied
 * straight into the library's stored files, so the web app reads them from
 * `/library/files/…` rather than through the system's document provider and the bridge.
 * [pick] lists what was chosen; [store] copies it a batch at a time, so the page can show progress.
 *
 * Not thread-safe; [NativeBridge] runs every call on one thread.
 */
class ImportService(
    private val storage: StorageService,
    /**
     * Shows the system's picker, for files or (when passed true) a folder, and blocks until the user
     * chooses; empty if they cancel. A folder's files, hidden ones left out, come with their paths.
     */
    private val choose: (folder: Boolean) -> List<PickedSource>,
) {
    /** The latest pick, for [store]. */
    private var latest: Pair<String, List<PickedSource>>? = null

    /**
     * `{token, files: [{name, path?, size}], skipped: [{name, reason}]}`, as the web app expects. In a
     * folder pick, files with [names] are taken too, and skipped files are named by their path.
     */
    fun pick(extensions: List<String>, folder: Boolean = false, names: List<String> = emptyList()): JSONObject {
        val suffixes = extensions.map { ".${it.lowercase()}" }
        val wanted = names.map { it.lowercase() }.toSet()
        val chosen = mutableListOf<PickedSource>()
        val skipped = JSONArray()
        for (source in choose(folder)) {
            val lower = source.name.lowercase()
            if (suffixes.none { lower.endsWith(it) } && !(folder && lower in wanted)) {
                skipped.put(JSONObject().put("name", source.path ?: source.name).put("reason", "unsupported file type"))
            } else {
                chosen.add(source)
            }
        }
        val token = UUID.randomUUID().toString()
        latest = token to chosen
        val files = JSONArray()
        for (source in chosen) files.put(describe(source).put("size", source.size))
        return JSONObject().put("token", token).put("files", files).put("skipped", skipped)
    }

    /** `{files: [{name, path?, hash, size}], skipped, next}`: the next batch of the latest pick, stored. */
    fun store(token: String, start: Int): JSONObject {
        val (current, chosen) = latest ?: throw IllegalStateException(REPLACED)
        if (current != token) throw IllegalStateException(REPLACED)
        val files = JSONArray()
        val skipped = JSONArray()
        var next = start
        var bytes = 0L
        while (next < chosen.size && next - start < BATCH_FILES && bytes < BATCH_BYTES) {
            val source = chosen[next++]
            try {
                val stored = source.open().use { storage.putStream(it) }
                files.put(describe(source).put("hash", stored.hash).put("size", stored.size))
                bytes += stored.size
            } catch (e: Exception) {
                skipped.put(JSONObject().put("name", source.path ?: source.name).put("reason", e.message ?: e.toString()))
            }
        }
        if (next >= chosen.size) latest = null
        return JSONObject().put("files", files).put("skipped", skipped).put("next", next)
    }

    private fun describe(source: PickedSource) = JSONObject().put("name", source.name).also { file ->
        source.path?.let { file.put("path", it) }
    }

    companion object {
        /** As STORE_BATCH_FILES and STORE_BATCH_BYTES in importApi.ts. */
        const val BATCH_FILES = 50
        const val BATCH_BYTES = 32L * 1024 * 1024
        const val REPLACED = "This import was replaced by another; pick the files again."
    }
}
