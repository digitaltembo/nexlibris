import Foundation
import Testing
@testable import NexlibrisKit

/// Plain folders, by path, as the picker's folders would be.
private final class FakeFolders: Folders {
    var picks: [String] = []
    var revoked = Set<String>()
    var kept = Set<String>()

    func pick() -> String? { picks.isEmpty ? nil : picks.removeFirst() }
    func open(_ id: String, base: String) throws -> FileStorage {
        try FileStorage(root: base.isEmpty ? URL(fileURLWithPath: id) : URL(fileURLWithPath: id).appendingPathComponent(base))
    }
    func whereIs(_ id: String) -> String { URL(fileURLWithPath: id).lastPathComponent }
    func mayUse(_ id: String) -> Bool {
        var folder: ObjCBool = false
        return FileManager.default.fileExists(atPath: id, isDirectory: &folder) && folder.boolValue && !revoked.contains(id)
    }
    func keep(_ id: String) { kept.insert(id) }
    func releaseAllBut(_ ids: Set<String>) { kept.formIntersection(ids) }
    func overlap(_ a: String, _ b: String) -> Bool { pathsOverlap(a, b) }
}

private final class Remembered: Setting {
    var value: String?
    init(_ value: String? = nil) { self.value = value }
    func get() -> String? { value }
    func set(_ value: String?) { self.value = value }
}

@Suite struct LibraryFolderTests {
    let temp = TempFolder()
    let hashA = String(repeating: "a", count: 64)
    let hashB = String(repeating: "b", count: 64)
    let layout: JSONObject = ["folder": "<author>", "fileName": "<title>"]

    /// A library in the app's storage, with a book file and a cover.
    private func homeLibrary() throws -> FileStorage {
        let home = temp.storage("home")
        try home.writeText("library.json", "{}")
        try home.writeText("changes.jsonl", "")
        try home.writeText("local/pairings.json", "[]")
        try home.writeText(storedFilePath(hashA), "dune")
        try home.writeText(storedFilePath(hashB), "cover")
        return home
    }

    private func waitForMove(_ service: LibraryFolderService) -> JSONObject {
        for _ in 0..<500 {
            let status = service.status()
            if status["state"] as? String != "moving" { return status }
            Thread.sleep(forTimeInterval: 0.01)
        }
        Issue.record("The move didn't finish")
        return [:]
    }

    private func text(_ url: URL, _ path: String) -> String? { try? String(contentsOf: url.appendingPathComponent(path), encoding: .utf8) }

    @Test func movesTheLibraryIntoAFolderLaidOutAndBack() throws {
        let home = try homeLibrary()
        let folders = FakeFolders()
        let chosen = Remembered()
        var reloads = 0
        let service = LibraryFolderService(home: home, folders: folders, chosen: chosen) { reloads += 1 }
        let books = temp.folder("Books")
        try Data("mine".utf8).write(to: books.appendingPathComponent("notes.txt"))
        folders.picks.append(books.path)

        let choice = try #require(try service.choose())
        #expect(choice["holds"] as? String == "files")
        #expect(choice["name"] as? String == "Books")
        try service.move(to: choice["path"] as? String, layout: layout, placed: [hashA: "Frank Herbert/Dune.epub"])
        #expect(waitForMove(service)["state"] as? String == "done")

        #expect(reloads == 1)
        #expect(chosen.value == books.path)
        #expect(text(books, "Frank Herbert/Dune.epub") == "dune")
        #expect(text(books, ".nexlibris/\(storedFilePath(hashB))") == "cover")
        #expect(text(books, ".nexlibris/local/pairings.json") == "[]")
        #expect(text(books, "notes.txt") == "mine")
        #expect(parseObject(text(books, ".nexlibris/placed.json") ?? "")?[hashA] as? String == "Frank Herbert/Dune.epub")
        #expect(try home.listAll("") == [])
        // The page reads the folder; imports go into its .nexlibris.
        #expect(service.placed)
        #expect(try service.root.readText("Frank Herbert/Dune.epub") == "dune")
        #expect(try service.data.readText(storedFilePath(hashB)) == "cover")
        let location = service.location()
        #expect(location["path"] as? String == "Books")
        #expect(location["isDefault"] as? Bool == false)
        #expect(location["defaultHasLibrary"] as? Bool == false)

        try service.move(to: nil, layout: nil, placed: [:])
        #expect(waitForMove(service)["state"] as? String == "done")
        #expect(chosen.value == nil)
        #expect(try home.readText(storedFilePath(hashA)) == "dune")
        #expect(try FileManager.default.contentsOfDirectory(atPath: books.path) == ["notes.txt"])
        #expect(folders.kept.isEmpty)
    }

