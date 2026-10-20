import Foundation
import WebKit

/// The app's own origin: the page is served at `app://nexlibris/`, as the desktop app's is.
public enum AppOrigin {
    public static let scheme = "app"
    public static let host = "nexlibris"
    public static let start = URL(string: "\(scheme)://\(host)/")!

    public static func contains(_ url: URL?) -> Bool { url?.scheme == scheme && url?.host == host }
}

/// The library paths the page may fetch: `servedLibraryPath` in common/src/placedLibrary.ts.
public func servedLibraryPath(_ path: String, placed: Bool) -> Bool {
    let data = "\(LibraryFolderService.dataDir)/"
    if placed && !path.hasPrefix(data) { return !path.hasPrefix(".") && !path.contains("/.") }
    let inner = placed ? String(path.dropFirst(data.count)) : path
    return inner.hasPrefix("files/") || inner.hasPrefix("local/thumbs/")
}

/// The file a `/library/` path names (e.g. `files/ab/abcd…`), or nil if there's none or it isn't served.
public func servedFile(_ tree: FileStorage, placed: Bool, path: String) -> URL? {
    guard servedLibraryPath(path, placed: placed) else { return nil }
    return (try? tree.fileURL(path)) ?? nil
}

/**
 * Serves the page's origin, `app://nexlibris/` (WebKit treats a scheme served by the app as a
 * secure one, so modules, workers, storage and the camera behave as on https):
 *
 * - the built web app (client/dist, copied into the app as `www`) with the MIME types modules and
 *   WebAssembly need, paths without an extension getting index.html, as Android's
 *   `WebAppPathHandler.kt`;
 * - the library's stored files (covers, books) at `/library/files/…`, and the thumbnails made of
 *   covers at `/library/local/thumbs/…`, so the page fetches them directly instead of reading them
 *   through the bridge as base64 chunks. In a folder of the user's, the books placed in it are
 *   served too, and its own files under `/library/.nexlibris/` (`servedLibraryPath` in
 *   common/src/placedLibrary.ts). Only those: never library.json and the like.
 *
 * [library] gives the open library's storage, and whether it's laid out in a folder.
 */
public final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let index = "index.html"
    private static let mimeTypes = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "json": "application/json", "map": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
        "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "txt": "text/plain",
    ]
    /// Content-addressed, so a file at a path never changes.
    private static let immutable = "private, max-age=31536000, immutable"

    private let webApp: URL
    private let library: () -> (FileStorage, Bool)
    private let reading = DispatchQueue(label: "org.nexlibris.serve", attributes: .concurrent)
    /// Tasks WebKit has stopped, which mustn't be answered any more; only touched on the main queue.
    private var stopped = Set<ObjectIdentifier>()

    public init(webApp: URL, library: @escaping () -> (FileStorage, Bool)) {
        self.webApp = webApp
        self.library = library
    }

    /// What answers a path: the file, its type and how long to cache it; nil for a 404.
    func resolve(_ url: URL) -> (file: URL, type: String, cache: String?)? {
        let path = url.path
        if path.hasPrefix("/library/") {
            let relative = String(path.dropFirst("/library/".count))
            let (tree, placed) = library()
            guard let file = servedFile(tree, placed: placed, path: relative) else { return nil }
            // A placed book can be renamed, and its path then names another file; stored files never change.
            let cache = placed && !relative.hasPrefix(".nexlibris/") ? "no-cache" : Self.immutable
            return (file, "application/octet-stream", cache)
        }
        let name = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let file = name.isEmpty ? Self.index : name
        if file.split(separator: "/").contains("..") { return nil }
        let ext = (file as NSString).pathExtension.lowercased()
        let target = webApp.appendingPathComponent(file)
        var folder: ObjCBool = false
        if FileManager.default.fileExists(atPath: target.path, isDirectory: &folder), !folder.boolValue {
            return (target, Self.mimeTypes[ext] ?? "application/octet-stream", nil)
        }
        return ext.isEmpty ? (webApp.appendingPathComponent(Self.index), "text/html", nil) : nil
    }

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let id = ObjectIdentifier(task)
        reading.async { [self] in
            guard let found = resolve(url), let input = try? FileHandle(forReadingFrom: found.file) else {
                deliver(id, task) {
                    task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!)
                    task.didReceive(Data("Not Found".utf8))
                    task.didFinish()
                }
                return
            }
            defer { try? input.close() }
            let size = (try? FileManager.default.attributesOfItem(atPath: found.file.path)[.size] as? NSNumber)?.intValue ?? 0
            var headers = ["Content-Type": found.type, "Content-Length": String(size)]
            if found.type.hasPrefix("text/") || found.type == "application/json" { headers["Content-Type"] = "\(found.type); charset=utf-8" }
            if let cache = found.cache { headers["Cache-Control"] = cache }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            guard deliver(id, task, { task.didReceive(response) }) else { return }
            while let chunk = try? input.read(upToCount: 512 * 1024), !chunk.isEmpty {
                guard deliver(id, task, { task.didReceive(chunk) }) else { return }
            }
            deliver(id, task) { task.didFinish() }
        }
    }

    public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    /// Runs [answer] on the main queue unless WebKit stopped the task; false once it has.
    @discardableResult
    private func deliver(_ id: ObjectIdentifier, _ task: WKURLSchemeTask, _ answer: @escaping () -> Void) -> Bool {
        let done = Waiter<Bool>()
        DispatchQueue.main.async { [self] in
            if stopped.contains(id) {
                done.finish(false)
                return
            }
            answer()
            done.finish(true)
        }
        return done.wait()!
    }
}
