import Foundation

/**
 * A file the user picked: its name, its size if the system knows it (else 0), and a way to read
 * it. In a folder pick, [path] is where it is, from the folder's name on
 * (`Calibre Library/Frank Herbert/Dune (7)/Dune.epub`).
 */
public struct PickedSource {
    public let name: String
    public let path: String?
    public let size: Int64
    public let open: () throws -> InputStream

    public init(name: String, path: String? = nil, size: Int64 = 0, open: @escaping () throws -> InputStream) {
        self.name = name
        self.path = path
        self.size = size
        self.open = open
    }
}

/// What the user picked, and how to let go of it once it's read (leaving the files' security scope).
public struct Picked {
    public let sources: [PickedSource]
    public let release: () -> Void

    public init(_ sources: [PickedSource], release: @escaping () -> Void = {}) {
        self.sources = sources
        self.release = release
    }
}

/**
 * Importing files: the native side of common/src/importApi.ts. Picked files are copied
 * straight into the library's stored files, so the web app reads them from
 * `/library/files/…` rather than through the bridge. [pick] lists what was chosen; [store] copies
 * it a batch at a time, so the page can show progress.
 *
 * Not thread-safe; [NativeBridge] runs every call on one queue.
 */
public final class ImportService {
    /// As STORE_BATCH_FILES and STORE_BATCH_BYTES in importApi.ts.
    public static let batchFiles = 50
    public static let batchBytes: Int64 = 32 * 1024 * 1024
    public static let replaced = "This import was replaced by another; pick the files again."

    /// Where the open library stores files.
    private let storage: () -> FileStorage
    /**
     * Shows the system's picker, for files or (when passed true) a folder, and blocks until the user
     * chooses; empty if they cancel. A folder's files, hidden ones left out, come with their paths.
     */
    private let choose: (Bool) -> Picked

    /// The latest pick, for [store].
    private var latest: (token: String, picked: Picked, chosen: [PickedSource])?

    public init(storage: @escaping () -> FileStorage, choose: @escaping (_ folder: Bool) -> Picked) {
        self.storage = storage
        self.choose = choose
    }

    /**
     * `{token, files: [{name, path?, size}], skipped: [{name, reason}]}`, as the web app expects. In a
     * folder pick, files with [names] are taken too, and skipped files are named by their path.
     */
    public func pick(extensions: [String], folder: Bool = false, names: [String] = []) throws -> JSONObject {
        let suffixes = extensions.map { ".\($0.lowercased())" }
        let wanted = Set(names.map { $0.lowercased() })
        let picked = choose(folder)
        var chosen: [PickedSource] = []
        var skipped: [JSONObject] = []
        for source in picked.sources {
            let lower = source.name.lowercased()
            if !suffixes.contains(where: { lower.hasSuffix($0) }) && !(folder && wanted.contains(lower)) {
                skipped.append(["name": source.path ?? source.name, "reason": "unsupported file type"])
            } else {
                chosen.append(source)
            }
        }
        latest?.picked.release()
        let token = UUID().uuidString
        latest = (token, picked, chosen)
        return ["token": token, "files": chosen.map { describe($0).merging(["size": $0.size]) { _, new in new } }, "skipped": skipped]
    }

    /// `{files: [{name, path?, hash, size}], skipped, next}`: the next batch of the latest pick, stored.
    public func store(token: String, start: Int) throws -> JSONObject {
        guard let current = latest, current.token == token else { throw NexlibrisError(Self.replaced) }
        var files: [JSONObject] = []
        var skipped: [JSONObject] = []
        var next = start
        var bytes: Int64 = 0
        while next < current.chosen.count && next - start < Self.batchFiles && bytes < Self.batchBytes {
            let source = current.chosen[next]
            next += 1
            do {
                let stored = try storage().put(try source.open())
                files.append(describe(source).merging(["hash": stored.hash, "size": stored.size]) { _, new in new })
                bytes += stored.size
            } catch {
                skipped.append(["name": source.path ?? source.name, "reason": messageOf(error)])
            }
        }
        if next >= current.chosen.count { finish() }
        return ["files": files, "skipped": skipped, "next": next]
    }

    private func finish() {
        latest?.picked.release()
        latest = nil
    }

    private func describe(_ source: PickedSource) -> JSONObject {
        var file: JSONObject = ["name": source.name]
        if let path = source.path { file["path"] = path }
        return file
    }
}

/**
 * The files in a folder and its subfolders, each path starting with the folder's name, in name
 * order. Hidden files and folders (a leading dot) are left out, as a computer hides them; iCloud's
 * placeholders for files not downloaded (`.Name.epub.icloud`) are taken as their files, downloaded
 * when they're read.
 */
public func folderFiles(_ folder: URL) -> [PickedSource] {
    var found: [PickedSource] = []
    let files = FileManager.default
    func visit(_ dir: URL, _ path: String) {
        let names = Set(((try? files.contentsOfDirectory(atPath: dir.path)) ?? []).map { cloudPlaceholderOf($0) ?? $0 }).sorted()
        for name in names where !name.hasPrefix(".") {
            let url = dir.appendingPathComponent(name)
            var folder: ObjCBool = false
            let placeholder = !files.fileExists(atPath: url.path, isDirectory: &folder)
            if folder.boolValue {
                visit(url, "\(path)/\(name)")
            } else {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                found.append(PickedSource(name: name, path: "\(path)/\(name)", size: size) {
                    if placeholder {
                        var error: NSError?
                        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { _ in }
                        if let error { throw error }
                    }
                    guard let stream = InputStream(url: url) else { throw NexlibrisError("Couldn’t open \(path)/\(name)") }
                    return stream
                })
            }
        }
    }
    visit(folder, folder.lastPathComponent)
    return found
}