    @Test func leavesTheLibraryWhereItWasIfACopyFails() throws {
        let home = try homeLibrary()
        let books = temp.storage("Books")
        var writes = 0
        #expect(throws: NexlibrisError("The disk is full.")) {
            try LibraryFolderService.relocate(from: home, fromPlaced: false, to: books, layout: layout, placed: [hashA: "Frank Herbert/Dune.epub"]) { _, _ in
            } write: { storage, path, input in
                writes += 1
                if writes == 3 { throw NexlibrisError("The disk is full.") }
                try storage.writeStream(path, input)
            }
        }
        #expect(try books.filesUnder("") == [])
        #expect(try home.readText(storedFilePath(hashA)) == "dune")
        #expect(try home.readText("library.json") == "{}")
    }

    @Test func opensALibraryInAFolderInsteadOfMovingIntoIt() throws {
        let home = try homeLibrary()
        let folders = FakeFolders()
        var reloads = 0
        let service = LibraryFolderService(home: home, folders: folders, chosen: Remembered()) { reloads += 1 }
        let other = temp.folder("Other")
        try FileStorage(root: other).writeText(LibraryFolderService.layoutPath, try jsonText(layout))
        folders.picks.append(other.path)

        let choice = try #require(try service.choose())
        #expect(choice["holds"] as? String == "library")
        try service.move(to: other.path, layout: layout, placed: [:])
        #expect(waitForMove(service)["state"] as? String == "failed")
        #expect(service.status()["message"] as? String == "That folder has a library already.")

        try service.open(other.path)
        #expect(reloads == 1)
        #expect(service.placed)
        #expect(service.location()["defaultHasLibrary"] as? Bool == true)
        // The library in the app's storage stayed.
        #expect(try home.readText(storedFilePath(hashA)) == "dune")
    }

    @Test func opensInTheAppsStorageWhenTheFolderCantBeUsed() throws {
        let home = try homeLibrary()
        let folders = FakeFolders()
        let gone = temp.folder("Gone").path
        folders.revoked.insert(gone)
        let service = LibraryFolderService(home: home, folders: folders, chosen: Remembered(gone)) {}
        #expect(!service.placed)
        #expect(service.location()["lost"] as? String == "Gone")
        #expect(service.location()["isDefault"] as? Bool == true)
        #expect(try service.root.readText("library.json") == "{}")
    }

    @Test func keepsPickedFoldersByBookmark() throws {
        let defaults = UserDefaults(suiteName: "nexlibris-test-\(UUID().uuidString)")!
        let books = temp.folder("Books")
        let folders = BookmarkedFolders(Bookmarks(defaults, key: "folders")) { books }
        let id = try #require(folders.pick())
        folders.keep(id)
        // Another run of the app finds it by its bookmark.
        let again = BookmarkedFolders(Bookmarks(defaults, key: "folders")) { nil }
        #expect(again.mayUse(id))
        try again.open(id, base: "").writeText("a.txt", "x")
        #expect(text(books, "a.txt") == "x")
        again.releaseAllBut([])
        #expect(!BookmarkedFolders(Bookmarks(defaults, key: "folders")) { nil }.mayUse(id))
        #expect(folders.overlap("/a/b", "/a"))
        #expect(!folders.overlap("/a/bc", "/a/b"))
    }

    @Test func describesFoldersAsFilesShowsThem() {
        let documents = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/X/Documents")
        #expect(describeFolder(documents.appendingPathComponent("Books"), documents: documents) == "On My iPhone/nexlibris/Books")
        let cloud = URL(fileURLWithPath: "/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Books/Mine")
        #expect(describeFolder(cloud, documents: documents) == "iCloud Drive/Books/Mine")
        #expect(describeFolder(URL(fileURLWithPath: "/Volumes/USB/sync"), documents: documents) == "USB/sync")
    }
}
