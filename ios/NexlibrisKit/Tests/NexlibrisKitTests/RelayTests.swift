import Foundation
import Testing
@testable import NexlibrisKit

@Suite struct RelayTests {
    let temp = TempFolder()

    @Test func callsOnlyTheLocalNetwork() throws {
        for url in ["http://192.168.0.42", "http://10.0.2.2:8080/api/files?path=%2F", "http://172.20.1.1", "http://crosspoint.local/x", "http://crosspoint", "http://[::1]:80", "http://[fe80::1]"] {
            #expect(LocalHttpService.isLocal(url), "\(url)")
        }
        for url in ["http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://user:pw@192.168.0.2", "ftp://192.168.0.2", "file:///etc/passwd", "http://[2001:db8::1]", "not a url"] {
            #expect(!LocalHttpService.isLocal(url), "\(url)")
        }
        let service = try LocalHttpService(dir: temp.url.appendingPathComponent("local"))
        #expect(throws: NexlibrisError("Not a device on the local network: http://example.com/")) {
            try service.fetch(url: "http://example.com/", method: "GET", headers: [], body: nil)
        }
        #expect(throws: NexlibrisError("Not an HTTP method: CONNECT")) { try service.fetch(url: "http://127.0.0.1/", method: "CONNECT", headers: [], body: nil) }
    }

    @Test func relaysAReadersCallsWithoutFollowingRedirects() throws {
        let big = Data((0..<(LocalHttpService.inlineBytes + 10)).map { UInt8($0 % 251) })
        let server = try TestServer { seen in
            switch seen.path {
            case "/api/status": return (200, ["Content-Type": "application/json"], Data(#"{"ok":1}"#.utf8))
            case "/upload": return (200, [:], Data("got \(seen.body.count) \(seen.headers["x-name"] ?? "")".utf8))
            case "/big": return (200, [:], big)
            case "/moved": return (302, ["Location": "/api/status"], Data())
            default: return (404, [:], Data("No such thing".utf8))
            }
        }
        let service = try LocalHttpService(dir: temp.url.appendingPathComponent("local"))
        let status = try service.fetch(url: "\(server.base)/api/status", method: "GET", headers: [], body: nil)
        #expect(status["status"] as? Int == 200)
        #expect(Data(base64Encoded: status["data"] as! String) == Data(#"{"ok":1}"#.utf8))
        #expect((status["headers"] as! [[String]]).contains(["Content-Type", "application/json"]))

        try service.stage(token: "b1", data: b64("abc"), first: true)
        try service.stage(token: "b1", data: b64("de"), first: false)
        let upload = try service.fetch(url: "\(server.base)/upload", method: "POST", headers: [["X-Name", "dune.epub"], ["Host", "evil"]], body: "b1")
        #expect(Data(base64Encoded: upload["data"] as! String) == Data("got 5 dune.epub".utf8))
        #expect(server.seen.last?.headers["host"] != "evil")

        let large = try service.fetch(url: "\(server.base)/big", method: "GET", headers: [], body: nil)
        let token = try #require(large["token"] as? String)
        #expect(large["size"] as? Int == big.count)
        let tail = try service.read(token: token, offset: Int64(big.count - 10), length: 100)
        #expect(Data(base64Encoded: tail) == big.suffix(10))
        try service.close(token: token)
        #expect(throws: NexlibrisError("No reply under \(token)")) { try service.read(token: token, offset: 0, length: 1) }

        let missing = try service.fetch(url: "\(server.base)/nope", method: "GET", headers: [], body: nil)
        #expect(missing["status"] as? Int == 404)
        let moved = try service.fetch(url: "\(server.base)/moved", method: "GET", headers: [], body: nil)
        #expect(moved["status"] as? Int == 302)
        #expect(server.seen.filter { $0.path == "/api/status" }.count == 1)
    }

    @Test func callsAHubAndMovesFilesStraightToAndFromStorage() throws {
        let library = temp.storage("lib")
        let stored = try library.put(stream("hello"))
        let server = try TestServer { seen in
            if seen.headers["authorization"] != "Bearer k" { return (401, [:], Data(#"{"status":"error","message":"Who are you?"}"#.utf8)) }
            switch (seen.method, seen.path) {
            case ("POST", "/api/sync/hello"): return (200, [:], Data("{\"you\":\(String(decoding: seen.body, as: UTF8.self))}".utf8))
            case ("GET", "/api/sync/files/\(helloHash)"): return (200, [:], Data("hello".utf8))
            case ("GET", _): return (200, [:], Data("not what was asked for".utf8))
            case ("PUT", _): return (200, [:], Data(seen.body.count == 5 ? "{}".utf8 : "short".utf8))
            default: return (404, [:], Data())
            }
        }
        let peers = PeerService { library }
        let hello = try peers.call(address: server.base, url: "api/sync/hello", key: "k", body: #"{"a":1}"#)
        #expect(hello["status"] as? Int == 200)
        #expect(hello["text"] as? String == #"{"you":{"a":1}}"#)
        #expect(try peers.call(address: server.base, url: "api/sync/hello", key: nil, body: "null")["status"] as? Int == 401)

        try library.remove(storedFilePath(stored.hash))
        #expect(try peers.download(address: server.base, key: "k", hash: helloHash)["size"] as? Int64 == 5)
        #expect(try library.readText(storedFilePath(helloHash)) == "hello")
        let other = String(repeating: "c", count: 64)
        #expect(throws: (any Error).self) { try peers.download(address: server.base, key: "k", hash: other) }
        #expect(try !library.exists(storedFilePath(other)))
        #expect(throws: NexlibrisError("Who are you?")) { try peers.download(address: server.base, key: "x", hash: helloHash) }

        #expect(try peers.upload(address: server.base, key: "k", hash: helloHash)["size"] as? Int64 == 5)
        #expect(server.seen.last?.method == "PUT")
        #expect(server.seen.last?.body == Data("hello".utf8))

        #expect(throws: NexlibrisError("Couldn’t reach http://127.0.0.1:1. Check that it’s on the same network, with sync turned on.")) {
            try peers.call(address: "http://127.0.0.1:1", url: "api/sync/hello", key: "k", body: "null")
        }
    }

    @Test func callsOnlyTheSyncApi() {
        #expect(PeerService.isAllowed(address: "http://192.168.0.11:47811", url: "api/sync/state"))
        #expect(!PeerService.isAllowed(address: "http://192.168.0.11:47811/x", url: "api/sync/state"))
        #expect(!PeerService.isAllowed(address: "http://user@evil:1", url: "api/sync/state"))
        #expect(!PeerService.isAllowed(address: "file:///etc", url: "api/sync/state"))
        #expect(!PeerService.isAllowed(address: "http://192.168.0.11", url: "api/storage/readText"))
        #expect(!PeerService.isAllowed(address: "http://192.168.0.11", url: "api/sync/../storage"))
    }
}
