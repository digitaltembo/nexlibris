import Foundation

/// One endpoint: takes the request body, returns the response value (nil or nothing for none).
public typealias Route = (JSONObject) throws -> Any?

/**
 * Serves estuary-rpc requests, matched by method and URL as the web app's
 * message client sends them (common/src/rpc.ts).
 */
public final class RpcRouter {
    private let routes: [String: Route]

    public init(_ tables: [String: Route]...) {
        routes = tables.reduce(into: [:]) { all, table in all.merge(table) { _, new in new } }
    }

    /// Answers a request with `{ok: true, value}` or `{ok: false, message}`, as the client expects.
    public func handle(_ request: JSONObject) -> JSONObject {
        let key = "\(request["method"] as? String ?? "") \(request["url"] as? String ?? "")"
        guard let route = routes[key] else { return failure("No endpoint for \(key)") }
        do {
            let value = try route(request.object("body") ?? [:])
            return ["ok": true, "value": jsonValue(value)]
        } catch {
            return failure(messageOf(error))
        }
    }

    /// [handle], as JSON text.
    public func reply(to request: JSONObject) -> String {
        let response = handle(request)
        return (try? jsonText(response)) ?? (try! jsonText(failure("The app’s answer wasn’t JSON.")))
    }

    private func failure(_ message: String) -> JSONObject { ["ok": false, "message": message] }

    private func jsonValue(_ value: Any?) -> Any {
        guard let value, !(value is Void) else { return NSNull() }
        return value
    }
}

/// The storage API (common/src/storageApi.ts).
public func storageRoutes(_ storage: FileStorage) -> [String: Route] { storageRoutes("api/storage") { storage } }

/// The storage API's endpoints under [base], over the storage [storage] gives when called.
public func storageRoutes(_ base: String, _ storage: @escaping () throws -> FileStorage) -> [String: Route] {
    [
        "GET \(base)/readText": { b in try storage().readText(try b.string("path")) },
        "POST \(base)/writeText": { b in try storage().writeText(try b.string("path"), try b.string("text")) },
        "POST \(base)/appendText": { b in try storage().appendText(try b.string("path"), try b.string("text")) },
        "GET \(base)/exists": { b in try storage().exists(try b.string("path")) },
        "GET \(base)/size": { b in try storage().size(try b.string("path")) },
        "GET \(base)/readChunk": { b in
            try storage().readChunk(try b.string("path"), offset: try b.int64("offset"), length: try b.int("length"))
        },
        "POST \(base)/writeChunk": { b in
            try storage().writeChunk(try b.string("path"), data: try b.string("data"), first: try b.bool("first"), last: try b.bool("last"))
        },
        "POST \(base)/remove": { b in try storage().remove(try b.string("path")) },
    ]
}

/**
 * The sync folder API (common/src/usbFolderApi.ts): the folder as storage, plus listing
 * and copying stored files between it and the [library]. [folder] gives the folder when called
 * (throwing until one is chosen); [info] says where it is, and [choose] asks for it.
 */
public func usbFolderRoutes(
    folder: @escaping () throws -> FileStorage,
    library: @escaping () -> FileStorage,
    info: @escaping () -> JSONObject,
    choose: @escaping () throws -> JSONObject
) -> [String: Route] {
    let base = "api/usbFolder"
    return storageRoutes(base, folder).merging([
        "GET \(base)/info": { _ in info() },
        "POST \(base)/choose": { _ in try choose() },
        "GET \(base)/list": { b in try folder().list(try b.string("path")) },
        "POST \(base)/toFolder": { b in try copyStoredFile(from: library(), to: folder(), hash: try b.string("hash")); return nil },
        "POST \(base)/fromFolder": { b in try copyStoredFile(from: folder(), to: library(), hash: try b.string("hash")); return nil },
    ]) { _, new in new }
}

/// The library folder API (common/src/libraryFolderApi.ts), as Android and iOS serve it: the desktop app's, but for showing files.
public func libraryFolderRoutes(_ folders: LibraryFolderService) -> [String: Route] {
    let base = "api/libraryFolder"
    return [
        "POST \(base)/location": { _ in folders.location() },
        "POST \(base)/choose": { _ in try folders.choose() },
        "POST \(base)/move": { b in
            let placed = (b.object("placed") ?? [:]).compactMapValues { $0 as? String }
            try folders.move(to: b.optionalString("to"), layout: b.object("layout"), placed: placed)
            return nil
        },
        "POST \(base)/status": { _ in folders.status() },
        "POST \(base)/open": { b in try folders.open(b.optionalString("path")); return nil },
        "POST \(base)/moveFile": { b in try folders.root.move(try b.string("from"), try b.string("to")); return nil },
        "POST \(base)/prune": { b in try folders.root.prune(try b.string("path")); return nil },
    ]
}

