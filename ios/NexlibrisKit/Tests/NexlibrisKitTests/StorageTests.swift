import Foundation
import Testing
@testable import NexlibrisKit

/// SHA-256 of "hello", as the web app's hashBlob writes it.
let helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

@Suite struct StorageTests {
    let temp = TempFolder()

    @Test func readsWritesAndAppendsText() throws {
        let storage = temp.storage("libraries/default")
        #expect(try storage.readText("library.json") == nil)
        #expect(try !storage.exists("library.json"))
        try storage.writeText("library.json", "héllo")
        try storage.appendText("library.json", " wörld\n")
        try storage.appendText("log/changes.jsonl", "{}\n")
        #expect(try storage.readText("library.json") == "héllo wörld\n")
        #expect(try storage.readText("log/changes.jsonl") == "{}\n")
        #expect(try storage.exists("library.json"))
    }

    @Test func uploadsInChunksAndOnlyReplacesTheFileAtTheEnd() throws {
        let storage = temp.storage("libraries/default")
        let bytes = Data((0..<2500).map { UInt8($0 * 7 % 256) })
        try storage.writeChunk("files/ab/abc", data: bytes[0..<1000].base64EncodedString(), first: true, last: false)
        #expect(try !storage.exists("files/ab/abc"))
        try storage.writeChunk("files/ab/abc", data: bytes[1000..<2000].base64EncodedString(), first: false, last: false)
        try storage.writeChunk("files/ab/abc", data: bytes[2000..<2500].base64EncodedString(), first: false, last: true)

        #expect(try storage.size("files/ab/abc") == 2500)
        var read = Data()
        for offset in stride(from: 0, to: 2500, by: 1000) {
            read += Data(base64Encoded: try storage.readChunk("files/ab/abc", offset: Int64(offset), length: 1000))!
        }
        #expect(read == bytes)
        // Reading past the end is short, not an error.
        #expect(try storage.readChunk("files/ab/abc", offset: 3000, length: 10) == "")
        #expect(try storage.size("files/missing") == nil)
    }

    @Test func aNewFirstChunkStartsOver() throws {
        let storage = temp.storage("lib")
        try storage.writeChunk("f", data: b64("abandoned"), first: true, last: false)
        try storage.writeChunk("f", data: b64("fresh"), first: true, last: true)
        #expect(try storage.readText("f") == "fresh")
        #expect(throws: NexlibrisError("No upload in progress: g")) { try storage.writeChunk("g", data: b64("x"), first: false, last: true) }
    }

    @Test func writesEmptyFiles() throws {
        let storage = temp.storage("lib")
        try storage.writeChunk("empty", data: "", first: true, last: true)
        #expect(try storage.size("empty") == 0)
    }

    @Test func refusesPathsOutsideTheLibrary() throws {
        let storage = temp.storage("libraries/default")
        for path in ["../escape", "/etc/passwd", "a//b", "a/./b", "", "files/../../x"] {
            #expect(throws: NexlibrisError("Bad path: \(path)")) { try storage.readText(path) }
        }
        let outside = temp.folder("outside")
        try FileManager.default.createSymbolicLink(at: storage.root.appendingPathComponent("link"), withDestinationURL: outside)
        #expect(throws: NexlibrisError("Bad path: link/x")) { try storage.writeText("link/x", "nope") }
        #expect(!FileManager.default.fileExists(atPath: outside.appendingPathComponent("x").path))
    }

    @Test func storesByHashAndCopiesStoredFilesBetweenStorages() throws {
        let library = temp.storage("lib")
        let folder = temp.storage("sync")
        let stored = try library.put(stream("hello"))
        #expect(stored == StoredFile(hash: helloHash, size: 5))
        // Storing the same contents again is a no-op.
        #expect(try library.put(stream("hello")) == stored)
        #expect(try library.list("files") == [String(helloHash.prefix(2))])
        #expect(try library.listAll("files") == [String(helloHash.prefix(2))])
        #expect(try folder.list("files") == [])

        #expect(try copyStoredFile(from: library, to: folder, hash: stored.hash) == stored)
        #expect(try folder.readText(storedFilePath(stored.hash)) == "hello")
        try folder.remove(storedFilePath(stored.hash))
        #expect(try !folder.exists(storedFilePath(stored.hash)))
        #expect(throws: NexlibrisError("That file isn’t stored here.")) { try copyStoredFile(from: folder, to: library, hash: stored.hash) }
        #expect(throws: (any Error).self) { try library.put(stream("other"), expected: helloHash) }
    }

