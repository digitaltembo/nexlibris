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
import java.util.UUID

/**
 * Storage in a folder of the user's in shared storage, picked with the system's folder picker:
 * the sync folder (say Documents/nexlibris-sync), which a computer sees when the phone is plugged
 * in by USB, or the library's folder ([LibraryFolderService]). It's reached through the storage
 * provider rather than as files, so it works whoever wrote what's in it (files copied in over USB
 * belong to another user, which the app couldn't open directly), and needs no permission beyond
 * the lasting one the picker grants for that folder.
 *
 * Only folders on the device's own storage (ExternalStorageProvider) are taken: their document ids
 * are paths, so a file's id is the folder's plus its path, with no lookups. Paths are taken from
 * [base] in the folder ("" for its top), e.g. `.nexlibris` for a library's own files.
 */
class DocumentTreeStorage(private val resolver: ContentResolver, private val tree: Uri, private val base: String = "") : LibraryTree {
    private val rootId: String = DocumentsContract.getTreeDocumentId(tree)

    init {
        require(tree.authority == EXTERNAL_STORAGE) { "Choose a folder on this phone’s storage." }
    }

    /** Where it is, as a computer browsing the phone sees it, e.g. "Documents/nexlibris-sync". */
    val where: String get() = rootId.substringAfter(':').ifEmpty { "the phone’s storage" }

    /** The document id of a path from the folder's top. */
    private fun docId(full: String): String = when {
        full.isEmpty() -> rootId
        rootId.endsWith(":") -> "$rootId$full"
        else -> "$rootId/$full"
    }

    private fun id(path: String): String {
        val segments = path.split('/')
        require(path.isNotEmpty() && segments.none { it.isEmpty() || it == "." || it == ".." }) { "Bad path: $path" }
        return docId(if (base.isEmpty()) path else "$base/$path")
    }

    private fun uri(path: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, id(path))

    private fun dirUri(path: String): Uri = if (path.isEmpty()) DocumentsContract.buildDocumentUriUsingTree(tree, docId(base)) else uri(path)

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

    override fun list(path: String): List<String> = listAll(path).filterNot { it.startsWith(".") }

    override fun listAll(path: String): List<String> {
        if (!isFolder(path)) return emptyList()
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(dirUri(path)))
        return resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
            buildList { while (cursor.moveToNext()) cursor.getString(0)?.let(::add) }
        }?.sorted() ?: emptyList()
    }

    override fun isFolder(path: String): Boolean = if (path.isEmpty()) base.isEmpty() || folderStat(base) else stat(path)?.second == true

    override fun open(path: String): InputStream? = if (exists(path)) resolver.openInputStream(uri(path)) else null

    override fun writeStream(path: String, input: InputStream) = replace(path) { out -> input.copyTo(out) }

    override fun move(from: String, to: String) {
        if (from == to) return
        val fromDir = from.substringBeforeLast('/', "")
        val toDir = to.substringBeforeLast('/', "")
        val name = to.substringAfterLast('/')
        if (stat(from)?.second != false) throw FileNotFoundException("No file: $from")
        // Through a hidden name: the target may differ only in case, which on this storage is the same file.
        val moving = sibling(from, ".moving")
        remove(moving)
        DocumentsContract.renameDocument(resolver, uri(from), moving.substringAfterLast('/')) ?: throw IOException("Couldn't move $from")
        var at = moving
        if (fromDir != toDir) {
            makeDirs(toDir)
            DocumentsContract.moveDocument(resolver, uri(moving), dirUri(fromDir), dirUri(toDir)) ?: throw IOException("Couldn't move $from")
            at = if (toDir.isEmpty()) moving.substringAfterLast('/') else "$toDir/${moving.substringAfterLast('/')}"
        }
        remove(to)
        DocumentsContract.renameDocument(resolver, uri(at), name) ?: throw IOException("Couldn't move $from to $to")
    }

    override fun prune(path: String) {
        var dir = path.substringBeforeLast('/', "")
        while (dir.isNotEmpty()) {
            val names = listAll(dir)
            if (names.any { it !in IGNORED_NAMES }) return
            DocumentsContract.deleteDocument(resolver, uri(dir))
            dir = dir.substringBeforeLast('/', "")
        }
    }

    override fun removeTree(path: String) {
        if (path.isNotEmpty()) {
            // The provider deletes a folder with everything in it.
            if (stat(path) != null) DocumentsContract.deleteDocument(resolver, uri(path))
        } else {
            for (name in listAll("")) DocumentsContract.deleteDocument(resolver, uri(name))
        }
    }

    override fun remove(path: String) {
        if (stat(path) != null) DocumentsContract.deleteDocument(resolver, uri(path))
    }

    override fun openStored(hash: String): InputStream {
        val path = storedFilePath(hash)
        if (!exists(path)) throw FileNotFoundException("That file isn’t in the folder.")
        return resolver.openInputStream(uri(path)) ?: throw FileNotFoundException("Couldn't open $path")
    }

    /** Stores [input] as `files/<hash>`, hashing it as it's copied; with [expected], other contents are refused. */
    override fun putStream(input: InputStream, expected: String?): StoredFile {
        val temp = if (expected != null) sibling(storedFilePath(expected), ".put") else "files/.put-${UUID.randomUUID()}"
        remove(temp)
        create(temp)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val size = DigestInputStream(input, digest).use { source ->
                (resolver.openOutputStream(uri(temp), "w") ?: throw IOException("Couldn't open $temp")).use { source.copyTo(it) }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (expected != null && hash != expected) {
                throw IOException("The file's contents don't match its hash (expected ${expected.take(12)}…, got ${hash.take(12)}…).")
            }
            val path = storedFilePath(hash)
            if (!exists(path)) move(temp, path)
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

    /** Whether the folder [full] (from the top) is there. */
    private fun folderStat(full: String): Boolean = try {
        resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, docId(full)), arrayOf(DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)
            ?.use { it.moveToFirst() && it.getString(0) == DocumentsContract.Document.MIME_TYPE_DIR } == true
    } catch (_: Exception) {
        false
    }

    private fun makeDirs(dir: String) {
        if (base.isNotEmpty() && !folderStat(base)) {
            DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, rootId), DocumentsContract.Document.MIME_TYPE_DIR, base)
                ?: throw IOException("Couldn't create the folder $base")
        }
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
