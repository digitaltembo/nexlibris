import Foundation

/**
 * The folders the user picks for the library ([LibraryFolderService]), by id: on the phone, a
 * folder picked in Files, kept by a bookmark ([BookmarkedFolders]); in tests, plain folders.
 */
public protocol Folders {
    /// Shows the picker and waits; the folder's id, or nil if none was chosen.
    func pick() -> String?
    /// The folder as storage, from [base] in it.
    func open(_ id: String, base: String) throws -> FileStorage
    /// Where it is, as the user knows it, e.g. "On My iPhone/nexlibris/Books".
    func whereIs(_ id: String) -> String
    /// Whether the app may still use it (the folder can be deleted, or its provider gone).
    func mayUse(_ id: String) -> Bool
    /// Keeps the means to use it, across restarts.
    func keep(_ id: String)
    /// Lets go of every folder but these.
    func releaseAllBut(_ ids: Set<String>)
    /// Whether one folder is the other or inside it, either way round.
    func overlap(_ a: String, _ b: String) -> Bool
}

/// A setting kept across restarts.
public protocol Setting {
    func get() -> String?
    func set(_ value: String?)
}

/// A [Setting] in user defaults.
public struct DefaultsSetting: Setting {
    let defaults: UserDefaults
    let key: String

    public init(_ defaults: UserDefaults, key: String) {
        self.defaults = defaults
        self.key = key
    }

    public func get() -> String? { defaults.string(forKey: key) }
    public func set(_ value: String?) { defaults.set(value, forKey: key) }
}

/**
 * Where iOS keeps the library (common/src/libraryFolderApi.ts, as the desktop app serves it):
 * the app's own storage ([home], the default, which only nexlibris can see and which goes when
 * it's deleted), or a folder of the user's picked in Files (on the phone, in iCloud Drive, or on a
 * drive plugged in), with the books laid out in it (common/src/placedLibrary.ts) and nexlibris's
 * own files in `.nexlibris/`. The page reads and writes [root]; imports and files from a hub go
 * into [data]. Moving the library copies it, checks each copy, and deletes the originals once
 * everything has copied; if anything fails, the copies are deleted and the library stays where it
 * was. As Android's `LibraryFolderService.kt`, which this follows.
 *
 * [chosen] reads and writes which folder the library is in (nil for [home]); [reload] opens the
 * library again in the page, once it's moved or another is opened.
 */
public final class LibraryFolderService {
    public static let dataDir = ".nexlibris"
    public static let layoutPath = "\(dataDir)/layout.json"
    public static let placedPath = "\(dataDir)/placed.json"

    private struct Open {
        let folder: String?
        let root: FileStorage
        let data: FileStorage
        let placed: Bool
    }

    private let home: FileStorage
    private let folders: Folders
    private let chosen: Setting
    private let reload: () -> Void
    private let current: Locked<Open>
    /// A folder the library was in that the app may no longer use: it opened in its own storage instead.
    private var lost: String?
    private let moving = Locked<JSONObject>(LibraryFolderService.status("idle", 0, 0))

    public init(home: FileStorage, folders: Folders, chosen: Setting, reload: @escaping () -> Void) {
        self.home = home
        self.folders = folders
        self.chosen = chosen
        self.reload = reload
        current = Locked(Open(folder: nil, root: home, data: home, placed: false))
        if let folder = chosen.get() {
            if folders.mayUse(folder), let open = try? openAt(folder) { current.set(open) } else { lost = folder }
        }
    }

    /// The storage the page reads and writes.
    public var root: FileStorage { current.get.root }

    /// Where the library's own files are: imports and fetched files are stored here.
    public var data: FileStorage { current.get.data }

    /// Whether the library is laid out in a folder of the user's.
    public var placed: Bool { current.get.placed }

    private func openAt(_ folder: String?) throws -> Open {
        guard let folder else { return Open(folder: nil, root: home, data: home, placed: false) }
        let root = try folders.open(folder, base: "")
        let placed = Self.isPlaced(root)
        return Open(folder: folder, root: root, data: placed ? try folders.open(folder, base: Self.dataDir) : root, placed: placed)
    }

    public func location() -> JSONObject {
        let open = current.get
        var location: JSONObject = [
            "path": open.folder.map(folders.whereIs) ?? "",
            "isDefault": open.folder == nil,
            "placed": open.placed,
            "defaultHasLibrary": open.folder != nil && ((try? home.exists("library.json")) ?? false),
        ]
        if let lost { location["lost"] = folders.whereIs(lost) }
        return location
    }

    /// Asks for a folder: its id, where it is, and what's in it; nil if none was chosen.
    public func choose() throws -> JSONObject? {
        guard let folder = folders.pick() else { return nil }
        folders.keep(folder)
        return ["path": folder, "name": folders.whereIs(folder), "holds": Self.holds(try folders.open(folder, base: ""))]
    }