/// The Bluetooth hosting API (common/src/bluetoothApi.ts).
public func bluetoothHostRoutes(_ host: BluetoothHostService) -> [String: Route] {
    [
        "GET api/bluetoothHost/status": { _ in host.status() },
        "POST api/bluetoothHost/setEnabled": { b in host.setEnabled(try b.bool("enabled")) },
        "POST api/bluetoothHost/next": { b in host.next(timeoutMs: (b["timeoutMs"] as? NSNumber)?.int64Value ?? 20_000) },
        "POST api/bluetoothHost/send": { b in try host.send(device: try b.string("device"), data: try b.string("data")) },
    ]
}

/// The save API (common/src/saveApi.ts).
public func saveRoutes(_ saves: SaveService) -> [String: Route] {
    [
        "POST api/save/chunk": { b in try saves.chunk(token: try b.string("token"), data: try b.string("data"), first: try b.bool("first")) },
        "POST api/save/file": { b in try saves.save(token: try b.string("token"), name: try b.string("name"), mimeType: try b.string("mimeType")) },
    ]
}

/// The import API (common/src/importApi.ts).
public func importRoutes(_ imports: ImportService) -> [String: Route] {
    [
        "POST api/import/pick": { b in
            guard let extensions = b["extensions"] as? [String] else { throw NexlibrisError("Expected a list for extensions") }
            return try imports.pick(
                extensions: extensions,
                folder: (b["folder"] as? NSNumber)?.boolValue ?? false,
                names: b["names"] as? [String] ?? []
            )
        },
        "POST api/import/store": { b in try imports.store(token: try b.string("token"), start: try b.int("start")) },
    ]
}

/// The peer API (common/src/peerApi.ts).
public func peerRoutes(_ peers: PeerService) -> [String: Route] {
    [
        "POST api/peer/call": { b in
            try peers.call(address: try b.string("address"), url: try b.string("url"), key: b.optionalString("key"), body: try b.string("body"))
        },
        "POST api/peer/download": { b in try peers.download(address: try b.string("address"), key: try b.string("key"), hash: try b.string("hash")) },
        "POST api/peer/upload": { b in try peers.upload(address: try b.string("address"), key: try b.string("key"), hash: try b.string("hash")) },
    ]
}

/// An opaque colour, as red, green and blue from 0 to 1.
public struct RGB: Equatable {
    public let red, green, blue: Double
}

/**
 * The colours around the page (common/src/windowApi.ts): [setColors] paints behind the status bar and
 * home indicator and picks the status bar's shade, given an opaque colour and whether it's dark.
 */
public func windowRoutes(_ setColors: @escaping (RGB, Bool) -> Void) -> [String: Route] {
    ["POST api/window/setColors": { b in setColors(try parseHexColor(try b.string("background")), try b.bool("dark")); return nil }]
}

/// `#rrggbb` as a colour.
public func parseHexColor(_ text: String) throws -> RGB {
    try require(matches("#[0-9a-fA-F]{6}", text), "Not a #rrggbb colour: \(text)")
    let value = Int(text.dropFirst(), radix: 16)!
    return RGB(red: Double(value >> 16 & 0xFF) / 255, green: Double(value >> 8 & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
}

/// The local HTTP API (common/src/localHttpApi.ts).
public func localHttpRoutes(_ local: LocalHttpService) -> [String: Route] {
    [
        "POST api/localHttp/stage": { b in try local.stage(token: try b.string("token"), data: try b.string("data"), first: try b.bool("first")) },
        "POST api/localHttp/fetch": { b in
            try local.fetch(
                url: try b.string("url"),
                method: try b.string("method"),
                headers: b["headers"] as? [[String]] ?? [],
                body: b.optionalString("body")
            )
        },
        "POST api/localHttp/read": { b in try local.read(token: try b.string("token"), offset: try b.int64("offset"), length: try b.int("length")) },
        "POST api/localHttp/close": { b in try local.close(token: try b.string("token")) },
    ]
}
