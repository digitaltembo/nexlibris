package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InputStream

class LibraryFolderServiceTest {
    @get:Rule
    val temp = TemporaryFolder()

    /** Plain folders, by path, as the picker's folders would be. */
    private inner class FakeFolders : Folders {
        val picks = ArrayDeque<String>()
        val revoked = mutableSetOf<String>()
        var kept = setOf<String>()
        override fun pick() = picks.removeFirstOrNull()
        override fun open(id: String, base: String): LibraryTree = StorageService(if (base.isEmpty()) File(id) else File(id, base))
        override fun where(id: String) = File(id).name
        override fun mayUse(id: String) = File(id).isDirectory && id !in revoked
        override fun keep(id: String) {
            kept = kept + id
        }
        override fun releaseAllBut(ids: Set<String>) {
            kept = kept.intersect(ids)
        }
        override fun overlap(a: String, b: String) = a == b || a.startsWith("$b/") || b.startsWith("$a/")
    }

    private class Remembered(var value: String? = null) : LibraryFolderService.Setting {
        override fun get() = value
        override fun set(value: String?) {
            this.value = value
        }
    }

    private val hashA = "a".repeat(64)
    private val hashB = "b".repeat(64)
    private val layout = JSONObject("""{"folder":"<author>","fileName":"<title>"}""")

    /** A library in the app's storage, with a book file and a cover. */
    private fun homeLibrary(): StorageService {
        val home = StorageService(temp.newFolder("home"))
        home.writeText("library.json", "{}")
        home.writeText("changes.jsonl", "")
        home.writeText("local/pairings.json", "[]")
        home.writeText(storedFilePath(hashA), "dune")
        home.writeText(storedFilePath(hashB), "cover")
        return home
    }

    private fun waitForMove(service: LibraryFolderService): JSONObject {
        repeat(500) {
            val status = service.status()
            if (status.getString("state") != "moving") return status
            Thread.sleep(10)
        }
        throw AssertionError("The move didn't finish")
    }

    @Test
    fun movesTheLibraryIntoAFolderLaidOutAndBack() {
        val home = homeLibrary()
        val folders = FakeFolders()
        val chosen = Remembered()
        var reloads = 0
        val service = LibraryFolderService(home, folders, chosen) { reloads++ }
        val books = temp.newFolder("Books")
        File(books, "notes.txt").writeText("mine")
        folders.picks += books.path

        val choice = service.choose()!!
        assertEquals("files", choice.getString("holds"))
        assertEquals("Books", choice.getString("name"))
        service.move(choice.getString("path"), layout, mapOf(hashA to "Frank Herbert/Dune.epub"))
        assertEquals("done", waitForMove(service).getString("state"))

        assertEquals(1, reloads)
        assertEquals(books.path, chosen.value)
        assertEquals("dune", File(books, "Frank Herbert/Dune.epub").readText())
        assertEquals("cover", File(books, ".nexlibris/${storedFilePath(hashB)}").readText())
        assertEquals("[]", File(books, ".nexlibris/local/pairings.json").readText())
        assertEquals("mine", File(books, "notes.txt").readText())
        assertEquals("Frank Herbert/Dune.epub", JSONObject(File(books, ".nexlibris/placed.json").readText()).getString(hashA))
        assertEquals(emptyList<String>(), home.listAll(""))
        // The page reads the folder; imports go into its .nexlibris.
        assertTrue(service.placed)
        assertEquals("dune", service.root.readText("Frank Herbert/Dune.epub"))
        assertEquals("cover", service.data.readText(storedFilePath(hashB)))
        val location = service.location()
        assertEquals("Books", location.getString("path"))
        assertFalse(location.getBoolean("isDefault"))
        assertFalse(location.getBoolean("defaultHasLibrary"))

        service.move(null, null, emptyMap())
        assertEquals("done", waitForMove(service).getString("state"))
        assertNull(chosen.value)
        assertEquals("dune", home.readText(storedFilePath(hashA)))
        assertEquals(listOf("notes.txt"), books.list()!!.toList())
        assertEquals(emptySet<String>(), folders.kept)
    }

    @Test
    fun leavesTheLibraryWhereItWasIfACopyFails() {
        val home = homeLibrary()
        val books = StorageService(temp.newFolder("Books"))
        val failing = object : LibraryTree by books {
            var writes = 0
            override fun writeStream(path: String, input: InputStream) {
                if (++writes == 3) throw IOException("The disk is full.")
                books.writeStream(path, input)
            }
        }
        val error = assertThrows(IOException::class.java) {
            LibraryFolderService.relocate(home, false, failing, layout, mapOf(hashA to "Frank Herbert/Dune.epub"))
        }
        assertEquals("The disk is full.", error.message)
        assertEquals(emptyList<String>(), books.filesUnder(""))
        assertEquals("dune", home.readText(storedFilePath(hashA)))
        assertEquals("{}", home.readText("library.json"))
    }

    @Test
    fun opensALibraryInAFolderInsteadOfMovingIntoIt() {
        val home = homeLibrary()
        val folders = FakeFolders()
        var reloads = 0
        val service = LibraryFolderService(home, folders, Remembered()) { reloads++ }
        val other = temp.newFolder("Other")
        StorageService(other).writeText(LibraryFolderService.LAYOUT_PATH, layout.toString())
        folders.picks += other.path

        val choice = service.choose()!!
        assertEquals("library", choice.getString("holds"))
        service.move(other.path, layout, emptyMap())
        assertEquals("failed", waitForMove(service).getString("state"))
        assertEquals("That folder has a library already.", service.status().getString("message"))

        service.open(other.path)
        assertEquals(1, reloads)
        assertTrue(service.placed)
        assertTrue(service.location().getBoolean("defaultHasLibrary"))
        // The library in the app's storage stayed.
        assertEquals("dune", home.readText(storedFilePath(hashA)))
    }

    @Test
    fun opensInTheAppsStorageWhenTheFolderCantBeUsed() {
        val home = homeLibrary()
        val folders = FakeFolders()
        val gone = temp.newFolder("Gone").path
        folders.revoked += gone
        val service = LibraryFolderService(home, folders, Remembered(gone)) {}
        assertFalse(service.placed)
        assertEquals("Gone", service.location().getString("lost"))
        assertTrue(service.location().getBoolean("isDefault"))
        assertEquals("{}", service.root.readText("library.json"))
    }
}
