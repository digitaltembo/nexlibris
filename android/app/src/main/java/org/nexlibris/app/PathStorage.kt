package org.nexlibris.app

import java.io.InputStream

/**
 * Storage by slash-separated path, as the storage API (common/src/storageApi.ts) serves it: the
 * library's files ([StorageService]) or the user's sync folder ([DocumentTreeStorage]).
 */
interface PathStorage {
    fun readText(path: String): String?
    fun writeText(path: String, text: String)
    fun appendText(path: String, text: String)
    fun exists(path: String): Boolean
    fun size(path: String): Long?
    fun readChunk(path: String, offset: Long, length: Int): String
    fun writeChunk(path: String, data: String, first: Boolean, last: Boolean)
    /** The names in a folder; none if it doesn't exist. */
    fun list(path: String): List<String>
    fun remove(path: String)
    /** Stores [input] by its hash; with [expected], contents with any other hash are refused. */
    fun putStream(input: InputStream, expected: String? = null): StoredFile
    /** Opens a stored file, by hash. */
    fun openStored(hash: String): InputStream
}

/**
 * Storage a library can be kept in (see [LibraryFolderService]): the app's own files
 * ([StorageService]) or a folder of the user's ([DocumentTreeStorage]). Besides the storage API, it
 * can list hidden files, stream files in and out, move them (`Storage.move`), and delete folders.
 */
interface LibraryTree : PathStorage {
    /** Every name in a folder ("" for the top), hidden ones too; none if it isn't one. */
    fun listAll(path: String): List<String>
    fun isFolder(path: String): Boolean
    /** Reads a file; null if there's none. */
    fun open(path: String): InputStream?
    /** Writes [input] to [path] whole, replacing what's there, and the folders it's in. */
    fun writeStream(path: String, input: InputStream)
    /** Moves a file, replacing any at [to] (`Storage.move`). */
    fun move(from: String, to: String)
    /** Removes the folders [path] is in while they're empty, up to the top (`Storage.prune`). */
    fun prune(path: String)
    /** Deletes a folder and everything in it; "" empties the whole tree. */
    fun removeTree(path: String)
}

/** Files the system leaves in folders, which don't stop one counting as empty (as in desktop/src/libraryFolder.ts). */
val IGNORED_NAMES = setOf(".DS_Store", "Thumbs.db", "desktop.ini")

/** Every file under [dir] ("" for all), as paths from the top. */
fun LibraryTree.filesUnder(dir: String): List<String> = listAll(dir).flatMap { name ->
    val path = if (dir.isEmpty()) name else "$dir/$name"
    if (isFolder(path)) filesUnder(path) else listOf(path)
}

/** Copies a stored file from one storage to another, checking its hash on the way. */
fun copyStoredFile(from: PathStorage, to: PathStorage, hash: String): StoredFile = from.openStored(hash).use { to.putStream(it, hash) }
