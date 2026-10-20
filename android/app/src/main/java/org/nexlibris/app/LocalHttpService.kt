package org.nexlibris.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Base64
import java.util.UUID

/**
 * The local HTTP API (common/src/localHttpApi.ts): calls a device on the local network (a CrossPoint
 * reader's web server) on the page's behalf, since the page (served over https) may not call a plain-http
 * address. Only local addresses are called ([isLocal]) and redirects aren't followed. A request's body is
 * staged in chunks under a token, into [dir]; a reply's comes back whole when small, else is kept there
 * under a token for the page to read in chunks, then close.
 *
 * Not thread-safe; [NativeBridge] runs every call on one thread.
 */
class LocalHttpService(
    private val dir: File,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    init {
        // Anything here is from an earlier run.
        dir.deleteRecursively()
        dir.mkdirs()
    }

    fun stage(token: String, data: String, first: Boolean) {
        val file = staged(token)
        if (first) file.delete() else require(file.isFile) { "No body staged under $token" }
        FileOutputStream(file, true).use { it.write(Base64.getDecoder().decode(data)) }
    }

    fun fetch(url: String, method: String, headers: JSONArray, body: String?): JSONObject {
        require(isLocal(url)) { "Not a device on the local network: $url" }
        require(method in METHODS) { "Not an HTTP method: $method" }
        val upload = body?.let { staged(it) }
        require(upload == null || upload.isFile) { "No body staged under $body" }
        try {
            val connection = try {
                open(URL(url))
            } catch (e: IOException) {
                throw unreachable(url, e)
            }
            try {
                connection.instanceFollowRedirects = false
                connection.requestMethod = method
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                for (i in 0 until headers.length()) {
                    val (name, value) = headers.getJSONArray(i).let { it.getString(0) to it.getString(1) }
                    if (name.lowercase() !in MANAGED_HEADERS) connection.setRequestProperty(name, value)
                }
                if (upload != null) {
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(upload.length())
                }
                val status = try {
                    if (upload != null) connection.outputStream.use { out -> upload.inputStream().use { it.copyTo(out) } }
                    connection.responseCode
                } catch (e: IOException) {
                    throw unreachable(url, e)
                }
                val token = UUID.randomUUID().toString()
                val reply = File(dir, "reply-$token")
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                try {
                    FileOutputStream(reply).use { out -> stream?.use { it.copyTo(out) } }
                } catch (e: IOException) {
                    reply.delete()
                    throw unreachable(url, e)
                }
                val result = JSONObject()
                    .put("status", status)
                    .put("statusText", connection.responseMessage ?: "")
                    .put("headers", replyHeaders(connection))
                    .put("size", reply.length())
                if (reply.length() <= INLINE_BYTES) {
                    result.put("data", Base64.getEncoder().encodeToString(reply.readBytes()))
                    reply.delete()
                } else {
                    result.put("token", token)
                }
                return result
            } catch (e: Throwable) {
                // Read to the end, a connection is left open for the next call to reuse; one that failed partway is dropped.
                connection.disconnect()
                throw e
            }
        } finally {
            upload?.delete()
        }
    }

    /** Base64. */
    fun read(token: String, offset: Long, length: Int): String {
        val file = reply(token)
        require(file.isFile) { "No reply under $token" }
        RandomAccessFile(file, "r").use { input ->
            val bytes = ByteArray(maxOf(0, minOf(length.toLong(), input.length() - offset)).toInt())
            input.seek(offset)
            input.readFully(bytes)
            return Base64.getEncoder().encodeToString(bytes)
        }
    }

    fun close(token: String) {
        reply(token).delete()
    }

    private fun replyHeaders(connection: HttpURLConnection): JSONArray {
        val list = JSONArray()
        for ((name, values) in connection.headerFields) {
            // The status line comes under no name.
            if (name == null) continue
            for (value in values) list.put(JSONArray().put(name).put(value))
        }
        return list
    }

    private fun staged(token: String): File {
        require(TOKEN.matches(token)) { "Bad token: $token" }
        return File(dir, "body-$token")
    }

    private fun reply(token: String): File {
        require(TOKEN.matches(token)) { "Bad token: $token" }
        return File(dir, "reply-$token")
    }

    private fun unreachable(url: String, cause: IOException) =
        IOException("Couldn’t reach ${url.substringBefore('?')}: ${cause.message ?: cause.javaClass.simpleName}", cause)

    companion object {
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 120_000
        /** Replies up to this size come back with the call. */
        const val INLINE_BYTES = 256 * 1024
        private val TOKEN = Regex("[A-Za-z0-9-]{1,64}")
        private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS")
        /** Set by the connection itself. */
        private val MANAGED_HEADERS = setOf("content-length", "host", "connection", "transfer-encoding")
        private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$""")
        private val IPV6_LOCAL = Regex("""^\[(::1|fe[89ab][0-9a-f]?:.*|f[cd][0-9a-f]{0,2}:.*)]$""")
        private val MDNS_NAME = Regex("""^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$""")
        private val PLAIN_NAME = Regex("""^[a-z0-9-]+$""")

        /** As `isLocalAddress` in common/src/localHttpApi.ts. */
        fun isLocal(url: String): Boolean {
            val uri = try {
                URI(url)
            } catch (_: Exception) {
                return false
            }
            if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.rawUserInfo != null) return false
            val host = uri.host?.lowercase() ?: return false
            IPV4.find(host)?.let { match ->
                val a = match.groupValues[1].toInt()
                val b = match.groupValues[2].toInt()
                return a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b in 16..31) || (a == 192 && b == 168)
            }
            if (host.startsWith("[")) return IPV6_LOCAL.matches(host)
            return MDNS_NAME.matches(host) || PLAIN_NAME.matches(host)
        }
    }
}
