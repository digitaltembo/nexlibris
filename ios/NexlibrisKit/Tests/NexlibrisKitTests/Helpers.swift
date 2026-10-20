import Foundation
import Network
@testable import NexlibrisKit

/// A fresh folder for one test, deleted when it's done with.
final class TempFolder {
    let url: URL

    init() {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("nexlibris-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    func folder(_ name: String) -> URL {
        let folder = url.appendingPathComponent(name, isDirectory: true)
        try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    func storage(_ name: String) -> FileStorage { try! FileStorage(root: url.appendingPathComponent(name, isDirectory: true)) }
}

func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

func stream(_ text: String) -> InputStream { InputStream(data: Data(text.utf8)) }

/// A request as client/src/backends/iosBridge.ts sends it.
func request(_ method: String, _ url: String, _ body: String) -> JSONObject {
    parseObject(#"{"id":1,"method":"\#(method)","url":"\#(url)","body":\#(body)}"#)!
}

/// What a test server was asked.
struct Seen {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

/// A plain-http server on localhost for the relays to call: [answer] gives each request's status, headers and body.
final class TestServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test-server")
    private let recorder = Recorder()
    let port: UInt16

    private final class Recorder {
        let lock = NSLock()
        var requests: [Seen] = []

        func add(_ seen: Seen) {
            lock.lock()
            requests.append(seen)
            lock.unlock()
        }
    }

    init(answer: @escaping (Seen) -> (Int, [String: String], Data)) throws {
        listener = try NWListener(using: .tcp, on: .any)
        let started = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in if case .ready = state { started.signal() } }
        listener.newConnectionHandler = { [queue, recorder] connection in
            connection.start(queue: queue)
            TestServer.read(connection, Data()) { seen in
                recorder.add(seen)
                let (status, headers, body) = answer(seen)
                var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\n"
                for (name, value) in headers { head += "\(name): \(value)\r\n" }
                head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        listener.start(queue: queue)
        started.wait()
        port = listener.port!.rawValue
    }

    deinit { listener.cancel() }

    var base: String { "http://127.0.0.1:\(port)" }

    var seen: [Seen] {
        recorder.lock.lock()
        defer { recorder.lock.unlock() }
        return recorder.requests
    }

    private static func read(_ connection: NWConnection, _ buffer: Data, _ done: @escaping (Seen) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, finished, _ in
            let all = buffer + (data ?? Data())
            if let end = all.range(of: Data("\r\n\r\n".utf8)) {
                let lines = String(decoding: all[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let start = lines[0].split(separator: " ")
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    if let colon = line.firstIndex(of: ":") {
                        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    }
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                let body = all[end.upperBound...]
                if body.count >= length {
                    return done(Seen(method: String(start[0]), path: String(start[1]), headers: headers, body: Data(body.prefix(length))))
                }
            }
            if finished { return connection.cancel() }
            read(connection, all, done)
        }
    }
}
