package org.nexlibris.app

import org.json.JSONObject

/** One endpoint: takes the request body, returns the response value (null or Unit for none). */
typealias Route = (JSONObject) -> Any?

/**
 * Serves estuary-rpc requests, matched by method and URL as the web app's
 * message client sends them (common/src/rpc.ts).
 */
class RpcRouter(vararg routeTables: Map<String, Route>) {
    private val routes: Map<String, Route> = routeTables.fold(emptyMap()) { all, table -> all + table }

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

/** The storage API (common/src/storageApi.ts). */
fun storageRoutes(storage: StorageService): Map<String, Route> = mapOf(
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

/** The save API (common/src/saveApi.ts). */
fun saveRoutes(saves: SaveService): Map<String, Route> = mapOf(
    "POST api/save/chunk" to { b -> saves.chunk(b.getString("token"), b.getString("data"), b.getBoolean("first")) },
    "POST api/save/file" to { b -> saves.save(b.getString("token"), b.getString("name"), b.getString("mimeType")) },
)

/** The import API (common/src/importApi.ts). */
fun importRoutes(imports: ImportService): Map<String, Route> = mapOf(
    "POST api/import/pick" to { b ->
        val list = b.getJSONArray("extensions")
        imports.pick((0 until list.length()).map { list.getString(it) })
    },
)
