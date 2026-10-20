import CryptoKit
import Foundation

/// A stored file: its hash and size.
public struct StoredFile: Equatable {
    public let hash: String
    public let size: Int64
}

/// Where a stored file lives, by hash: `storedFilePath` in common/src/importApi.ts.
public func storedFilePath(_ hash: String) -> String { "files/\(hash.prefix(2))/\(hash)" }

/// Files the system leaves in folders, which don't stop one counting as empty (as in desktop/src/libraryFolder.ts).
let ignoredNames: Set<String> = [".DS_Store", "Thumbs.db", "desktop.ini"]

/// Bytes read or written at a time.
private let blockSize = 256 * 1024

/**
 * Files in a folder, by slash-separated path: the native side of the storage API in
 * common/src/storageApi.ts. The library in the app's own storage, a folder of the user's that a
 * library is kept in ([LibraryFolderService]), or the sync folder ([SyncFolderService]): on iOS a
 * folder picked in Files is reached as plain files (once its security scope is entered), so one
 * kind of storage serves all three, where Android needs a second over its storage provider.
 *
 * Besides the storage API, it lists hidden files, streams files in, moves them (`Storage.move`) and
 * deletes folders, for moving a library. Not thread-safe; [NativeBridge] runs every call on one queue.
 */
public final class FileStorage {
    public let root: URL
    private let files = FileManager.default

