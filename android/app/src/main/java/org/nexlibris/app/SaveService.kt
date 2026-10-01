package org.nexlibris.app

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.Base64

/**
 * Saving files out of the app: the native side of common/src/saveApi.ts. A
 * file arrives in chunks under a token, into [dir]; [save] then asks the user
 * where it should go and copies it there.
 *
 * Not thread-safe; [NativeBridge] runs every call on one thread.
 */
class SaveService(
    private val dir: File,
    /** Asks the user where to save; null if they cancel. Blocks until they choose. */
    private val chooseDestination: (name: String, mimeType: String) -> OutputStream?,
) {
    init {
        // Anything here is from an earlier run that never finished.
        dir.deleteRecursively()
        dir.mkdirs()
    }

    fun chunk(token: String, data: String, first: Boolean) {
        val file = upload(token)
        if (first) file.delete() else require(file.isFile) { "No upload in progress: $token" }
        FileOutputStream(file, true).use { it.write(Base64.getDecoder().decode(data)) }
    }

    /** True if saved, false if the user cancelled. The upload is discarded either way. */
    fun save(token: String, name: String, mimeType: String): Boolean {
        val file = upload(token)
        require(file.isFile) { "No upload in progress: $token" }
        try {
            val out = chooseDestination(name, mimeType) ?: return false
            out.use { destination -> file.inputStream().use { it.copyTo(destination) } }
            return true
        } finally {
            file.delete()
        }
    }

    private fun upload(token: String): File {
        require(TOKEN.matches(token)) { "Bad token: $token" }
        return File(dir, token)
    }

    private companion object {
        val TOKEN = Regex("[A-Za-z0-9-]{1,64}")
    }
}
