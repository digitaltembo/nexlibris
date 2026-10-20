import Foundation
import Testing
@testable import NexlibrisKit

@Suite struct RouterTests {
    let temp = TempFolder()

    @Test func routesByMethodAndUrl() throws {
        let router = RpcRouter(storageRoutes(temp.storage("lib")))
        let written = router.handle(request("POST", "api/storage/writeText", #"{"path":"library.json","text":"{}"}"#))
        #expect(written["ok"] as? Bool == true)
        #expect(written["value"] is NSNull)

        #expect(router.handle(request("GET", "api/storage/readText", #"{"path":"library.json"}"#))["value"] as? String == "{}")
        #expect(router.handle(request("GET", "api/storage/size", #"{"path":"library.json"}"#))["value"] as? Int64 == 2)
        #expect(router.handle(request("GET", "api/storage/readText", #"{"path":"nope"}"#))["value"] is NSNull)
        #expect(router.handle(request("GET", "api/storage/exists", #"{"path":"library.json"}"#))["value"] as? Bool == true)
        #expect(router.handle(request("POST", "api/storage/remove", #"{"path":"library.json"}"#))["ok"] as? Bool == true)
        #expect(router.handle(request("GET", "api/storage/exists", #"{"path":"library.json"}"#))["value"] as? Bool == false)
        // Removing what isn't there is fine.
        #expect(router.handle(request("POST", "api/storage/remove", #"{"path":"library.json"}"#))["ok"] as? Bool == true)
        #expect(router.handle(request("POST", "api/storage/remove", #"{"path":"../x"}"#))["ok"] as? Bool == false)
        // Replies are JSON the page parses.
        let reply = parseObject(router.reply(to: request("GET", "api/storage/exists", #"{"path":"x"}"#)))
        #expect(reply?["ok"] as? Bool == true && reply?["value"] as? Bool == false)
    }

    @Test func reportsErrorsAsMessages() {
        let router = RpcRouter(storageRoutes(temp.storage("lib")))
        #expect(router.handle(request("GET", "api/storage/readText", #"{"path":"../x"}"#))["message"] as? String == "Bad path: ../x")
        #expect(router.handle(request("DELETE", "api/storage/everything", "{}"))["message"] as? String == "No endpoint for DELETE api/storage/everything")
        let missing = router.handle(request("GET", "api/storage/readChunk", #"{"path":"nope","offset":0,"length":10}"#))
        #expect(missing["message"] as? String == "No file: nope")
    }

    @Test func servesTheSyncFolderAlongsideTheLibrary() throws {
        let library = temp.storage("library")
        let folder = temp.storage("sync")
        let router = RpcRouter(
            storageRoutes(library),
            usbFolderRoutes(folder: { folder }, library: { library }, info: { ["path": "On My iPhone/nexlibris/sync"] }, choose: { [:] })
        )
        _ = router.handle(request("POST", "api/usbFolder/writeText", #"{"path":"library.json","text":"{}"}"#))
        #expect(try folder.readText("library.json") == "{}")
        #expect(try library.readText("library.json") == nil)
        let hash = try library.put(stream("book")).hash
        #expect(router.handle(request("POST", "api/usbFolder/toFolder", #"{"hash":"\#(hash)"}"#))["ok"] as? Bool == true)
        #expect(router.handle(request("GET", "api/usbFolder/list", #"{"path":"files/\#(hash.prefix(2))"}"#))["value"] as? [String] == [hash])
        #expect((router.handle(request("GET", "api/usbFolder/info", "{}"))["value"] as? JSONObject)?["path"] as? String == "On My iPhone/nexlibris/sync")
        // With no folder chosen yet, the folder's calls say so.
        let missing = RpcRouter(usbFolderRoutes(folder: { throw NexlibrisError("Choose the sync folder first.") }, library: { library }, info: { [:] }, choose: { [:] }))
        #expect(missing.handle(request("GET", "api/usbFolder/exists", #"{"path":"a"}"#))["message"] as? String == "Choose the sync folder first.")
    }

    @Test func setsWindowColors() {
        var set: [(RGB, Bool)] = []
        let router = RpcRouter(windowRoutes { set.append(($0, $1)) })
        #expect(router.handle(request("POST", "api/window/setColors", ##"{"background":"#1c1813","dark":true}"##))["ok"] as? Bool == true)
        #expect(set.count == 1)
        #expect(set[0].0 == RGB(red: 0x1C / 255.0, green: 0x18 / 255.0, blue: 0x13 / 255.0))
        #expect(set[0].1)
        #expect(router.handle(request("POST", "api/window/setColors", #"{"background":"red","dark":false}"#))["ok"] as? Bool == false)
        #expect(set.count == 1)
    }

    @Test func chunksAsTheWebAppDoes() throws {
        // The same bytes as syncMessage.test.ts and BluetoothFramingTest.kt expect.
        let message = Data([14, 0, 0, 0]) + Data(#"{"status":200}"#.utf8) + Data([1, 2, 3])
        let hex = { (data: Data) in data.map { String(format: "%02x", $0) }.joined() }
        #expect(try BluetoothFraming.chunks(message, size: 8).map(hex) == ["000e0000007b2273", "007461747573223a", "013230307d010203"])
        #expect(try BluetoothFraming.chunks(Data(), size: 20).map(hex) == ["01"])

        let assembler = BluetoothFraming.Assembler()
        let chunks = try BluetoothFraming.chunks(message, size: 5)
        for chunk in chunks.dropLast() { #expect(assembler.push(chunk) == nil) }
        #expect(assembler.push(chunks.last!) == message)
        #expect(assembler.push(Data([1, 9])) == Data([9]))
    }
}

@Suite struct SaveTests {
    let temp = TempFolder()

    @Test func handsTheNamedFileToThePickerAndDiscardsIt() throws {
        let dir = temp.url.appendingPathComponent("saves")
        var asked: [(String, String, String)] = []
        let saves = try SaveService(dir: dir) { file, type in
            asked.append((file.lastPathComponent, type, (try? String(contentsOf: file, encoding: .utf8)) ?? ""))
            return true
        }
        try saves.chunk(token: "t-1", data: b64("back"), first: true)
        try saves.chunk(token: "t-1", data: b64("up"), first: false)
        #expect(try saves.save(token: "t-1", name: "backup.zip", mimeType: "application/zip"))
        #expect(asked.count == 1)
        #expect(asked[0] == ("backup.zip", "application/zip", "backup"))
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [])
    }

    @Test func cancellingSavesNothingAndDiscardsTheUpload() throws {
        let saves = try SaveService(dir: temp.url.appendingPathComponent("saves")) { _, _ in false }
        try saves.chunk(token: "t", data: b64("x"), first: true)
        #expect(try !saves.save(token: "t", name: "a.epub", mimeType: "application/epub+zip"))
        #expect(throws: NexlibrisError("No upload in progress: t")) { try saves.save(token: "t", name: "a.epub", mimeType: "application/epub+zip") }
    }

    @Test func refusesTokensThatCouldBePaths() throws {
        let saves = try SaveService(dir: temp.url.appendingPathComponent("saves")) { _, _ in true }
        for token in ["../x", "a/b", "", ".hidden"] {
            #expect(throws: NexlibrisError("Bad token: \(token)")) { try saves.chunk(token: token, data: "", first: true) }
        }
        #expect(throws: NexlibrisError("No upload in progress: never-started")) { try saves.chunk(token: "never-started", data: "", first: false) }
        #expect(safeFileName("../a/b:c.epub") == "-a-b-c.epub")
    }
}

@Suite struct ImportTests {
    let temp = TempFolder()

    private func source(_ name: String, _ text: String) -> PickedSource {
        PickedSource(name: name, size: Int64(text.utf8.count)) { stream(text) }
    }

    @Test func storesPickedFilesByHashAndSkipsOthers() throws {
        let storage = temp.storage("lib")
        let picked = [
            source("Book.EPUB", "hello"),
            source("dune.x4.epub", "x4"),
            source("notes.doc", "nope"),
            PickedSource(name: "gone.pdf") { throw NexlibrisError("Couldn't open it") },
        ]
        var released = 0
        let service = ImportService(storage: { storage }) { _ in Picked(picked) { released += 1 } }
        let chosen = try service.pick(extensions: ["epub", "x4.epub", "pdf"])
        let listed = chosen["files"] as! [JSONObject]
        #expect(listed.count == 3)
        #expect(listed[0]["size"] as? Int64 == 5)
        #expect((chosen["skipped"] as! [JSONObject])[0]["name"] as? String == "notes.doc")
        #expect(!FileManager.default.fileExists(atPath: storage.root.appendingPathComponent("files").path))

        let token = chosen["token"] as! String
        let result = try service.store(token: token, start: 0)
        #expect(result["next"] as? Int == 3)
        let files = result["files"] as! [JSONObject]
        #expect(files.count == 2)
        #expect(files[0]["name"] as? String == "Book.EPUB")
        #expect(files[0]["hash"] as? String == helloHash)
        #expect(try storage.readText(storedFilePath(helloHash)) == "hello")
        let skipped = result["skipped"] as! [JSONObject]
        #expect(skipped[0]["name"] as? String == "gone.pdf")
        #expect(skipped[0]["reason"] as? String == "Couldn't open it")
        // No temporary files left behind.
        #expect(try storage.listAll("files").allSatisfy { !$0.hasPrefix(".") })
        // Once it's all stored, the pick is let go.
        #expect(released == 1)
        #expect(throws: NexlibrisError(ImportService.replaced)) { try service.store(token: token, start: 3) }
    }

    @Test func storesAPickInBatchesAndOnlyTheLatestPick() throws {
        let storage = temp.storage("lib")
        let picked = (0..<(ImportService.batchFiles + 10)).map { source("book-\($0).epub", "book \($0)") }
        let service = ImportService(storage: { storage }) { _ in Picked(picked) }
        let first = try service.pick(extensions: ["epub"])["token"] as! String
        let batch = try service.store(token: first, start: 0)
        #expect((batch["files"] as! [JSONObject]).count == ImportService.batchFiles)
        #expect(batch["next"] as? Int == ImportService.batchFiles)

        let second = try service.pick(extensions: ["epub"])["token"] as! String
        #expect(throws: NexlibrisError(ImportService.replaced)) { try service.store(token: first, start: ImportService.batchFiles) }
        let router = RpcRouter(importRoutes(service))
        let rest = router.handle(request("POST", "api/import/store", #"{"token":"\#(second)","start":\#(ImportService.batchFiles)}"#))["value"] as! JSONObject
        #expect((rest["files"] as! [JSONObject]).count == 10)
        #expect(rest["next"] as? Int == picked.count)
    }

    @Test func picksAFoldersBooksWithTheirPathsAndTheNamedSidecars() throws {
        let storage = temp.storage("lib")
        let library = temp.folder("Calibre Library")
        let book = library.appendingPathComponent("Frank Herbert/Dune (7)")
        try FileManager.default.createDirectory(at: book, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: library.appendingPathComponent(".caltrash"), withIntermediateDirectories: true)
        try Data("hello".utf8).write(to: book.appendingPathComponent("Dune.epub"))
        try Data("<package/>".utf8).write(to: book.appendingPathComponent("Metadata.OPF"))
        try Data().write(to: book.appendingPathComponent(".DS_Store"))
        try Data("sqlite".utf8).write(to: library.appendingPathComponent("metadata.db"))
        try Data("old".utf8).write(to: library.appendingPathComponent(".caltrash/old.epub"))

        var askedForFolder = false
        let service = ImportService(storage: { storage }) { folder in
            askedForFolder = folder
            return Picked(folderFiles(library))
        }
        let router = RpcRouter(importRoutes(service))
        let chosen = router.handle(request("POST", "api/import/pick", #"{"extensions":["epub"],"folder":true,"names":["metadata.opf"]}"#))["value"] as! JSONObject
        let result = try service.store(token: chosen["token"] as! String, start: 0)

        #expect(askedForFolder)
        let files = result["files"] as! [JSONObject]
        #expect(files.count == 2)
        #expect(files[0]["path"] as? String == "Calibre Library/Frank Herbert/Dune (7)/Dune.epub")
        #expect(files[0]["hash"] as? String == helloHash)
        #expect(files[1]["name"] as? String == "Metadata.OPF")
        #expect((chosen["skipped"] as! [JSONObject]).map { $0["name"] as? String } == ["Calibre Library/metadata.db"])
    }

    @Test func namedSidecarsAreOnlyTakenFromFolders() throws {
        let service = ImportService(storage: { temp.storage("lib") }) { _ in Picked([source("metadata.opf", "<package/>")]) }
        #expect((try service.pick(extensions: ["epub"], names: ["metadata.opf"])["files"] as! [JSONObject]).isEmpty)
    }

    @Test func cancellingPicksNothing() {
        let router = RpcRouter(importRoutes(ImportService(storage: { temp.storage("lib") }) { _ in Picked([]) }))
        let response = router.handle(request("POST", "api/import/pick", #"{"extensions":["epub"]}"#))
        #expect(response["ok"] as? Bool == true)
        #expect(((response["value"] as! JSONObject)["files"] as! [JSONObject]).isEmpty)
    }
}
