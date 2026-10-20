import Foundation

#if os(macOS)
private let creating: URL.BookmarkCreationOptions = [.withSecurityScope]
private let resolving: URL.BookmarkResolutionOptions = [.withSecurityScope]
#else
private let creating: URL.BookmarkCreationOptions = []
private let resolving: URL.BookmarkResolutionOptions = []
#endif

/**
 * Folders picked in Files, kept across restarts by bookmarks in user defaults (under [key], by the
 * folder's path), and used inside their security scope, entered once and kept while the app runs.
 * Picking a folder grants the app that folder only: no other permission is needed. iOS's
 * counterpart of Android's lasting permissions on tree URIs.
 */
public final class Bookmarks {
    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()
    /// Folders whose scope the app is in, by path.
    private var entered: [String: URL] = [:]

    public init(_ defaults: UserDefaults, key: String) {
        self.defaults = defaults
        self.key = key
    }

    private var stored: [String: Data] {
        get { defaults.dictionary(forKey: key) as? [String: Data] ?? [:] }
        set { defaults.set(newValue, forKey: key) }
    }

    /// Keeps a folder the picker gave, entering its scope; its id (its path).
    @discardableResult
    public func add(_ url: URL) throws -> String {
        let id = url.standardizedFileURL.path
        enter(id, url)
        let data = try url.bookmarkData(options: creating, includingResourceValuesForKeys: nil, relativeTo: nil)
        lock.lock()
        stored[id] = data
        lock.unlock()
        return id
    }

    /// The folder kept as [id], inside its scope; nil if it isn't kept or can't be found.
    public func url(_ id: String) -> URL? {
        lock.lock()
        if let url = entered[id] {
            lock.unlock()
            return url
        }
        let data = stored[id]
        lock.unlock()
        guard let data else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: resolving, relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return nil
        }
        enter(id, url)
        if stale, let fresh = try? url.bookmarkData(options: creating, includingResourceValuesForKeys: nil, relativeTo: nil) {
            lock.lock()
            stored[id] = fresh
            lock.unlock()
        }
        return url
    }

    /// Whether [id] is kept and still a folder.
    public func isUsable(_ id: String) -> Bool {
        guard let url = url(id) else { return false }
        var folder: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &folder) && folder.boolValue
    }

    /// Forgets every folder but [ids], leaving their scopes.
    public func releaseAllBut(_ ids: Set<String>) {
        lock.lock()
        defer { lock.unlock() }
        stored = stored.filter { ids.contains($0.key) }
        for (id, url) in entered where !ids.contains(id) {
            url.stopAccessingSecurityScopedResource()
            entered[id] = nil
        }
    }

    private func enter(_ id: String, _ url: URL) {
        lock.lock()
        defer { lock.unlock() }
        if entered[id] != nil { return }
        // False for folders that need no scope (the app's own); they're used all the same.
        _ = url.startAccessingSecurityScopedResource()
        entered[id] = url
    }
}

/// Where a folder is, as Files shows it, e.g. "On My iPhone/nexlibris/Books" or "iCloud Drive/Books".
public func describeFolder(_ url: URL, documents: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first) -> String {
    let path = url.standardizedFileURL.path
    if let documents {
        let base = documents.standardizedFileURL.path
        if path == base || path.hasPrefix(base + "/") {
            return (["On My iPhone/nexlibris"] + path.dropFirst(base.count).split(separator: "/").map(String.init)).joined(separator: "/")
        }
    }
    if let range = path.range(of: "/Mobile Documents/com~apple~CloudDocs") {
        return (["iCloud Drive"] + path[range.upperBound...].split(separator: "/").map(String.init)).joined(separator: "/")
    }
    let parts = path.split(separator: "/").suffix(2).map(String.init)
    return parts.isEmpty ? path : parts.joined(separator: "/")
}

