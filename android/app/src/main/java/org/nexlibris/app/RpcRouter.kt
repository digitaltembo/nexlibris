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
fun storageRoutes(storage: StorageService): Map<String, Route> = storageRoutes("api/storage") { storage }

/** The storage API's endpoints under [base], over the storage [storage] gives when called. */
fun storageRoutes(base: String, storage: () -> PathStorage): Map<String, Route> = mapOf(
    "GET $base/readText" to { b -> storage().readText(b.getString("path")) },
    "POST $base/writeText" to { b -> storage().writeText(b.getString("path"), b.getString("text")) },
    "POST $base/appendText" to { b -> storage().appendText(b.getString("path"), b.getString("text")) },
    "GET $base/exists" to { b -> storage().exists(b.getString("path")) },
    "GET $base/size" to { b -> storage().size(b.getString("path")) },
    "GET $base/readChunk" to { b ->
        storage().readChunk(b.getString("path"), b.getLong("offset"), b.getInt("length"))
    },
    "POST $base/writeChunk" to { b ->
        storage().writeChunk(b.getString("path"), b.getString("data"), b.getBoolean("first"), b.getBoolean("last"))
    },
    "POST $base/remove" to { b -> storage().remove(b.getString("path")) },
)

/**
 * The sync folder API (common/src/usbFolderApi.ts): the folder as storage, plus listing
 * and copying stored files between it and the [library]. [folder] gives the folder when called
 * (throwing until one is chosen); [info] says where it is, and [choose] asks for it.
 */
fun usbFolderRoutes(
    folder: () -> PathStorage,
    library: PathStorage,
    info: () -> JSONObject,
    choose: () -> JSONObject,
): Map<String, Route> {
    val base = "api/usbFolder"
    return storageRoutes(base, folder) + mapOf(
        "GET $base/info" to { _ -> info() },
        "POST $base/choose" to { _ -> choose() },
        "GET $base/list" to { b -> org.json.JSONArray(folder().list(b.getString("path"))) },
        "POST $base/toFolder" to { b -> copyStoredFile(library, folder(), b.getString("hash")); null },
        "POST $base/fromFolder" to { b -> copyStoredFile(folder(), library, b.getString("hash")); null },
    )
}

/** The Bluetooth hosting API (common/src/bluetoothApi.ts). */
fun bluetoothHostRoutes(host: BluetoothHostService): Map<String, Route> = mapOf(
    "GET api/bluetoothHost/status" to { _ -> host.status() },
    "POST api/bluetoothHost/setEnabled" to { b -> host.setEnabled(b.getBoolean("enabled")) },
    "POST api/bluetoothHost/next" to { b -> host.next(b.optLong("timeoutMs", 20_000)) },
    "POST api/bluetoothHost/send" to { b -> host.send(b.getString("device"), b.getString("data")) },
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
        val names = b.optJSONArray("names")
        imports.pick(
            (0 until list.length()).map { list.getString(it) },
            b.optBoolean("folder", false),
            if (names == null) emptyList() else (0 until names.length()).map { names.getString(it) },
        )
    },
    "POST api/import/store" to { b -> imports.store(b.getString("token"), b.getInt("start")) },
)

/** The peer API (common/src/peerApi.ts). */
fun peerRoutes(peers: PeerService): Map<String, Route> = mapOf(
    "POST api/peer/call" to { b ->
        peers.call(b.getString("address"), b.getString("url"), if (b.isNull("key")) null else b.optString("key"), b.getString("body"))
    },
    "POST api/peer/download" to { b -> peers.download(b.getString("address"), b.getString("key"), b.getString("hash")) },
    "POST api/peer/upload" to { b -> peers.upload(b.getString("address"), b.getString("key"), b.getString("hash")) },
)
