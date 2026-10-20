package org.nexlibris.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import java.util.Collections
import kotlin.concurrent.thread

/** Calls as relayedFetch in common/src/localHttpApi.ts makes them, to a stand-in reader on localhost. */
class LocalHttpServiceTest {
    private lateinit var server: ServerSocket
    private lateinit var base: String
    private val seen = Collections.synchronizedList(mutableListOf<Triple<String, Map<String, String>, ByteArray>>())

    @get:Rule
    val temp = TemporaryFolder()

    private fun service() = LocalHttpService(File(temp.root, "local-http"))

    /**
     * A stand-in reader: `/api/status` answers with JSON, `/download` with [big] bytes, `/moved` redirects,
     * `/upload` echoes the body's size, anything else is a 404 with a message.
     */
    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        base = "http://127.0.0.1:${server.localPort}"
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { socket.use { serve(it) } }
            }
        }
    }

    private val big = ByteArray(LocalHttpService.INLINE_BYTES + 10) { (it % 251).toByte() }

    private fun serve(socket: Socket) {
        val input = socket.getInputStream()
        while (true) {
            val (method, path) = readLine(input).takeIf { it.isNotEmpty() }?.split(" ") ?: return
            val headers = generateSequence { readLine(input).takeIf { it.isNotEmpty() } }
                .associate { it.substringBefore(":").lowercase() to it.substringAfter(":").trim() }
            val body = input.readNBytes(headers["content-length"]?.toInt() ?: 0)
            seen += Triple("$method $path", headers, body)
            val (status, extra, reply) = when (path.substringBefore("?")) {
                "/api/status" -> Triple("200 OK", "Content-Type: application/json\r\n", """{"version":"1.2"}""".toByteArray())
                "/download" -> Triple("200 OK", "", big)
                "/moved" -> Triple("302 Found", "Location: http://example.com/\r\n", ByteArray(0))
                "/upload" -> Triple("200 OK", "", "got ${body.size}".toByteArray())
                else -> Triple("404 Not Found", "", "No such thing".toByteArray())
            }
            val out = socket.getOutputStream()
            out.write("HTTP/1.1 $status\r\n${extra}Content-Length: ${reply.size}\r\n\r\n".toByteArray())
            out.write(reply)
            out.flush()
        }
    }

    private fun readLine(input: InputStream): String {
        val line = StringBuilder()
        while (true) {
            val c = input.read()
            if (c == -1 || c == '\n'.code) break
            if (c != '\r'.code) line.append(c.toChar())
        }
        return line.toString()
    }

    @After
    fun stop() = server.close()

    private fun headers(vararg pairs: Pair<String, String>) = JSONArray(pairs.map { JSONArray().put(it.first).put(it.second) })

    @Test
    fun answersSmallRepliesWithTheCall() {
        val result = service().fetch("$base/api/status", "GET", headers("Accept" to "application/json"), null)
        assertEquals(200, result.getInt("status"))
        assertEquals("""{"version":"1.2"}""", String(Base64.getDecoder().decode(result.getString("data"))))
        val type = (0 until result.getJSONArray("headers").length())
            .map { result.getJSONArray("headers").getJSONArray(it) }
            .single { it.getString(0).equals("content-type", ignoreCase = true) }
        assertEquals("application/json", type.getString(1))
        assertEquals("application/json", seen.single().second["accept"])
    }

    @Test
    fun sendsAStagedBodyAndKeepsBigRepliesToRead() {
        val local = service()
        local.stage("t1", Base64.getEncoder().encodeToString("hello ".toByteArray()), true)
        local.stage("t1", Base64.getEncoder().encodeToString("reader".toByteArray()), false)
        val sent = local.fetch("$base/upload?path=%2F", "POST", headers("Content-Type" to "multipart/form-data; boundary=x"), "t1")
        assertEquals("got 12", String(Base64.getDecoder().decode(sent.getString("data"))))
        assertEquals("hello reader", String(seen.last().third))
        assertEquals("multipart/form-data; boundary=x", seen.last().second["content-type"])
        // The staged body is used up.
        assertTrue(runCatching { local.fetch("$base/upload", "POST", JSONArray(), "t1") }.exceptionOrNull() is IllegalArgumentException)

        val reply = local.fetch("$base/download?path=%2Fx", "GET", JSONArray(), null)
        assertFalse(reply.has("data"))
        val token = reply.getString("token")
        assertEquals(big.size, reply.getInt("size"))
        val first = Base64.getDecoder().decode(local.read(token, 0, 1000))
        val last = Base64.getDecoder().decode(local.read(token, big.size - 5L, 1000))
        assertEquals(big.copyOfRange(0, 1000).toList(), first.toList())
        assertEquals(big.copyOfRange(big.size - 5, big.size).toList(), last.toList())
        local.close(token)
        assertTrue(runCatching { local.read(token, 0, 1) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun passesErrorsBackAndDoesNotFollowRedirects() {
        val missing = service().fetch("$base/nothing", "GET", JSONArray(), null)
        assertEquals(404, missing.getInt("status"))
        assertEquals("No such thing", String(Base64.getDecoder().decode(missing.getString("data"))))
        val moved = service().fetch("$base/moved", "GET", JSONArray(), null)
        assertEquals(302, moved.getInt("status"))
        assertEquals(1, seen.count { it.first.startsWith("GET /moved") })
    }

    @Test
    fun callsOnlyTheLocalNetwork() {
        for (url in listOf("http://192.168.0.42", "http://10.0.2.2:8080/api/files?path=%2F", "http://172.20.1.1", "http://crosspoint.local/x", "http://crosspoint", "http://[::1]:80", "http://[fe80::1]")) {
            assertTrue(url, LocalHttpService.isLocal(url))
        }
        for (url in listOf("http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://user:pw@192.168.0.2", "ftp://192.168.0.2", "file:///etc/passwd", "http://[2001:db8::1]", "not a url")) {
            assertFalse(url, LocalHttpService.isLocal(url))
        }
        assertTrue(runCatching { service().fetch("http://example.com/", "GET", JSONArray(), null) }.exceptionOrNull() is IllegalArgumentException)
        assertTrue(runCatching { service().fetch("$base/", "CONNECT", JSONArray(), null) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun saysWhenTheReaderCantBeReached() {
        stop()
        val error = runCatching { service().fetch("$base/api/status", "GET", JSONArray(), null) }.exceptionOrNull()
        assertTrue(error is IOException)
        assertTrue(error!!.message!!.startsWith("Couldn’t reach $base/api/status"))
    }

    @Test
    fun goesThroughTheRouter() {
        val router = RpcRouter(localHttpRoutes(service()))
        val request = JSONObject()
            .put("id", 1).put("method", "POST").put("url", "api/localHttp/fetch")
            .put("body", JSONObject().put("url", "$base/api/status").put("method", "GET").put("headers", JSONArray()))
        val response = router.handle(request)
        assertTrue(response.toString(), response.getBoolean("ok"))
        assertEquals(200, response.getJSONObject("value").getInt("status"))
    }
}
