package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class ImportServiceTest {
    @get:Rule
    val temp = TemporaryFolder()

    // SHA-256 of "hello", as the web app's hashBlob writes it.
    private val helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

    private fun source(name: String, text: String) = PickedSource(name) { text.byteInputStream() }

    @Test
    fun storesPickedFilesByHashAndSkipsOthers() {
        val storage = StorageService(File(temp.root, "lib"))
        val picked = listOf(
            source("Book.EPUB", "hello"),
            source("dune.x4.epub", "x4"),
            source("notes.doc", "nope"),
            PickedSource("gone.pdf") { throw IOException("Couldn't open it") },
        )
        val result = ImportService(storage) { picked }.pick(listOf("epub", "x4.epub", "pdf"))

        val files = result.getJSONArray("files")
        assertEquals(2, files.length())
        val book = files.getJSONObject(0)
        assertEquals("Book.EPUB", book.getString("name"))
        assertEquals(helloHash, book.getString("hash"))
        assertEquals(5, book.getLong("size"))
        assertEquals("hello", storage.readText(storedFilePath(helloHash)))

        val skipped = result.getJSONArray("skipped")
        assertEquals("notes.doc", skipped.getJSONObject(0).getString("name"))
        assertEquals("unsupported file type", skipped.getJSONObject(0).getString("reason"))
        assertEquals("Couldn't open it", skipped.getJSONObject(1).getString("reason"))
        // No temporary files left behind.
        assertTrue(File(temp.root, "lib/files").listFiles()!!.all { it.isDirectory })
    }

    @Test
    fun storingTheSameContentsAgainIsANoOp() {
        val storage = StorageService(File(temp.root, "lib"))
        val first = "hello".byteInputStream().use { storage.putStream(it) }
        val again = "hello".byteInputStream().use { storage.putStream(it) }
        assertEquals(first, again)
        assertEquals(StoredFile(helloHash, 5), first)
    }

    @Test
    fun cancellingPicksNothing() {
        val storage = StorageService(File(temp.root, "lib"))
        val router = RpcRouter(importRoutes(ImportService(storage) { emptyList() }))
        val request = JSONObject("""{"method":"POST","url":"api/import/pick","body":{"extensions":["epub"]}}""")
        val response = router.handle(request)
        assertTrue(response.getBoolean("ok"))
        assertEquals(0, response.getJSONObject("value").getJSONArray("files").length())
    }
}
