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

/** Copies a stored file from one storage to another, checking its hash on the way. */
fun copyStoredFile(from: PathStorage, to: PathStorage, hash: String): StoredFile = from.openStored(hash).use { to.putStream(it, hash) }