/// Whether one path is the other or inside it, either way round.
func pathsOverlap(_ a: String, _ b: String) -> Bool {
    let (x, y) = (a.hasSuffix("/") ? String(a.dropLast()) : a, b.hasSuffix("/") ? String(b.dropLast()) : b)
    return x == y || x.hasPrefix(y + "/") || y.hasPrefix(x + "/")
}

/**
 * The library's folders ([Folders]) as iOS has them: picked in Files and kept by bookmark. [pick]
 * shows the folder picker and waits (from the bridge's queue).
 */
public final class BookmarkedFolders: Folders {
    private let bookmarks: Bookmarks
    private let picker: () -> URL?
    /// Folders picked but not yet kept.
    private var picked: [String: URL] = [:]

    public init(_ bookmarks: Bookmarks, pick: @escaping () -> URL?) {
        self.bookmarks = bookmarks
        picker = pick
    }

    public func pick() -> String? {
        guard let url = picker() else { return nil }
        let id = url.standardizedFileURL.path
        _ = url.startAccessingSecurityScopedResource()
        picked[id] = url
        return id
    }

    public func open(_ id: String, base: String) throws -> FileStorage {
        guard let folder = picked[id] ?? bookmarks.url(id) else { throw NexlibrisError("nexlibris may not use that folder. Choose it again.") }
        return try FileStorage(root: base.isEmpty ? folder : folder.appendingPathComponent(base, isDirectory: true))
    }

    public func whereIs(_ id: String) -> String { describeFolder(URL(fileURLWithPath: id, isDirectory: true)) }

    public func mayUse(_ id: String) -> Bool { picked[id] != nil || bookmarks.isUsable(id) }

    public func keep(_ id: String) {
        guard let url = picked.removeValue(forKey: id) else { return }
        _ = try? bookmarks.add(url)
        url.stopAccessingSecurityScopedResource()
    }

    public func releaseAllBut(_ ids: Set<String>) { bookmarks.releaseAllBut(ids) }

    public func overlap(_ a: String, _ b: String) -> Bool { pathsOverlap(a, b) }
}

/**
 * The sync folder (common/src/usbFolderApi.ts): a folder the user picks once in Files, kept by
 * bookmark, through which the phone syncs with a computer: a drive plugged into the phone and then
 * the computer, or a folder both reach. [pick] shows the folder picker and waits for it (from the
 * bridge's queue).
 */
public final class SyncFolderService {
    private static let setting = "syncFolder"

    private let bookmarks: Bookmarks
    private let defaults: UserDefaults
    private let pick: () -> URL?
    private var cached: (id: String, storage: FileStorage)?

    public init(_ defaults: UserDefaults, pick: @escaping () -> URL?) {
        self.defaults = defaults
        bookmarks = Bookmarks(defaults, key: "syncFolderBookmarks")
        self.pick = pick
    }

    private var chosen: String? { defaults.string(forKey: Self.setting) }

    /// The folder, or an error saying to choose one.
    public func folder() throws -> FileStorage {
        guard let id = chosen else { throw NexlibrisError("Choose the sync folder first.") }
        if let cached, cached.id == id { return cached.storage }
        guard bookmarks.isUsable(id), let url = bookmarks.url(id) else {
            throw NexlibrisError("nexlibris may no longer use the sync folder. Choose it again.")
        }
        let storage = try FileStorage(root: url)
        cached = (id, storage)
        return storage
    }

    public func info() -> JSONObject {
        ["path": (try? folder()).flatMap { _ in chosen.map { describeFolder(URL(fileURLWithPath: $0, isDirectory: true)) } } ?? NSNull()]
    }

    /// Asks for the folder; returns where it is, or throws if none was chosen.
    public func choose() throws -> JSONObject {
        guard let url = pick() else { throw NexlibrisError("No folder was chosen.") }
        let id = try bookmarks.add(url)
        // Let go of the one it replaces, if it's another.
        bookmarks.releaseAllBut([id])
        defaults.set(id, forKey: Self.setting)
        cached = (id, try FileStorage(root: url))
        return ["path": describeFolder(url)]
    }
}