    public init(root: URL) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        self.root = URL(fileURLWithPath: canonicalPath(root.path), isDirectory: true)
    }

    public func readText(_ path: String) throws -> String? {
        let file = try resolve(path)
        guard isFile(file) else { return nil }
        return String(decoding: try Data(contentsOf: file), as: UTF8.self)
    }

    public func writeText(_ path: String, _ text: String) throws {
        try replace(try resolve(path)) { temp in try Data(text.utf8).write(to: temp) }
    }

    public func appendText(_ path: String, _ text: String) throws {
        let file = try resolve(path)
        try makeParent(file)
        if !files.fileExists(atPath: file.path) { files.createFile(atPath: file.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
        // The change log is appended to; make each append durable before reporting success.
        try handle.synchronize()
    }

    public func exists(_ path: String) throws -> Bool { isFile(try resolve(path)) }

    public func size(_ path: String) throws -> Int64? {
        let file = try resolve(path)
        guard isFile(file) else { return nil }
        return (try files.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
    }

    /// Base64 of up to [length] bytes starting at [offset].
    public func readChunk(_ path: String, offset: Int64, length: Int) throws -> String {
        try require(offset >= 0 && length >= 0, "Bad range: \(offset)+\(length)")
        let file = try resolve(path)
        guard isFile(file) else { throw NexlibrisError("No file: \(path)") }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return (try handle.read(upToCount: length) ?? Data()).base64EncodedString()
    }

    /**
     * Appends a chunk to an upload in progress, which replaces the file at [path]
     * only once the [last] chunk arrives, so readers never see a partial file.
     */
    public func writeChunk(_ path: String, data: String, first: Bool, last: Bool) throws {
        let file = try resolve(path)
        let upload = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).upload")
        let bytes = try decodeBase64(data)
        if first {
            try makeParent(file)
            try? files.removeItem(at: upload)
            files.createFile(atPath: upload.path, contents: nil)
        } else {
            try require(isFile(upload), "No upload in progress: \(path)")
        }
        let handle = try FileHandle(forWritingTo: upload)
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
        try handle.close()
        if last { try commit(upload, file) }
    }

    /// The names in a folder, hidden ones left out; none if it doesn't exist.
    public func list(_ path: String) throws -> [String] {
        try names(in: try resolve(path)).filter { !$0.hasPrefix(".") }
    }

    public func remove(_ path: String) throws {
        let file = try resolve(path)
        if isFile(file) { try files.removeItem(at: file) }
    }

    /**
     * Stores [input] as a content-addressed file, where common/src/backend.ts keeps them
     * ([storedFilePath]), hashing it as it's copied. Storing contents already there is a no-op.
     * With [expected], contents with any other hash are discarded and it throws.
     */
    @discardableResult
    public func put(_ input: InputStream, expected: String? = nil) throws -> StoredFile {
        let temp = try tempFile()
        defer { try? files.removeItem(at: temp) }
        var hasher = SHA256()
        var size: Int64 = 0
        let out = try FileHandle(forWritingTo: temp)
        input.open()
        defer { input.close() }
        var buffer = [UInt8](repeating: 0, count: blockSize)
        while true {
            let read = input.read(&buffer, maxLength: blockSize)
            if read < 0 { throw input.streamError ?? NexlibrisError("Couldn’t read the file.") }
            if read == 0 { break }
            let chunk = Data(buffer[0..<read])
            hasher.update(data: chunk)
            try out.write(contentsOf: chunk)
            size += Int64(read)
        }
        try out.synchronize()
        try out.close()
        return try store(temp, hash: hex(hasher.finalize()), size: size, expected: expected)
    }

    /// Stores the file at [file] (one of the system's downloads, say) by its hash, moving it in.
    @discardableResult
    public func put(file: URL, expected: String? = nil) throws -> StoredFile {
        let temp = try tempFile()
        defer { try? files.removeItem(at: temp) }
        try files.removeItem(at: temp)
        try files.moveItem(at: file, to: temp)
        var hasher = SHA256()
        let handle = try FileHandle(forReadingFrom: temp)
        var size: Int64 = 0
        while let chunk = try handle.read(upToCount: blockSize), !chunk.isEmpty {
            hasher.update(data: chunk)
            size += Int64(chunk.count)
        }
        try handle.close()
        return try store(temp, hash: hex(hasher.finalize()), size: size, expected: expected)
    }

    private func tempFile() throws -> URL {
        let dir = try resolve("files")
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
        let temp = dir.appendingPathComponent(".put-\(UUID().uuidString).tmp")
        files.createFile(atPath: temp.path, contents: nil)
        return temp
    }

    private func store(_ temp: URL, hash: String, size: Int64, expected: String?) throws -> StoredFile {
        if let expected, hash != expected {
            throw NexlibrisError("The file’s contents don’t match its hash (expected \(expected.prefix(12))…, got \(hash.prefix(12))…).")
        }
        let file = try resolve(storedFilePath(hash))
        if !isFile(file) {
            try makeParent(file)
            try rename(temp, file)
        }
        return StoredFile(hash: hash, size: size)
    }

    /// A stored file, by hash, to read.
    public func openStored(_ hash: String) throws -> InputStream {
        let file = try storedURL(hash)
        guard let stream = InputStream(url: file) else { throw NexlibrisError("That file isn’t stored here.") }
        return stream
    }

    /// Where a stored file is, by hash; throws if it isn't stored here.
    public func storedURL(_ hash: String) throws -> URL {
        let file = try resolve(storedFilePath(hash))
        guard isFile(file) else { throw NexlibrisError("That file isn’t stored here.") }
        return file
    }

    /// Every name in a folder ("" for the top), hidden ones too; none if it isn't one.
    public func listAll(_ path: String) throws -> [String] {
        try names(in: try dir(path))
    }

    /// A folder's names, with iCloud's placeholders for files not downloaded (`.Name.epub.icloud`) named as the files.
    private func names(in folder: URL) throws -> [String] {
        let names = (try? files.contentsOfDirectory(atPath: folder.path)) ?? []
        return Set(names.map { cloudPlaceholderOf($0) ?? $0 }).sorted()
    }

    public func isFolder(_ path: String) throws -> Bool {
        var folder: ObjCBool = false
        return files.fileExists(atPath: try dir(path).path, isDirectory: &folder) && folder.boolValue
    }

    /// Reads a file; nil if there's none.
    public func open(_ path: String) throws -> InputStream? {
        let file = try resolve(path)
        return isFile(file) ? InputStream(url: file) : nil
    }

    /// The file at [path] if there is one, for serving it.
    public func fileURL(_ path: String) throws -> URL? {
        let file = try resolve(path)
        return isFile(file) ? file : nil
    }

    /// Writes [input] to [path] whole, replacing what's there, and the folders it's in.
    public func writeStream(_ path: String, _ input: InputStream) throws {
        try replace(try resolve(path)) { temp in
            files.createFile(atPath: temp.path, contents: nil)
            let out = try FileHandle(forWritingTo: temp)
            defer { try? out.close() }
            input.open()
            defer { input.close() }
            var buffer = [UInt8](repeating: 0, count: blockSize)
            while true {
                let read = input.read(&buffer, maxLength: blockSize)
                if read < 0 { throw input.streamError ?? NexlibrisError("Couldn’t read the file.") }
                if read == 0 { break }
                try out.write(contentsOf: Data(buffer[0..<read]))
            }
            try out.synchronize()
        }
    }

    /// Moves a file, replacing any at [to] (`Storage.move`).
    public func move(_ from: String, _ to: String) throws {
        let target = try resolve(to)
        try makeParent(target)
        try rename(try resolve(from), target)
    }

    /// Removes the folders [path] is in while they're empty, up to the top (`Storage.prune`).
    public func prune(_ path: String) throws {
        var dir = try resolve(path).deletingLastPathComponent()
        while dir.path != root.path && dir.path.hasPrefix(root.path + "/") {
            guard let names = try? files.contentsOfDirectory(atPath: dir.path) else { return }
            if names.contains(where: { !ignoredNames.contains($0) }) { return }
            for name in names { try? files.removeItem(at: dir.appendingPathComponent(name)) }
            guard (try? files.removeItem(at: dir)) != nil else { return }
            dir = dir.deletingLastPathComponent()
        }
    }

    /// Deletes a folder and everything in it; "" empties the whole storage.
    public func removeTree(_ path: String) throws {
        if path.isEmpty {
            for name in (try? files.contentsOfDirectory(atPath: root.path)) ?? [] {
                try files.removeItem(at: root.appendingPathComponent(name))
            }
        } else {
            let target = try resolve(path)
            if files.fileExists(atPath: target.path) { try files.removeItem(at: target) }
        }
    }

    /// Every file under [dir] ("" for all), as paths from the top.
    public func filesUnder(_ dir: String) throws -> [String] {
        try listAll(dir).flatMap { name -> [String] in
            let path = dir.isEmpty ? name : "\(dir)/\(name)"
            return try isFolder(path) ? try filesUnder(path) : [path]
        }
    }

    /// The folder for a path, "" being [root].
    private func dir(_ path: String) throws -> URL { path.isEmpty ? root : try resolve(path) }

    /// The file for a library path, refusing anything that would leave [root].
    public func resolve(_ path: String) throws -> URL {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        try require(!path.isEmpty && !segments.contains { $0.isEmpty || $0 == "." || $0 == ".." }, "Bad path: \(path)")
        let file = root.appendingPathComponent(path)
        // Also catches symlinks pointing outside the library.
        try require(canonicalPath(file.path).hasPrefix(root.path + "/"), "Bad path: \(path)")
        return file
    }

    private func isFile(_ url: URL) -> Bool {
        var folder: ObjCBool = false
        if !files.fileExists(atPath: url.path, isDirectory: &folder) {
            guard download(url) else { return false }
            return files.fileExists(atPath: url.path, isDirectory: &folder) && !folder.boolValue
        }
        return !folder.boolValue
    }

    /**
     * Downloads a file iCloud Drive keeps only a placeholder of (a sync folder or library there),
     * waiting for it, as a coordinated read does; false if there's no placeholder.
     */
    private func download(_ url: URL) -> Bool {
        let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        guard files.fileExists(atPath: placeholder.path) else { return false }
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { _ in }
        return error == nil
    }

    private func makeParent(_ file: URL) throws {
        try files.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    private func replace(_ file: URL, write: (URL) throws -> Void) throws {
        try makeParent(file)
        let temp = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).tmp")
        do {
            try write(temp)
            try commit(temp, file)
        } catch {
            try? files.removeItem(at: temp)
            throw error
        }
    }

    private func commit(_ temp: URL, _ file: URL) throws {
        let handle = try FileHandle(forWritingTo: temp)
        try handle.synchronize()
        try handle.close()
        try rename(temp, file)
    }
}

/// Moves [from] to [to] in one step, replacing what's there (rename(2)), as `ATOMIC_MOVE` does on Android.
private func rename(_ from: URL, _ to: URL) throws {
    if Foundation.rename(from.path, to.path) != 0 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: to.path])
    }
}

/// [path] with symlinks resolved, as far as it exists; the rest as given.
private func canonicalPath(_ path: String) -> String {
    var existing = path
    var rest: [String] = []
    while !existing.isEmpty && existing != "/" {
        if let resolved = realpath(existing, nil) {
            defer { free(resolved) }
            let base = String(cString: resolved)
            return ([base == "/" ? "" : base] + rest.reversed()).joined(separator: "/")
        }
        rest.append((existing as NSString).lastPathComponent)
        existing = (existing as NSString).deletingLastPathComponent
    }
    return path
}

/// The file an iCloud placeholder's name stands for (`.Name.epub.icloud` for `Name.epub`), or nil if it isn't one.
func cloudPlaceholderOf(_ name: String) -> String? {
    guard name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > ".icloud".count + 1 else { return nil }
    return String(name.dropFirst().dropLast(".icloud".count))
}

private func hex(_ digest: SHA256.Digest) -> String { digest.map { String(format: "%02x", $0) }.joined() }

/// Copies a stored file from one storage to another, checking its hash on the way.
@discardableResult
public func copyStoredFile(from: FileStorage, to: FileStorage, hash: String) throws -> StoredFile {
    try to.put(try from.openStored(hash), expected: hash)
}
