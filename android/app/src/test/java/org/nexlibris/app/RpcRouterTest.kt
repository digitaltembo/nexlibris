package org.nexlibris.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

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
}
