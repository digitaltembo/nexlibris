package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Requests here are shaped exactly as client/src/backends/androidBridge.ts sends them. */
class RpcRouterTest {
    @get:Rule
    val temp = TemporaryFolder()

    private fun router() = RpcRouter(storageRoutes(StorageService(temp.root)))
    private fun request(method: String, url: String, body: String) =
        JSONObject("""{"id":1,"method":"$method","url":"$url","body":$body}""")

    @Test
    fun routesByMethodAndUrl() {
        val router = router()
        val written = router.handle(request("POST", "api/storage/writeText", """{"path":"library.json","text":"{}"}"""))
        assertTrue(written.getBoolean("ok"))
        assertTrue(written.isNull("value"))

        val read = router.handle(request("GET", "api/storage/readText", """{"path":"library.json"}"""))
        assertEquals("{}", read.getString("value"))
        assertEquals(2L, router.handle(request("GET", "api/storage/size", """{"path":"library.json"}""")).getLong("value"))
        assertTrue(router.handle(request("GET", "api/storage/readText", """{"path":"nope"}""")).isNull("value"))
        assertEquals(true, router.handle(request("GET", "api/storage/exists", """{"path":"library.json"}""")).get("value"))

        assertTrue(router.handle(request("POST", "api/storage/remove", """{"path":"library.json"}""")).getBoolean("ok"))
        assertEquals(false, router.handle(request("GET", "api/storage/exists", """{"path":"library.json"}""")).get("value"))
        // Removing what isn't there is fine.
        assertTrue(router.handle(request("POST", "api/storage/remove", """{"path":"library.json"}""")).getBoolean("ok"))
        assertFalse(router.handle(request("POST", "api/storage/remove", """{"path":"../x"}""")).getBoolean("ok"))
    }

    @Test
    fun reportsErrorsAsMessages() {
        val router = router()
        val bad = router.handle(request("GET", "api/storage/readText", """{"path":"../x"}"""))
        assertFalse(bad.getBoolean("ok"))
        assertEquals("Bad path: ../x", bad.getString("message"))

        val unknown = router.handle(request("DELETE", "api/storage/everything", "{}"))
        assertEquals("No endpoint for DELETE api/storage/everything", unknown.getString("message"))

        val missing = router.handle(request("GET", "api/storage/readChunk", """{"path":"nope","offset":0,"length":10}"""))
        assertEquals("No file: nope", missing.getString("message"))
    }

    @Test
    fun servesTheSyncFolderAlongsideTheLibrary() {
        val library = StorageService(File(temp.root, "library"))
        val folder = StorageService(File(temp.root, "sync"))
        val router = RpcRouter(storageRoutes(library), usbFolderRoutes({ folder }, { library }, { JSONObject().put("path", "Documents/sync") }, { JSONObject() }))
        router.handle(request("POST", "api/usbFolder/writeText", """{"path":"library.json","text":"{}"}"""))
        assertEquals("{}", folder.readText("library.json"))
        assertEquals(null, library.readText("library.json"))
        val hash = library.putStream("book".byteInputStream()).hash
        assertEquals(true, router.handle(request("POST", "api/usbFolder/toFolder", """{"hash":"$hash"}""")).getBoolean("ok"))
        assertEquals("[\"$hash\"]", router.handle(request("GET", "api/usbFolder/list", """{"path":"files/${hash.take(2)}"}""")).get("value").toString())
        assertEquals(
            "Documents/sync",
            router.handle(request("GET", "api/usbFolder/info", "{}")).getJSONObject("value").getString("path"),
        )
        // With no folder chosen yet, the folder's calls say so.
        val missing = RpcRouter(usbFolderRoutes({ throw IllegalStateException("Choose the sync folder first.") }, { library }, { JSONObject() }, { JSONObject() }))
        assertEquals("Choose the sync folder first.", missing.handle(request("GET", "api/usbFolder/exists", """{"path":"a"}""")).getString("message"))
    }

    @Test
    fun setsWindowColors() {
        val set = mutableListOf<Pair<Int, Boolean>>()
        val router = RpcRouter(windowRoutes { background, dark -> set += background to dark })
        assertTrue(router.handle(request("POST", "api/window/setColors", """{"background":"#1c1813","dark":true}""")).getBoolean("ok"))
        assertEquals(listOf(0xFF1C1813.toInt() to true), set)
        assertFalse(router.handle(request("POST", "api/window/setColors", """{"background":"red","dark":false}""")).getBoolean("ok"))
        assertEquals(1, set.size)
    }
}
