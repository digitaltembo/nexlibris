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

        assertEquals("book", storedFile(storage, "files/ab/abcd")?.readText())
        assertEquals("book", storedFile(storage, "files/ab/abcd?v=1")?.readText())
        assertNull(storedFile(storage, "files/ab/missing"))
        assertNull(storedFile(storage, "files/ab"))
        assertEquals("thumb", storedFile(storage, "local/thumbs/ab/abcd.jpg")?.readText())
        assertNull(storedFile(storage, "local/sync-folder.json"))
        assertNull(storedFile(storage, "local/thumbs/../sync-folder.json"))
        assertNull(storedFile(storage, "library.json"))
        assertNull(storedFile(storage, "files/../library.json"))
        assertNull(storedFile(storage, "files/../../secret"))
    }
}
