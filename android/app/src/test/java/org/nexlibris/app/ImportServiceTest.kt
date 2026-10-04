package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
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

    private fun source(name: String, text: String) = PickedSource(name, size = text.length.toLong()) { text.byteInputStream() }

    @Test
    fun storesPickedFilesByHashAndSkipsOthers() {
        val storage = StorageService(File(temp.root, "lib"))
        val picked = listOf(
            source("Book.EPUB", "hello"),
            source("dune.x4.epub", "x4"),
            source("notes.doc", "nope"),
            PickedSource("gone.pdf") { throw IOException("Couldn't open it") },
        )
        val service = ImportService(storage) { picked }
        val chosen = service.pick(listOf("epub", "x4.epub", "pdf"))
        // Listed with sizes, not stored yet.
        assertEquals(3, chosen.getJSONArray("files").length())
        assertEquals(5, chosen.getJSONArray("files").getJSONObject(0).getLong("size"))
        assertEquals("notes.doc", chosen.getJSONArray("skipped").getJSONObject(0).getString("name"))
        assertEquals("unsupported file type", chosen.getJSONArray("skipped").getJSONObject(0).getString("reason"))
        assertFalse(File(temp.root, "lib/files").exists())

        val result = service.store(chosen.getString("token"), 0)
        assertEquals(3, result.getInt("next"))
        val files = result.getJSONArray("files")
        assertEquals(2, files.length())
        val book = files.getJSONObject(0)
        assertEquals("Book.EPUB", book.getString("name"))
        assertEquals(helloHash, book.getString("hash"))
        assertEquals(5, book.getLong("size"))
        assertEquals("hello", storage.readText(storedFilePath(helloHash)))

        val skipped = result.getJSONArray("skipped")
        assertEquals("gone.pdf", skipped.getJSONObject(0).getString("name"))
        assertEquals("Couldn't open it", skipped.getJSONObject(0).getString("reason"))
        // No temporary files left behind.
        assertTrue(File(temp.root, "lib/files").listFiles()!!.all { it.isDirectory })
        // Once it's all stored, the pick is let go.
        assertThrows(IllegalStateException::class.java) { service.store(chosen.getString("token"), 3) }
    }

    @Test
    fun storesAPickInBatchesAndOnlyTheLatestPick() {
        val storage = StorageService(File(temp.root, "lib"))
        val picked = (0 until ImportService.BATCH_FILES + 10).map { source("book-$it.epub", "book $it") }
        val service = ImportService(storage) { picked }
        val first = service.pick(listOf("epub")).getString("token")
        val batch = service.store(first, 0)
        assertEquals(ImportService.BATCH_FILES, batch.getJSONArray("files").length())
        assertEquals(ImportService.BATCH_FILES, batch.getInt("next"))

        val second = service.pick(listOf("epub")).getString("token")
        assertThrows(IllegalStateException::class.java) { service.store(first, ImportService.BATCH_FILES) }
        val router = RpcRouter(importRoutes(service))
        val request = JSONObject("""{"method":"POST","url":"api/import/store","body":{"token":"$second","start":${ImportService.BATCH_FILES}}}""")
        val rest = router.handle(request).getJSONObject("value")
        assertEquals(10, rest.getJSONArray("files").length())
        assertEquals(picked.size, rest.getInt("next"))
    }

    @Test
    fun picksAFoldersBooksWithTheirPathsAndTheNamedSidecars() {
        val storage = StorageService(File(temp.root, "lib"))
        val book = "Calibre Library/Frank Herbert/Dune (7)"
        val picked = listOf(
            PickedSource("Dune.epub", "$book/Dune.epub") { "hello".byteInputStream() },
            PickedSource("Metadata.OPF", "$book/Metadata.OPF") { "<package/>".byteInputStream() },
            PickedSource("metadata.db", "Calibre Library/metadata.db") { "sqlite".byteInputStream() },
        )
        var askedForFolder = false
        val service = ImportService(storage) { folder -> askedForFolder = folder; picked }
        val router = RpcRouter(importRoutes(service))
        val request = JSONObject(
            """{"method":"POST","url":"api/import/pick","body":{"extensions":["epub"],"folder":true,"names":["metadata.opf"]}}""",
        )
        val chosen = router.handle(request).getJSONObject("value")
        val result = service.store(chosen.getString("token"), 0)

        assertTrue(askedForFolder)
        val files = result.getJSONArray("files")
        assertEquals(2, files.length())
        assertEquals("$book/Dune.epub", files.getJSONObject(0).getString("path"))
        assertEquals(helloHash, files.getJSONObject(0).getString("hash"))
        assertEquals("Metadata.OPF", files.getJSONObject(1).getString("name"))
        val skipped = chosen.getJSONArray("skipped")
        assertEquals(1, skipped.length())
        assertEquals("Calibre Library/metadata.db", skipped.getJSONObject(0).getString("name"))
    }

    @Test
    fun namedSidecarsAreOnlyTakenFromFolders() {
        val storage = StorageService(File(temp.root, "lib"))
        val result = ImportService(storage) { listOf(source("metadata.opf", "<package/>")) }.pick(listOf("epub"), names = listOf("metadata.opf"))
        assertEquals(0, result.getJSONArray("files").length())
    }

    @Test
    fun walksAFolderInNameOrderLeavingOutHiddenOnes() {
        val tree = mapOf(
            "root" to listOf(TreeEntry("b", "Herbert", true), TreeEntry("db", "metadata.db", false), TreeEntry("t", ".caltrash", true)),
            "b" to listOf(TreeEntry("e", "Dune.epub", false, 9), TreeEntry("o", "metadata.opf", false, 2), TreeEntry("h", ".DS_Store", false)),
            "t" to listOf(TreeEntry("x", "old.epub", false)),
        )
        val files = walkFolder("root", "Library") { tree[it] ?: emptyList() }
        assertEquals(
            listOf(
                FolderFile("e", "Library/Herbert/Dune.epub", 9),
                FolderFile("o", "Library/Herbert/metadata.opf", 2),
                FolderFile("db", "Library/metadata.db", 0),
            ),
            files,
        )
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
