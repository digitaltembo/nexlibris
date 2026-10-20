package org.nexlibris.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LibraryFilesPathHandlerTest {
    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun findsStoredFilesButNothingElse() {
        val root = temp.newFolder("library")
        val storage = StorageService(root)
        File(root, "files/ab").mkdirs()
        File(root, "files/ab/abcd").writeText("book")
        File(root, "local/thumbs/ab").mkdirs()
        File(root, "local/thumbs/ab/abcd.jpg").writeText("thumb")
        File(root, "local/sync-folder.json").writeText("{}")
        File(root, "library.json").writeText("{}")
        temp.newFile("secret").writeText("outside")

        assertEquals("book", servedFile(storage, false, "files/ab/abcd")?.use { it.readBytes().decodeToString() })
        assertEquals("book", servedFile(storage, false, "files/ab/abcd?v=1")?.use { it.readBytes().decodeToString() })
        assertNull(servedFile(storage, false, "files/ab/missing"))
        assertNull(servedFile(storage, false, "files/ab"))
        assertEquals("thumb", servedFile(storage, false, "local/thumbs/ab/abcd.jpg")?.use { it.readBytes().decodeToString() })
        assertNull(servedFile(storage, false, "local/sync-folder.json"))
        assertNull(servedFile(storage, false, "local/thumbs/../sync-folder.json"))
        assertNull(servedFile(storage, false, "library.json"))
        assertNull(servedFile(storage, false, "files/../library.json"))
        assertNull(servedFile(storage, false, "files/../../secret"))
    }

    @Test
    fun servesBooksPlacedInAFolderButNotItsData() {
        val root = temp.newFolder("placed")
        val storage = StorageService(root)
        File(root, "Frank Herbert").mkdirs()
        File(root, "Frank Herbert/Dune.epub").writeText("book")
        File(root, ".nexlibris/files/ab").mkdirs()
        File(root, ".nexlibris/files/ab/abcd").writeText("waiting")
        File(root, ".nexlibris/library.json").writeText("{}")
        assertEquals("book", servedFile(storage, true, "Frank Herbert/Dune.epub")?.use { it.readBytes().decodeToString() })
        assertEquals("waiting", servedFile(storage, true, ".nexlibris/files/ab/abcd")?.use { it.readBytes().decodeToString() })
        assertNull(servedFile(storage, true, ".nexlibris/library.json"))
        assertNull(servedFile(storage, true, "Frank Herbert/.hidden"))
        assertNull(servedFile(storage, true, "../secret"))
        assertNull(servedFile(storage, false, "Frank Herbert/Dune.epub"))
    }
}