    /**
     * Starts moving the library to [to] (the app's storage if nil), laid out by [layout] with each
     * book file at its path in [placed]; [status] says how it's going. Once moved, the page reloads.
     */
    public func move(to: String?, layout: JSONObject?, placed: [String: String]) throws {
        if moving.get["state"] as? String == "moving" { throw NexlibrisError("The library is moving already.") }
        let from = current.get
        if let to, let folder = from.folder {
            if to == folder { throw NexlibrisError("The library is in that folder already.") }
            if folders.overlap(to, folder) { throw NexlibrisError("The library can’t move into its own folder, or into one its folder is in.") }
        }
        if to == nil && from.folder == nil { throw NexlibrisError("The library is in the app’s storage already.") }
        moving.set(Self.status("moving", 0, 0))
        let thread = Thread { [self] in
            do {
                let target = try to.map { try folders.open($0, base: "") } ?? home
                try Self.relocate(from: from.root, fromPlaced: from.placed, to: target, layout: to == nil ? nil : layout, placed: placed) { done, total in
                    moving.set(Self.status("moving", done, total))
                }
                try switchTo(to)
                let last = moving.get
                moving.set(Self.status("done", last["done"] as? Int ?? 0, last["total"] as? Int ?? 0))
                reload()
            } catch {
                let last = moving.get
                var failed = Self.status("failed", last["done"] as? Int ?? 0, last["total"] as? Int ?? 0)
                failed["message"] = messageOf(error)
                moving.set(failed)
            }
        }
        thread.name = "library-move"
        thread.start()
    }

    public func status() -> JSONObject { moving.get }

    /// Opens the library in [folder] (the app's storage if nil), leaving this one where it is.
    public func open(_ folder: String?) throws {
        if let folder, !folders.mayUse(folder) { throw NexlibrisError("nexlibris may not use that folder. Choose it again.") }
        try switchTo(folder)
        reload()
    }

    private func switchTo(_ folder: String?) throws {
        current.set(try openAt(folder))
        lost = nil
        chosen.set(folder)
        // Only the library's folder is kept (and the sync folder, which isn't this service's).
        folders.releaseAllBut(folder.map { [$0] } ?? [])
    }

    private static func status(_ state: String, _ done: Int, _ total: Int) -> JSONObject {
        ["state": state, "done": done, "total": total]
    }

    /// Whether the storage holds a library laid out in it, rather than one kept as the app's storage keeps it.
    public static func isPlaced(_ tree: FileStorage) -> Bool { (try? tree.exists(layoutPath)) ?? false }

    /// What a folder holds already: a library, other files, or nothing.
    public static func holds(_ tree: FileStorage) -> String {
        if isPlaced(tree) || ((try? tree.exists("library.json")) ?? false) { return "library" }
        if ((try? tree.listAll("")) ?? []).contains(where: { !ignoredNames.contains($0) }) { return "files" }
        return "nothing"
    }

    /**
     * Moves a library between storages, as `relocate` in client/src/library/libraryFolder.ts does
     * in a browser: its own files, and each stored book file to its place by [layout] ([placed]),
     * or into `files/` if it has none or something else is there. Copied and checked, then the
     * originals deleted; if anything fails, the copies are deleted. Other files stay as they are.
     */
    public static func relocate(
        from: FileStorage,
        fromPlaced: Bool,
        to: FileStorage,
        layout: JSONObject?,
        placed: [String: String],
        onProgress: (_ done: Int, _ total: Int) -> Void = { _, _ in },
        write: ((FileStorage, String, InputStream) throws -> Void)? = nil
    ) throws {
        let fromData = fromPlaced ? "\(dataDir)/" : ""
        let toData = layout != nil ? "\(dataDir)/" : ""
        if holds(to) == "library" { throw NexlibrisError("That folder has a library already.") }

        var sources: [(hash: String, path: String)] = []
        var seen = Set<String>()
        if fromPlaced {
            let index = (try from.readText(placedPath)).flatMap(parseObject) ?? [:]
            for (hash, value) in index.sorted(by: { $0.key < $1.key }) {
                if let path = value as? String, try from.exists(path), seen.insert(hash).inserted { sources.append((hash, path)) }
            }
        }
        for path in try from.filesUnder("\(fromData)files") {
            let hash = String(path.split(separator: "/").last ?? "")
            if matches("[0-9a-f]{64}", hash), seen.insert(hash).inserted { sources.append((hash, path)) }
        }

        var steps: [(source: String, target: String)] = []
        var index: JSONObject = [:]
        var claimed = Set<String>()
        for (hash, source) in sources {
            if layout != nil, let path = placed[hash], claimed.insert(path.lowercased()).inserted, !(try to.exists(path)) {
                index[hash] = path
                steps.append((source, path))
            } else {
                steps.append((source, toData + storedFilePath(hash)))
            }
        }
        for name in ["library.json", "changes.jsonl"] where try from.exists(fromData + name) {
            steps.append((fromData + name, toData + name))
        }
        for path in try from.filesUnder("\(fromData)local") {
            steps.append((path, toData + String(path.dropFirst(fromData.count))))
        }

        let writeStream = write ?? { storage, path, input in try storage.writeStream(path, input) }
        var written: [String] = []
        do {
            for (i, step) in steps.enumerated() {
                guard let input = try from.open(step.source) else { throw NexlibrisError("Couldn’t read \(step.source).") }
                try writeStream(to, step.target, input)
                written.append(step.target)
                if try to.size(step.target) != from.size(step.source) { throw NexlibrisError("\(step.target) didn’t copy whole.") }
                onProgress(i + 1, steps.count)
            }
            if let layout {
                try to.writeText(layoutPath, try jsonText(layout))
                written.append(layoutPath)
                try to.writeText(placedPath, try jsonText(index))
                written.append(placedPath)
            }
        } catch {
            for path in written {
                try? to.remove(path)
                try? to.prune(path)
            }
            throw error
        }

        // Copied and checked: the originals go.
        if fromPlaced {
            for step in steps where !step.source.hasPrefix("\(dataDir)/") {
                try from.remove(step.source)
                try from.prune(step.source)
            }
            try from.removeTree(dataDir)
        } else {
            try from.removeTree("")
        }
    }
}
