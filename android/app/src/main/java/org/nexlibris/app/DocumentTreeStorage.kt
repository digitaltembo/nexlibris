package org.nexlibris.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.Base64

/**
 * Storage in the user's sync folder, a folder in shared storage (say Documents/nexlibris-sync) picked
 * with the system's folder picker, which a computer sees when the phone is plugged in by USB. It's
 * reached through the storage provider rather than as files, so it works whoever wrote what's in
 * it: files copied in over USB belong to another user, which the app couldn't open directly.
 *
 * Only folders on the device's own storage (ExternalStorageProvider) are taken: their document ids
 * are paths, so a file's id is the folder's plus its path, with no lookups.
 */
class DocumentTreeStorage(private val resolver: ContentResolver, private val tree: Uri) : PathStorage {
    private val rootId: String = DocumentsContract.getTreeDocumentId(tree)

    init {
        require(tree.authority == EXTERNAL_STORAGE) { "Choose a folder on this phone’s storage." }
    }

    /** Where it is, as a computer browsing the phone sees it, e.g. "Documents/nexlibris-sync". */
    val where: String get() = rootId.substringAfter(':').ifEmpty { "the phone’s storage" }

    private fun id(path: String): String {
        val segments = path.split('/')
        require(path.isNotEmpty() && segments.none { it.isEmpty() || it == "." || it == ".." }) { "Bad path: $path" }
        return if (rootId.endsWith(":")) "$rootId$path" else "$rootId/$path"
    }

    private fun uri(path: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, id(path))

    private fun dirUri(path: String): Uri = if (path.isEmpty()) DocumentsContract.buildDocumentUriUsingTree(tree, rootId) else uri(path)

