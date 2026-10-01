package org.nexlibris.app

import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64

/**
 * The library's files on the device: the native side of the storage API in
 * common/src/storageApi.ts. Paths are slash-separated and relative to [root].
 *
 * Not thread-safe; [NativeBridge] runs every call on one thread.
 */
class StorageService(root: File) {
    private val root: File = root.canonicalFile

    init {
        this.root.mkdirs()
    }

    fun readText(path: String): String? = resolve(path).takeIf { it.isFile }?.readText()

    fun writeText(path: String, text: String) = replace(resolve(path)) { it.writeText(text) }

    fun appendText(path: String, text: String) {
        val file = resolve(path)
        file.parentFile?.mkdirs()
        FileOutputStream(file, true).use { out ->
            out.write(text.toByteArray())
            // The change log is appended to; make each append durable before reporting success.
            out.fd.sync()
        }
    }

    fun exists(path: String): Boolean = resolve(path).isFile

    fun size(path: String): Long? = resolve(path).takeIf { it.isFile }?.length()

    /** Base64 of up to [length] bytes starting at [offset]. */
    fun readChunk(path: String, offset: Long, length: Int): String {
        require(offset >= 0 && length >= 0) { "Bad range: $offset+$length" }
        val file = resolve(path)
        if (!file.isFile) throw FileNotFoundException("No file: $path")
        RandomAccessFile(file, "r").use { input ->
            val available = (input.length() - offset).coerceIn(0, length.toLong()).toInt()
            val bytes = ByteArray(available)
            input.seek(offset)
            input.readFully(bytes)
            return Base64.getEncoder().encodeToString(bytes)
        }
    }

    /**
     * Appends a chunk to an upload in progress, which replaces the file at [path]
     * only once the [last] chunk arrives, so readers never see a partial file.
     */
    fun writeChunk(path: String, data: String, first: Boolean, last: Boolean) {
        val file = resolve(path)
        val upload = uploadFile(file)
        if (first) {
            file.parentFile?.mkdirs()
            upload.delete()
        } else {
            require(upload.isFile) { "No upload in progress: $path" }
        }
        FileOutputStream(upload, true).use { it.write(Base64.getDecoder().decode(data)) }
        if (last) commit(upload, file)
    }

    /** The file for a library path, refusing anything that would leave [root]. */
    fun resolve(path: String): File {
        val segments = path.split('/')
        require(path.isNotEmpty() && segments.none { it.isEmpty() || it == "." || it == ".." }) { "Bad path: $path" }
        val file = File(root, path)
        // Also catches symlinks pointing outside the library.
        require(file.canonicalPath.startsWith(root.path + File.separator)) { "Bad path: $path" }
        return file
    }

    private fun uploadFile(file: File) = File(file.parentFile, ".${file.name}.upload")

    private fun replace(file: File, write: (File) -> Unit) {
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, ".${file.name}.tmp")
        write(temp)
        commit(temp, file)
    }

    private fun commit(temp: File, file: File) {
        FileOutputStream(temp, true).use { it.fd.sync() }
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }
}
