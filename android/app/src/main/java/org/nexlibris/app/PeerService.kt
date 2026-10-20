package org.nexlibris.app

import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The peer API (common/src/peerApi.ts): calls a sync hub's API on the page's behalf, since the
 * page (served over https) may not call a plain-http address. Only sync API calls are made, and
 * the hub's reply goes back as it came, status and body, for the page to read. Files move straight
 * between the hub and [storage], streamed, rather than through the page.
 */
class PeerService(
    /** Where the open library stores files. */
    private val storage: () -> PathStorage,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    constructor(storage: PathStorage, open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) :
        this({ storage }, open)

    fun call(address: String, url: String, key: String?, body: String): JSONObject {
        require(isAllowed(address, url)) { "Not a sync call: $address/$url" }
        val connection = try {
            open(URL("$address/$url"))
        } catch (e: IOException) {
            throw unreachable(address, e)
        }
        reusing(connection) {
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            if (key != null) connection.setRequestProperty("Authorization", "Bearer $key")
            val status = reaching(address) {
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                connection.responseCode
            }
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return JSONObject().put("status", status).put("text", text)
        }
    }

    /** Fetches a file from the hub into the library's stored files; refused unless it hashes to [hash]. */
    fun download(address: String, key: String, hash: String): JSONObject {
        val connection = fileConnection(address, key, hash)
        reusing(connection) {
            val status = reaching(address) { connection.responseCode }
            if (status != HttpURLConnection.HTTP_OK) throw IOException(hubError(connection, status))
            val stored = connection.inputStream.use { storage().putStream(it, hash) }
            return JSONObject().put("size", stored.size)
        }
    }

    /** Sends a stored file to the hub. */
    fun upload(address: String, key: String, hash: String): JSONObject {
        val library = storage()
        val size = library.size(storedFilePath(hash)) ?: throw FileNotFoundException("That file isn’t stored here.")
        val connection = fileConnection(address, key, hash)
        reusing(connection) {
            connection.requestMethod = "PUT"
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(size)
            connection.setRequestProperty("Content-Type", "application/octet-stream")
            val status = reaching(address) {
                connection.outputStream.use { out -> library.openStored(hash).use { it.copyTo(out) } }
                connection.responseCode
            }
            if (status != HttpURLConnection.HTTP_OK) throw IOException(hubError(connection, status))
            connection.inputStream.use { it.readBytes() }
            return JSONObject().put("size", size)
        }
    }

    private fun fileConnection(address: String, key: String, hash: String): HttpURLConnection {
        require(ADDRESS.matches(address) && FILE_HASH.matches(hash)) { "Not a sync file: $address $hash" }
        val connection = try {
            open(URL("$address/api/sync/files/$hash"))
        } catch (e: IOException) {
            throw unreachable(address, e)
        }
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.setRequestProperty("Authorization", "Bearer $key")
        return connection
    }

    /** The message in a hub's error reply (estuary-rpc's `{status: "error", message}`), or the HTTP status. */
    private fun hubError(connection: HttpURLConnection, status: Int): String {
        val text = connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        return runCatching { JSONObject(text).getString("message") }.getOrElse { "The hub replied with HTTP $status." }
    }

    /**
     * Runs [block], which reads the hub's reply to the end, then leaves [connection] open for the
     * next call to reuse; one that failed partway is dropped. Opening a connection to the hub took
     * up to a second from the Android emulator, which made a sync's files crawl.
     */
    private inline fun <T> reusing(connection: HttpURLConnection, block: () -> T): T =
        try {
            block()
        } catch (e: Throwable) {
            connection.disconnect()
            throw e
        }

    /** Runs [block], which talks to the hub, turning a failure to reach it into a message saying so. */
    private fun <T> reaching(address: String, block: () -> T): T =
        try {
            block()
        } catch (e: IOException) {
            throw unreachable(address, e)
        }

    private fun unreachable(address: String, cause: IOException) =
        IOException("Couldn’t reach $address. Check that it’s on the same network, with sync turned on.", cause)

    companion object {
        const val CONNECT_TIMEOUT_MS = 5_000
        const val READ_TIMEOUT_MS = 120_000
        private val ADDRESS = Regex("""^https?://[^/?#@]+$""")
        private val SYNC_URL = Regex("""^api/sync/[a-z]+$""")
        private val FILE_HASH = Regex("""^[0-9a-f]{64}$""")

        /** As `isPeerCallAllowed` in common/src/peerApi.ts. */
        fun isAllowed(address: String, url: String) = ADDRESS.matches(address) && SYNC_URL.matches(url)
    }
}