    /** The document's size and whether it's a folder, or null if there's none. */
    private fun stat(path: String): Pair<Long, Boolean>? = try {
        resolver.query(uri(path), arrayOf(DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)
            ?.use { if (it.moveToFirst()) it.getLong(0) to (it.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR) else null }
    } catch (_: Exception) {
        // The provider says a missing document isn't found by throwing.
        null
    }

    override fun exists(path: String): Boolean = stat(path)?.second == false

    override fun size(path: String): Long? = stat(path)?.takeIf { !it.second }?.first

    override fun readText(path: String): String? =
        if (exists(path)) resolver.openInputStream(uri(path))?.use { it.readBytes().toString(Charsets.UTF_8) } else null

    override fun writeText(path: String, text: String) = replace(path) { out -> out.write(text.toByteArray()) }

    override fun appendText(path: String, text: String) {
        if (!exists(path)) create(path)
        (resolver.openOutputStream(uri(path), "wa") ?: throw IOException("Couldn't open $path")).use { it.write(text.toByteArray()) }
    }

    override fun readChunk(path: String, offset: Long, length: Int): String {
        require(offset >= 0 && length >= 0) { "Bad range: $offset+$length" }
        val descriptor = resolver.openFileDescriptor(uri(path), "r") ?: throw FileNotFoundException("No file: $path")
        descriptor.use { pfd ->
            FileInputStream(pfd.fileDescriptor).use { input ->
                input.channel.position(offset)
                val bytes = input.readNBytesCompat(length)
                return Base64.getEncoder().encodeToString(bytes)
            }
        }
    }

    override fun writeChunk(path: String, data: String, first: Boolean, last: Boolean) {
        val upload = sibling(path, ".upload")
        if (first) {
            remove(upload)
            create(upload)
        } else {
            require(exists(upload)) { "No upload in progress: $path" }
        }
        (resolver.openOutputStream(uri(upload), "wa") ?: throw IOException("Couldn't open $upload")).use {
            it.write(Base64.getDecoder().decode(data))
        }
        if (last) commit(upload, path)
    }

    override fun list(path: String): List<String> {
        val parent = stat(path)
        if (parent == null || !parent.second) return emptyList()
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id(path))
        return resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
            buildList { while (cursor.moveToNext()) cursor.getString(0)?.takeIf { !it.startsWith(".") }?.let(::add) }
        }?.sorted() ?: emptyList()
    }

    override fun remove(path: String) {
        if (stat(path) != null) DocumentsContract.deleteDocument(resolver, uri(path))
    }

    override fun openStored(hash: String): InputStream {
        val path = storedFilePath(hash)
        if (!exists(path)) throw FileNotFoundException("That file isn’t in the sync folder.")
        return resolver.openInputStream(uri(path)) ?: throw FileNotFoundException("Couldn't open $path")
    }

    /** Stores [input] as `files/<hash>`, checking it hashes to [expected] as it's copied. */
    override fun putStream(input: InputStream, expected: String?): StoredFile {
        requireNotNull(expected) { "The sync folder only takes files by hash" }
        val path = storedFilePath(expected)
        val temp = sibling(path, ".put")
        remove(temp)
        create(temp)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val size = DigestInputStream(input, digest).use { source ->
                (resolver.openOutputStream(uri(temp), "w") ?: throw IOException("Couldn't open $temp")).use { source.copyTo(it) }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (hash != expected) {
                throw IOException("The file's contents don't match its hash (expected ${expected.take(12)}…, got ${hash.take(12)}…).")
            }
            if (exists(path)) remove(temp) else commit(temp, path)
            return StoredFile(hash, size)
        } finally {
            remove(temp)
        }
    }

    /** Writes a file whole, then puts it in place of [path], so a reader never sees half of it. */
    private fun replace(path: String, write: (java.io.OutputStream) -> Unit) {
        val temp = sibling(path, ".tmp")
        remove(temp)
        create(temp)
        (resolver.openOutputStream(uri(temp), "w") ?: throw IOException("Couldn't open $temp")).use(write)
        commit(temp, path)
    }

    /** Renames [temp] to [path] (in the same folder), replacing what's there. */
    private fun commit(temp: String, path: String) {
        remove(path)
        DocumentsContract.renameDocument(resolver, uri(temp), path.substringAfterLast('/'))
            ?: throw IOException("Couldn't save $path")
    }

    /** A hidden file next to [path], for writing it in steps. */
    private fun sibling(path: String, suffix: String): String {
        val name = path.substringAfterLast('/')
        val dir = path.substringBeforeLast('/', "")
        return if (dir.isEmpty()) ".$name$suffix" else "$dir/.$name$suffix"
    }

    /** Makes an empty file at [path], and the folders it's in. */
    private fun create(path: String) {
        val dir = path.substringBeforeLast('/', "")
        makeDirs(dir)
        val name = path.substringAfterLast('/')
        val made = DocumentsContract.createDocument(resolver, dirUri(dir), "application/octet-stream", name)
            ?: throw IOException("Couldn't create $path")
        // The provider picks another name when one's taken; this one must be exactly where asked.
        if (DocumentsContract.getDocumentId(made) != id(path)) {
            DocumentsContract.deleteDocument(resolver, made)
            throw IOException("Couldn't create $path: something else is in the way.")
        }
    }

    private fun makeDirs(dir: String) {
        if (dir.isEmpty()) return
        var parent = ""
        for (segment in dir.split('/')) {
            val path = if (parent.isEmpty()) segment else "$parent/$segment"
            val existing = stat(path)
            if (existing == null) {
                DocumentsContract.createDocument(resolver, dirUri(parent), DocumentsContract.Document.MIME_TYPE_DIR, segment)
                    ?: throw IOException("Couldn't create the folder $path")
            } else if (!existing.second) {
                throw IOException("$path is a file, not a folder.")
            }
            parent = path
        }
    }

    private companion object {
        const val EXTERNAL_STORAGE = "com.android.externalstorage.documents"
    }
}

/** Up to [length] bytes, fewer only at the end of the stream (InputStream.readNBytes needs API 33). */
private fun InputStream.readNBytesCompat(length: Int): ByteArray {
    val buffer = ByteArray(length)
    var read = 0
    while (read < length) {
        val n = read(buffer, read, length - read)
        if (n < 0) break
        read += n
    }
    return if (read == length) buffer else buffer.copyOf(read)
}
