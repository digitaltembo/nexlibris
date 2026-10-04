package org.nexlibris.app

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.security.DigestInputStream
import java.security.MessageDigest
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
class StorageService(root: File) : PathStorage {
    private val root: File = root.canonicalFile

    init {
        this.root.mkdirs()
    }

    override fun readText(path: String): String? = resolve(path).takeIf { it.isFile }?.readText()

    override fun writeText(path: String, text: String) = replace(resolve(path)) { it.writeText(text) }

    override fun appendText(path: String, text: String) {
        val file = resolve(path)
        file.parentFile?.mkdirs()
        FileOutputStream(file, true).use { out ->
            out.write(text.toByteArray())
            // The change log is appended to; make each append durable before reporting success.
            out.fd.sync()
        }
    }

    override fun exists(path: String): Boolean = resolve(path).isFile

    override fun size(path: String): Long? = resolve(path).takeIf { it.isFile }?.length()

    /** Base64 of up to [length] bytes starting at [offset]. */
    override fun readChunk(path: String, offset: Long, length: Int): String {
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
    override fun writeChunk(path: String, data: String, first: Boolean, last: Boolean) {
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

    /**
     * Stores [input] as a content-addressed file, where common/src/backend.ts keeps them
     * ([storedFilePath]), hashing it as it's copied. Storing contents already there is a no-op.
     * With [expected], contents with any other hash are discarded and it throws.
     */
    override fun putStream(input: InputStream, expected: String?): StoredFile {
        val files = resolve("files")
        files.mkdirs()
        val temp = File.createTempFile(".put", ".tmp", files)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val size = DigestInputStream(input, digest).use { source ->
                FileOutputStream(temp).use { out ->
                    val copied = source.copyTo(out)
                    out.fd.sync()
                    copied
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (expected != null && hash != expected) {
                throw IOException("The file's contents don't match its hash (expected ${expected.take(12)}…, got ${hash.take(12)}…).")
            }
            val file = resolve(storedFilePath(hash))
            if (file.isFile) {
                temp.delete()
            } else {
                file.parentFile?.mkdirs()
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
            }
            return StoredFile(hash, size)
        } finally {
            temp.delete()
        }
    }

    override fun list(path: String): List<String> = resolve(path).list()?.filterNot { it.startsWith(".") }?.sorted() ?: emptyList()

    override fun remove(path: String) {
        resolve(path).delete()
    }

    override fun openStored(hash: String): InputStream {
        val file = resolve(storedFilePath(hash))
        if (!file.isFile) throw FileNotFoundException("That file isn’t stored here.")
        return file.inputStream()
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

data class StoredFile(val hash: String, val size: Long)

/** Where a stored file lives, by hash: `storedFilePath` in common/src/importApi.ts. */
fun storedFilePath(hash: String) = "files/${hash.take(2)}/$hash"
