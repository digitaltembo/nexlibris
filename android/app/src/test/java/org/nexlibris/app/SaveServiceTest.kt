package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

class SaveServiceTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val dir get() = File(temp.root, "saves")
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    @Test
    fun copiesTheChunksToWhereTheUserChooses() {
        val destination = ByteArrayOutputStream()
        val asked = mutableListOf<Pair<String, String>>()
        val saves = SaveService(dir) { name, type -> asked += name to type; destination }
        val bytes = ByteArray(2500) { (it % 251).toByte() }
        saves.chunk("t-1", b64(bytes.copyOfRange(0, 1000)), first = true)
        saves.chunk("t-1", b64(bytes.copyOfRange(1000, 2500)), first = false)

        assertTrue(saves.save("t-1", "backup.zip", "application/zip"))
        assertEquals(listOf("backup.zip" to "application/zip"), asked)
        assertArrayEquals(bytes, destination.toByteArray())
        // The upload is gone once saved.
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test
    fun cancellingSavesNothingAndDiscardsTheUpload() {
        val saves = SaveService(dir) { _, _ -> null }
        saves.chunk("t", b64("x".toByteArray()), first = true)
        assertFalse(saves.save("t", "a.epub", "application/epub+zip"))
        assertThrows(IllegalArgumentException::class.java) { saves.save("t", "a.epub", "application/epub+zip") }
    }

    @Test
    fun refusesTokensThatCouldBePaths() {
        val saves = SaveService(dir) { _, _ -> null }
        for (token in listOf("../x", "a/b", "", ".")) {
            assertThrows(token, IllegalArgumentException::class.java) { saves.chunk(token, "", first = true) }
        }
        assertThrows(IllegalArgumentException::class.java) { saves.chunk("never-started", "", first = false) }
    }

    @Test
    fun clearsUploadsLeftFromAnEarlierRun() {
        dir.mkdirs()
        File(dir, "stale").writeText("left over")
        SaveService(dir) { _, _ -> null }
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test
    fun isReachableThroughTheRouter() {
        val destination = ByteArrayOutputStream()
        val router = RpcRouter(saveRoutes(SaveService(dir) { _, _ -> destination }))
        val chunk = JSONObject().put("method", "POST").put("url", "api/save/chunk")
            .put("body", JSONObject().put("token", "t").put("data", b64("hi".toByteArray())).put("first", true))
        assertTrue(router.handle(chunk).getBoolean("ok"))
        val save = JSONObject().put("method", "POST").put("url", "api/save/file")
            .put("body", JSONObject().put("token", "t").put("name", "n.txt").put("mimeType", "text/plain"))
        assertEquals(true, router.handle(save).get("value"))
        assertEquals("hi", destination.toString())
    }
}
