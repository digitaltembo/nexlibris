import Foundation

/**
 * The peer API (common/src/peerApi.ts): calls a sync hub's API on the page's behalf, since the
 * page (on the app's own `app://` origin, a secure one) may not call a plain-http address. Only
 * sync API calls are made, and the hub's reply goes back as it came, status and body, for the page
 * to read. Files move straight between the hub and [storage], streamed, rather than through the page.
 */
public final class PeerService {
    static let readTimeout: TimeInterval = 120
    private static let address = #"https?://[^/?#@]+"#
    private static let syncUrl = #"api/sync/[a-z]+"#
    private static let fileHash = #"[0-9a-f]{64}"#

    /// As `isPeerCallAllowed` in common/src/peerApi.ts.
    public static func isAllowed(address: String, url: String) -> Bool {
        matches(Self.address, address) && matches(Self.syncUrl, url)
    }

    /// Where the open library stores files.
    private let storage: () -> FileStorage
    private let http = BlockingSession(timeout: readTimeout)

    public init(storage: @escaping () -> FileStorage) {
        self.storage = storage
    }

    public func call(address: String, url: String, key: String?, body: String) throws -> JSONObject {
        try require(Self.isAllowed(address: address, url: url), "Not a sync call: \(address)/\(url)")
        guard let target = URL(string: "\(address)/\(url)") else { throw NexlibrisError("Not a sync call: \(address)/\(url)") }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        request.httpBody = Data(body.utf8)
        let reply = try reaching(address) { try http.data(request) }
        return ["status": reply.response.statusCode, "text": String(decoding: reply.data, as: UTF8.self)]
    }

    /// Fetches a file from the hub into the library's stored files; refused unless it hashes to [hash].
    public func download(address: String, key: String, hash: String) throws -> JSONObject {
        let request = try fileRequest(address, key, hash)
        let library = storage()
        let stored = try reaching(address) {
            try http.download(request) { response, file -> StoredFile in
                guard response.statusCode == 200 else { throw NexlibrisError(hubError(try? Data(contentsOf: file), response.statusCode)) }
                return try library.put(file: file, expected: hash)
            }
        }
        return ["size": stored.size]
    }

    /// Sends a stored file to the hub.
    public func upload(address: String, key: String, hash: String) throws -> JSONObject {
        let library = storage()
        guard let size = try library.size(storedFilePath(hash)) else { throw NexlibrisError("That file isn’t stored here.") }
        var request = try fileRequest(address, key, hash)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let reply = try reaching(address) { try http.data(request, body: try library.storedURL(hash)) }
        guard reply.response.statusCode == 200 else { throw NexlibrisError(hubError(reply.data, reply.response.statusCode)) }
        return ["size": size]
    }

    private func fileRequest(_ address: String, _ key: String, _ hash: String) throws -> URLRequest {
        try require(matches(Self.address, address) && matches(Self.fileHash, hash), "Not a sync file: \(address) \(hash)")
        guard let url = URL(string: "\(address)/api/sync/files/\(hash)") else { throw NexlibrisError("Not a sync file: \(address) \(hash)") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// Runs [block], which talks to the hub, turning a failure to reach it into a message saying so.
    private func reaching<T>(_ address: String, _ block: () throws -> T) throws -> T {
        do {
            return try block()
        } catch where isNetworkError(error) {
            throw NexlibrisError("Couldn’t reach \(address). Check that it’s on the same network, with sync turned on.")
        }
    }
}

/// The message in a hub's error reply (estuary-rpc's `{status: "error", message}`), or the HTTP status.
func hubError(_ body: Data?, _ status: Int) -> String {
    if let body, let reply = (try? JSONSerialization.jsonObject(with: body)) as? JSONObject, let message = reply["message"] as? String {
        return message
    }
    return "The hub replied with HTTP \(status)."
}
