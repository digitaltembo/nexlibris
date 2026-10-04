package org.nexlibris.app

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** Calls as client/src/sync/hubSend.ts makes them, to a stand-in hub on localhost. */
class PeerServiceTest {
    private lateinit var server: ServerSocket
    private lateinit var address: String
    private val seen = Collections.synchronizedList(mutableListOf<Triple<String, String?, String>>())

    @get:Rule
    val temp = TemporaryFolder()

    private fun storage() = StorageService(File(temp.root, "library"))

    /**
     * A stand-in hub: for the key "good", answers each POST with `{ok: true, value: {echo: body}}`,
     * and serves and stores [files] at `GET`/`PUT /api/sync/files/<hash>`; anything else gets a 401.
     * Connections are kept alive, and counted in [connections].
     */
    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        address = "http://127.0.0.1:${server.localPort}"
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                connections.incrementAndGet()
                thread(isDaemon = true) { socket.use { serve(it) } }
            }
        }
    }

    private val connections = AtomicInteger()

    private fun serve(socket: Socket) {
        val input = socket.getInputStream()
        while (true) {
            val (method, path) = readLine(input).takeIf { line -> line.isNotEmpty() }?.split(" ") ?: return
            val headers = generateSequence { readLine(input).takeIf { line -> line.isNotEmpty() } }
                .associate { line -> line.substringBefore(":").lowercase() to line.substringAfter(":").trim() }
            val body = input.readNBytes(headers["content-length"]?.toInt() ?: 0)
            val key = headers["authorization"]
            seen += Triple(path, key, body.toString(Charsets.UTF_8))
            val hash = path.removePrefix("/api/sync/files/").takeIf { h -> h != path }
            val (status, reply) = when {
                key != "Bearer good" -> "401 Unauthorized" to """{"ok":false,"message":"Not paired"}""".toByteArray()
                hash != null && method == "PUT" -> {
                    files[hash] = body
                    "200 OK" to """{"ok":true,"value":{"size":${body.size}}}""".toByteArray()
                }
                hash != null -> files[hash]?.let { bytes -> "200 OK" to bytes }
                    ?: ("404 Not Found" to """{"ok":false,"message":"That file isn’t on this computer."}""".toByteArray())
                else -> "200 OK" to """{"ok":true,"value":{"echo":${body.toString(Charsets.UTF_8)}}}""".toByteArray()
            }
            val out = socket.getOutputStream()
            out.write("HTTP/1.1 $status\r\nContent-Length: ${reply.size}\r\n\r\n".toByteArray())
            out.write(reply)
            out.flush()
        }
    }

    private val files = ConcurrentHashMap<String, ByteArray>()

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

    @Test
    fun passesTheHubsReplyBackAsItCame() {
        val result = PeerService(storage()).call(address, "api/sync/hello", "good", """{"since":3}""")
        assertEquals(200, result.getInt("status"))
        assertEquals(3, JSONObject(result.getString("text")).getJSONObject("value").getJSONObject("echo").getInt("since"))
        assertEquals(Triple("/api/sync/hello", "Bearer good", """{"since":3}"""), seen.single())

        val refused = PeerService(storage()).call(address, "api/sync/state", null, "null")
        assertEquals(401, refused.getInt("status"))
        assertEquals("Not paired", JSONObject(refused.getString("text")).getString("message"))
        assertEquals(null, seen.last().second)
    }

    @Test
    fun goesThroughTheRouter() {
        val router = RpcRouter(peerRoutes(PeerService(storage())))
        val request = JSONObject()
            .put("id", 1).put("method", "POST").put("url", "api/peer/call")
            .put("body", JSONObject().put("address", address).put("url", "api/sync/pair").put("key", JSONObject.NULL).put("body", "{}"))
        val response = router.handle(request)
        assertTrue(response.getBoolean("ok"))
        assertEquals(401, response.getJSONObject("value").getInt("status"))
    }

    @Test
    fun makesOnlySyncCalls() {
        assertTrue(PeerService.isAllowed("http://192.168.0.11:47811", "api/sync/state"))
        assertFalse(PeerService.isAllowed("http://192.168.0.11:47811/x", "api/sync/state"))
        assertFalse(PeerService.isAllowed("http://user@evil:1", "api/sync/state"))
        assertFalse(PeerService.isAllowed("file:///etc", "api/sync/state"))
        assertFalse(PeerService.isAllowed("http://192.168.0.11", "api/storage/readText"))
        assertFalse(PeerService.isAllowed("http://192.168.0.11", "api/sync/../storage"))
        val error = runCatching { PeerService(storage()).call("http://x", "api/other", null, "{}") }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun saysWhenTheHubCantBeReached() {
        stop()
        val error = runCatching { PeerService(storage()).call(address, "api/sync/hello", "good", "null") }.exceptionOrNull()
        assertTrue(error is IOException)
        assertTrue(error!!.message!!.startsWith("Couldn’t reach $address"))
    }

    @Test
    fun movesFilesStraightBetweenTheHubAndStorage() {
        val storage = storage()
        val peers = PeerService(storage)
        val book = "a book".toByteArray()
        val hash = sha256(book)
        files[hash] = book
        assertEquals(book.size, peers.download(address, "good", hash).getInt("size"))
        assertArrayEquals(book, storage.resolve(storedFilePath(hash)).readBytes())

        val mine = storage.putStream("mine".toByteArray().inputStream())
        assertEquals(4, peers.upload(address, "good", mine.hash).getInt("size"))
        assertArrayEquals("mine".toByteArray(), files[mine.hash])
        assertEquals("Bearer good", seen.last().second)

        // Not stored under a hash it doesn't have; the hub's own message for a file it lacks.
        val other = sha256("other".toByteArray())
        files[other] = "tampered".toByteArray()
        val wrong = runCatching { peers.download(address, "good", other) }.exceptionOrNull()
        assertTrue(wrong!!.message!!.startsWith("The file's contents don't match"))
        assertFalse(storage.resolve(storedFilePath(other)).exists())
        val absent = runCatching { peers.download(address, "good", "0".repeat(64)) }.exceptionOrNull()
        assertEquals("That file isn’t on this computer.", absent!!.message)
        assertEquals("Not paired", runCatching { peers.download(address, "bad", hash) }.exceptionOrNull()!!.message)

        // Only stored files, only by hash.
        assertTrue(runCatching { peers.upload(address, "good", "1".repeat(64)) }.exceptionOrNull() is FileNotFoundException)
        assertTrue(runCatching { peers.download(address, "good", "../../x") }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun reusesTheConnection() {
        val storage = storage()
        val peers = PeerService(storage)
        val book = "reused".toByteArray()
        val hash = sha256(book)
        files[hash] = book
        peers.call(address, "api/sync/hello", "good", "null")
        peers.download(address, "good", hash)
        peers.upload(address, "good", hash)
        peers.call(address, "api/sync/hello", "bad", "null")
        peers.call(address, "api/sync/hello", "good", "null")
        assertEquals(1, connections.get())
    }

    @Test
    fun routesFileCalls() {
        val book = "routed".toByteArray()
        val hash = sha256(book)
        files[hash] = book
        val router = RpcRouter(peerRoutes(PeerService(storage())))
        val request = JSONObject()
            .put("id", 1).put("method", "POST").put("url", "api/peer/download")
            .put("body", JSONObject().put("address", address).put("key", "good").put("hash", hash))
        val response = router.handle(request)
        assertTrue(response.toString(), response.getBoolean("ok"))
        assertEquals(book.size, response.getJSONObject("value").getInt("size"))
    }

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
