package org.nexlibris.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.util.Base64

class StorageServiceTest {
    @get:Rule
    val temp = TemporaryFolder()

    private fun storage() = StorageService(File(temp.root, "libraries/default"))
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    @Test
    fun readsWritesAndAppendsText() {
        val storage = storage()
        assertNull(storage.readText("library.json"))
        assertFalse(storage.exists("library.json"))
        storage.writeText("library.json", "héllo")
        storage.appendText("library.json", " wörld\n")
        storage.appendText("log/changes.jsonl", "{}\n")
        assertEquals("héllo wörld\n", storage.readText("library.json"))
        assertEquals("{}\n", storage.readText("log/changes.jsonl"))
        assertTrue(storage.exists("library.json"))
    }

    @Test
    fun uploadsInChunksAndOnlyReplacesTheFileAtTheEnd() {
        val storage = storage()
        val bytes = ByteArray(2500) { (it * 7 % 256).toByte() }
        storage.writeChunk("files/ab/abc", b64(bytes.copyOfRange(0, 1000)), first = true, last = false)
        assertFalse(storage.exists("files/ab/abc"))
        storage.writeChunk("files/ab/abc", b64(bytes.copyOfRange(1000, 2000)), first = false, last = false)
        storage.writeChunk("files/ab/abc", b64(bytes.copyOfRange(2000, 2500)), first = false, last = true)

        assertEquals(2500L, storage.size("files/ab/abc"))
        val read = (0 until 2500 step 1000).flatMap { offset ->
            Base64.getDecoder().decode(storage.readChunk("files/ab/abc", offset.toLong(), 1000)).toList()
        }
        assertEquals(bytes.toList(), read)
        // Reading past the end is short, not an error.
        assertEquals("", storage.readChunk("files/ab/abc", 3000, 10))
        assertNull(storage.size("files/missing"))
    }

    @Test
    fun aNewFirstChunkStartsOver() {
        val storage = storage()
        storage.writeChunk("f", b64("abandoned".toByteArray()), first = true, last = false)
        storage.writeChunk("f", b64("fresh".toByteArray()), first = true, last = true)
        assertEquals("fresh", storage.readText("f"))
        assertThrows(IllegalArgumentException::class.java) {
            storage.writeChunk("g", b64("x".toByteArray()), first = false, last = true)
        }
    }

    @Test
    fun writesEmptyFiles() {
        val storage = storage()
        storage.writeChunk("empty", "", first = true, last = true)
        assertEquals(0L, storage.size("empty"))
    }

    @Test
    fun refusesPathsOutsideTheLibrary() {
        val storage = storage()
        for (path in listOf("../escape", "/etc/passwd", "a//b", "a/./b", "", "files/../../x")) {
            assertThrows(path, IllegalArgumentException::class.java) { storage.readText(path) }
        }
        val outside = temp.newFolder("outside")
        Files.createSymbolicLink(File(temp.root, "libraries/default/link").toPath(), outside.toPath())
        assertThrows(IllegalArgumentException::class.java) { storage.writeText("link/x", "nope") }
        assertFalse(File(outside, "x").exists())
    }

    @Test
    fun listsRemovesAndCopiesStoredFilesBetweenStorages() {
        val library = storage()
        val folder = StorageService(File(temp.root, "sync"))
        val stored = library.putStream("a book".byteInputStream())
        assertEquals(listOf(stored.hash.take(2)), library.list("files"))
        assertEquals(emptyList<String>(), folder.list("files"))

        assertEquals(stored, copyStoredFile(library, folder, stored.hash))
        assertEquals("a book", folder.resolve(storedFilePath(stored.hash)).readText())
        folder.remove(storedFilePath(stored.hash))
        assertFalse(folder.exists(storedFilePath(stored.hash)))
        assertThrows(java.io.FileNotFoundException::class.java) { copyStoredFile(folder, library, stored.hash) }
    }
}
