import Foundation

/// What a request to another device brought back.
struct HttpReply {
    let response: HTTPURLResponse
    /// The body, for a data or upload task.
    let data: Data
}

/**
 * Runs URLSession tasks to the end and waits for them, for the bridge's queues, which answer one
 * call at a time. Redirects aren't followed when [followRedirects] is false (a reader's calls).
 * Connections stay open between calls, for the next to reuse.
 */
final class BlockingSession: NSObject, URLSessionTaskDelegate {
    private let followRedirects: Bool
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    private let configuration: URLSessionConfiguration

    init(timeout: TimeInterval, followRedirects: Bool = true) {
        self.followRedirects = followRedirects
        configuration = .ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        super.init()
    }

    /// Sends [request], with [body] if given, and reads the reply into memory.
    func data(_ request: URLRequest, body: URL? = nil) throws -> HttpReply {
        let done = Waiter<Result<HttpReply, Error>>()
        let finish = { (data: Data?, response: URLResponse?, error: Error?) in
            if let error { return done.finish(.failure(error)) }
            guard let http = response as? HTTPURLResponse else { return done.finish(.failure(URLError(.badServerResponse))) }
            done.finish(.success(HttpReply(response: http, data: data ?? Data())))
        }
        let task = body.map { session.uploadTask(with: request, fromFile: $0, completionHandler: finish) }
            ?? session.dataTask(with: request, completionHandler: finish)
        task.resume()
        return try done.wait()!.get()
    }

    /// Sends [request] and hands its reply's body, downloaded to a file, to [keep] (which must move or read it before returning).
    func download<T>(_ request: URLRequest, keep: @escaping (HTTPURLResponse, URL) throws -> T) throws -> T {
        let done = Waiter<Result<T, Error>>()
        let task = session.downloadTask(with: request) { file, response, error in
            if let error { return done.finish(.failure(error)) }
            guard let http = response as? HTTPURLResponse, let file else { return done.finish(.failure(URLError(.badServerResponse))) }
            done.finish(Result { try keep(http, file) })
        }
        task.resume()
        return try done.wait()!.get()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(followRedirects ? request : nil)
    }
}

/// Whether [error] is URLSession failing to reach a server (rather than the app's own).
func isNetworkError(_ error: Error) -> Bool { error is URLError }
