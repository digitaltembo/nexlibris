package org.nexlibris.app

import org.json.JSONObject

/**
 * Serves estuary-rpc requests for the storage API (common/src/storageApi.ts),
 * matched by method and URL as the web app's message client sends them.
 */
class StorageRouter(private val storage: StorageService) {
    private val routes: Map<String, (JSONObject) -> Any?> = mapOf(
        "GET api/storage/readText" to { b -> storage.readText(b.getString("path")) },
        "POST api/storage/writeText" to { b -> storage.writeText(b.getString("path"), b.getString("text")) },
        "POST api/storage/appendText" to { b -> storage.appendText(b.getString("path"), b.getString("text")) },
        "GET api/storage/exists" to { b -> storage.exists(b.getString("path")) },
        "GET api/storage/size" to { b -> storage.size(b.getString("path")) },
        "GET api/storage/readChunk" to { b ->
            storage.readChunk(b.getString("path"), b.getLong("offset"), b.getInt("length"))
        },
        "POST api/storage/writeChunk" to { b ->
            storage.writeChunk(b.getString("path"), b.getString("data"), b.getBoolean("first"), b.getBoolean("last"))
        },
    )

    /** Answers a request with `{ok: true, value}` or `{ok: false, message}`, as the client expects. */
    fun handle(request: JSONObject): JSONObject {
        val key = "${request.optString("method")} ${request.optString("url")}"
        val route = routes[key] ?: return failure("No endpoint for $key")
        return try {
            val body = request.optJSONObject("body") ?: JSONObject()
            JSONObject().put("ok", true).put("value", route(body).toJsonValue())
        } catch (e: Exception) {
            failure(e.message ?: e.toString())
        }
    }

    private fun failure(message: String) = JSONObject().put("ok", false).put("message", message)

    private fun Any?.toJsonValue(): Any = when (this) {
        null, Unit -> JSONObject.NULL
        else -> this
    }
}
