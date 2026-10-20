import Foundation

/**
 * Saving files out of the app: the native side of common/src/saveApi.ts. A file arrives in chunks
 * under a token, into [dir]; [save] then names it and asks the user where it should go (the
 * system's export picker), which copies it there.
 *
 * Not thread-safe; [NativeBridge] runs every call on one queue.
 */
public final class SaveService {
    private let dir: URL
    /// Offers the file (named as it should be saved) to the user; true if they saved it, false if they cancelled. Blocks until they choose.
    private let chooseDestination: (URL, String) -> Bool
    private let files = FileManager.default

    public init(dir: URL, chooseDestination: @escaping (_ file: URL, _ mimeType: String) -> Bool) throws {
        self.dir = dir
        self.chooseDestination = chooseDestination
        // Anything here is from an earlier run that never finished.
        try? files.removeItem(at: dir)
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    public func chunk(token: String, data: String, first: Bool) throws {
        let file = try upload(token)
        if first {
            try? files.removeItem(at: file)
            files.createFile(atPath: file.path, contents: nil)
        } else {
            try require(files.fileExists(atPath: file.path), "No upload in progress: \(token)")
        }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: try decodeBase64(data))
    }

    /// True if saved, false if the user cancelled. The upload is discarded either way.
    public func save(token: String, name: String, mimeType: String) throws -> Bool {
        let file = try upload(token)
        try require(files.fileExists(atPath: file.path), "No upload in progress: \(token)")
        let folder = dir.appendingPathComponent("\(token).named")
        defer {
            try? files.removeItem(at: file)
            try? files.removeItem(at: folder)
        }
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        let named = folder.appendingPathComponent(safeFileName(name))
        try files.moveItem(at: file, to: named)
        return chooseDestination(named, mimeType)
    }

    private func upload(_ token: String) throws -> URL {
        try require(matches(tokenPattern, token), "Bad token: \(token)")
        return dir.appendingPathComponent(token)
    }
}

/// [name] as one file's name: no folders, and not hidden.
func safeFileName(_ name: String) -> String {
    let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
    return cleaned.isEmpty ? "file" : cleaned
}
