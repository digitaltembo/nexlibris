import Foundation

/**
 * The local HTTP API (common/src/localHttpApi.ts): calls a device on the local network (a CrossPoint
 * reader's web server) on the page's behalf, since the page (on the app's own secure origin) may not
 * call a plain-http address. Only local addresses are called ([isLocal]) and redirects aren't followed.
 * A request's body is staged in chunks under a token, into [dir]; a reply's comes back whole when
 * small, else is kept there under a token for the page to read in chunks, then close.
 *
 * Not thread-safe; [NativeBridge] runs every call on one queue.
 */
public final class LocalHttpService {
    /// Replies up to this size come back with the call.
    public static let inlineBytes = 256 * 1024
    private static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]
    /// Set by the connection itself.
    private static let managedHeaders: Set<String> = ["content-length", "host", "connection", "transfer-encoding"]

    private let dir: URL
    private let http = BlockingSession(timeout: 120, followRedirects: false)
    private let files = FileManager.default

    public init(dir: URL) throws {
        self.dir = dir
        // Anything here is from an earlier run.
        try? files.removeItem(at: dir)
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    public func stage(token: String, data: String, first: Bool) throws {
        let file = try staged(token)
        if first {
            try? files.removeItem(at: file)
            files.createFile(atPath: file.path, contents: nil)
        } else {
            try require(files.fileExists(atPath: file.path), "No body staged under \(token)")
        }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: try decodeBase64(data))
    }

    public func fetch(url: String, method: String, headers: [[String]], body: String?) throws -> JSONObject {
        try require(Self.isLocal(url), "Not a device on the local network: \(url)")
        try require(Self.methods.contains(method), "Not an HTTP method: \(method)")
        let upload = try body.map(staged)
        if let upload { try require(files.fileExists(atPath: upload.path), "No body staged under \(body!)") }
        defer { if let upload { try? files.removeItem(at: upload) } }

        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = method
        for header in headers where header.count == 2 && !Self.managedHeaders.contains(header[0].lowercased()) {
            request.setValue(header[1], forHTTPHeaderField: header[0])
        }
        let token = UUID().uuidString
        let reply = dir.appendingPathComponent("reply-\(token)")
        let response: HTTPURLResponse
        do {
            if let upload {
                let answer = try http.data(request, body: upload)
                try answer.data.write(to: reply)
                response = answer.response
            } else {
                response = try http.download(request) { response, file in
                    try self.files.moveItem(at: file, to: reply)
                    return response
                }
            }
        } catch where isNetworkError(error) {
            try? files.removeItem(at: reply)
            throw NexlibrisError("Couldn’t reach \(url.split(separator: "?", maxSplits: 1).first ?? ""): \(error.localizedDescription)")
        }
        let size = (try files.attributesOfItem(atPath: reply.path)[.size] as? NSNumber)?.intValue ?? 0
        var result: JSONObject = [
            "status": response.statusCode,
            "statusText": HTTPURLResponse.localizedString(forStatusCode: response.statusCode),
            "headers": response.allHeaderFields.compactMap { name, value -> [String]? in
                guard let name = name as? String else { return nil }
                return [name, "\(value)"]
            },
            "size": size,
        ]
        if size <= Self.inlineBytes {
            result["data"] = try Data(contentsOf: reply).base64EncodedString()
            try? files.removeItem(at: reply)
        } else {
            result["token"] = token
        }
        return result
    }

    /// Base64.
    public func read(token: String, offset: Int64, length: Int) throws -> String {
        let file = try replyFile(token)
        try require(files.fileExists(atPath: file.path), "No reply under \(token)")
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(max(0, offset)))
        return (try handle.read(upToCount: max(0, length)) ?? Data()).base64EncodedString()
    }

    public func close(token: String) throws {
        try? files.removeItem(at: try replyFile(token))
    }

    private func staged(_ token: String) throws -> URL {
        try require(matches(tokenPattern, token), "Bad token: \(token)")
        return dir.appendingPathComponent("body-\(token)")
    }

    private func replyFile(_ token: String) throws -> URL {
        try require(matches(tokenPattern, token), "Bad token: \(token)")
        return dir.appendingPathComponent("reply-\(token)")
    }

    /// As `isLocalAddress` in common/src/localHttpApi.ts.
    public static func isLocal(_ url: String) -> Bool {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              parts.user == nil, parts.password == nil, let rawHost = parts.percentEncodedHost?.lowercased(), !rawHost.isEmpty
        else { return false }
        // Bracketed, as Kotlin's URI gives an IPv6 host.
        let host = rawHost.contains(":") && !rawHost.hasPrefix("[") ? "[\(rawHost)]" : rawHost
        if matches(#"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"#, host) {
            let octets = host.split(separator: ".").map { Int($0)! }
            let (a, b) = (octets[0], octets[1])
            return a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
        }
        if host.hasPrefix("[") { return matches(#"\[(::1|fe[89ab][0-9a-f]?:.*|f[cd][0-9a-f]{0,2}:.*)\]"#, host) }
        return matches(#"[a-z0-9-]+(\.[a-z0-9-]+)*\.local"#, host) || matches("[a-z0-9-]+", host)
    }
}
