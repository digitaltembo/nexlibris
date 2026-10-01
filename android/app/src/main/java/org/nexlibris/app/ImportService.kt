package org.nexlibris.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream

/** A file the user picked: its name, and a way to read it. */
class PickedSource(val name: String, val open: () -> InputStream)

/**
 * Importing files: the native side of common/src/importApi.ts. Picked files are copied
 * straight into the library's stored files, so the web app reads them from
 * `/library/files/…` rather than through the system's document provider and the bridge.
 *
 * Not thread-safe; [NativeBridge] runs every call on one thread.
 */
class ImportService(
    private val storage: StorageService,
    /** Shows the system's picker and blocks until the user chooses; empty if they cancel. */
    private val choose: () -> List<PickedSource>,
) {
    /** `{files: [{name, hash, size}], skipped: [{name, reason}]}`, as the web app expects. */
    fun pick(extensions: List<String>): JSONObject {
        val suffixes = extensions.map { ".${it.lowercase()}" }
        val files = JSONArray()
        val skipped = JSONArray()
        for (source in choose()) {
            if (suffixes.none { source.name.lowercase().endsWith(it) }) {
                skipped.put(JSONObject().put("name", source.name).put("reason", "unsupported file type"))
                continue
            }
            try {
                val stored = source.open().use { storage.putStream(it) }
                files.put(JSONObject().put("name", source.name).put("hash", stored.hash).put("size", stored.size))
            } catch (e: Exception) {
                skipped.put(JSONObject().put("name", source.name).put("reason", e.message ?: e.toString()))
            }
        }
        return JSONObject().put("files", files).put("skipped", skipped)
    }
}