    @Test func movesAndPrunesEmptyFolders() throws {
        let storage = temp.storage("lib")
        try storage.writeText("a/b/c.txt", "x")
        try storage.writeText("a/.DS_Store", "")
        try storage.move("a/b/c.txt", "d/c.txt")
        try storage.prune("a/b/c.txt")
        #expect(try storage.listAll("") == ["d"])
        #expect(try storage.readText("d/c.txt") == "x")
        try storage.removeTree("")
        #expect(try storage.listAll("") == [])
    }
}

@Suite struct ServingTests {
    let temp = TempFolder()

    @Test func findsStoredFilesButNothingElse() throws {
        let storage = temp.storage("lib")
        try storage.writeText("files/ab/abcd", "book")
        try storage.writeText("local/thumbs/ab/abcd.jpg", "thumb")
        try storage.writeText("local/sync-folder.json", "{}")
        try storage.writeText("library.json", "{}")
        let read = { (path: String) in servedFile(storage, placed: false, path: path).flatMap { try? String(contentsOf: $0, encoding: .utf8) } }
        #expect(read("files/ab/abcd") == "book")
        #expect(read("files/ab/missing") == nil)
        #expect(read("files/ab") == nil)
        #expect(read("local/thumbs/ab/abcd.jpg") == "thumb")
        #expect(read("local/sync-folder.json") == nil)
        #expect(read("local/thumbs/../sync-folder.json") == nil)
        #expect(read("library.json") == nil)
        #expect(read("files/../library.json") == nil)
        #expect(read("files/../../secret") == nil)
    }

    @Test func servesBooksPlacedInAFolderButNotItsData() throws {
        let storage = temp.storage("Books")
        try storage.writeText("Frank Herbert/Dune.epub", "book")
        try storage.writeText("Frank Herbert/.hidden", "no")
        try storage.writeText(".nexlibris/files/ab/abcd", "waiting")
        try storage.writeText(".nexlibris/library.json", "{}")
        let read = { (placed: Bool, path: String) in servedFile(storage, placed: placed, path: path).flatMap { try? String(contentsOf: $0, encoding: .utf8) } }
        #expect(read(true, "Frank Herbert/Dune.epub") == "book")
        #expect(read(true, ".nexlibris/files/ab/abcd") == "waiting")
        #expect(read(true, ".nexlibris/library.json") == nil)
        #expect(read(true, "Frank Herbert/.hidden") == nil)
        #expect(read(true, "../secret") == nil)
        #expect(read(false, "Frank Herbert/Dune.epub") == nil)
    }

    @Test func servesTheWebAppAndTheLibraryAtTheAppsOrigin() throws {
        let www = temp.folder("www")
        try Data("<html>".utf8).write(to: www.appendingPathComponent("index.html"))
        try FileManager.default.createDirectory(at: www.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try Data("1".utf8).write(to: www.appendingPathComponent("assets/app.js"))
        let library = temp.storage("lib")
        try library.writeText("files/ab/abcd", "book")
        let handler = AppSchemeHandler(webApp: www) { (library, false) }
        let at = { (path: String) in handler.resolve(URL(string: "app://nexlibris\(path)")!) }

        #expect(at("/")?.file.lastPathComponent == "index.html")
        #expect(at("/assets/app.js")?.type == "text/javascript")
        // A route of the page's own gets the page; a missing file doesn't.
        #expect(at("/library")?.type == "text/html")
        #expect(at("/assets/missing.js") == nil)
        #expect(at("/../secret.js") == nil)
        #expect(at("/library/files/ab/abcd?v=1")?.cache == "private, max-age=31536000, immutable")
        #expect(at("/library/library.json") == nil)
    }
}

@Suite struct CloudTests {
    let temp = TempFolder()

    @Test func namesICloudPlaceholdersAsTheirFiles() throws {
        #expect(cloudPlaceholderOf(".Dune.epub.icloud") == "Dune.epub")
        #expect(cloudPlaceholderOf(".icloud") == nil)
        #expect(cloudPlaceholderOf("Dune.epub") == nil)
        let storage = temp.storage("sync")
        try storage.writeText("files/ab/.abcd.icloud", "")
        try storage.writeText("files/ab/abce", "here")
        #expect(try storage.list("files/ab") == ["abcd", "abce"])
        // A placeholder that can't be downloaded (here, outside iCloud) isn't a file.
        #expect(try !storage.exists("files/ab/abcd"))
    }
}
