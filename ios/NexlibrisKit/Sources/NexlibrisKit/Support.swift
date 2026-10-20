import Foundation

/// A JSON object, as `JSONSerialization` reads and writes it.
public typealias JSONObject = [String: Any]

/// An error whose message goes back to the page as it is.
public struct NexlibrisError: LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Throws [message] unless [condition] holds, as Kotlin's `require`.
func require(_ condition: Bool, _ message: @autoclosure () -> String) throws {
    if !condition { throw NexlibrisError(message()) }
}

/// What an error says, for the page.
public func messageOf(_ error: Error) -> String {
    if let error = error as? LocalizedError, let description = error.errorDescription { return description }
    return error.localizedDescription
}

/// Whether [pattern] matches the whole of [text].
func matches(_ pattern: String, _ text: String, caseInsensitive: Bool = false) -> Bool {
    let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
    guard let regex = try? NSRegularExpression(pattern: "^(?:\(pattern))$", options: options) else { return false }
    return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

/// Tokens the page names uploads by.
let tokenPattern = "[A-Za-z0-9-]{1,64}"

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) throws -> String {
        guard let value = self[key] as? String else { throw NexlibrisError("Expected a string for \(key)") }
        return value
    }

    /// The string at [key]; nil if it's missing or null.
    func optionalString(_ key: String) -> String? { self[key] as? String }

    func int(_ key: String) throws -> Int {
        guard let value = self[key] as? NSNumber else { throw NexlibrisError("Expected a number for \(key)") }
        return value.intValue
    }

    func int64(_ key: String) throws -> Int64 {
        guard let value = self[key] as? NSNumber else { throw NexlibrisError("Expected a number for \(key)") }
        return value.int64Value
    }

    func bool(_ key: String) throws -> Bool {
        guard let value = self[key] as? NSNumber else { throw NexlibrisError("Expected a boolean for \(key)") }
        return value.boolValue
    }

    func object(_ key: String) -> JSONObject? { self[key] as? JSONObject }
}

/// JSON text, for a value JSONSerialization takes (fragments too).
func jsonText(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    return String(decoding: data, as: UTF8.self)
}

/// The JSON object in [text], or nil if it isn't one.
func parseObject(_ text: String) -> JSONObject? {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? JSONObject
}

func decodeBase64(_ text: String) throws -> Data {
    guard let data = Data(base64Encoded: text) else { throw NexlibrisError("Not base64") }
    return data
}

/// A value set from one thread and waited for on another.
final class Waiter<T> {
    private let semaphore = DispatchSemaphore(value: 0)
    private var value: T?

    func finish(_ value: T) {
        self.value = value
        semaphore.signal()
    }

    /// The value, once it's set; nil if [timeout] passes first.
    func wait(timeout: DispatchTime = .distantFuture) -> T? {
        semaphore.wait(timeout: timeout) == .success ? value : nil
    }
}

/// A queue of values that one thread waits on (Kotlin's `LinkedBlockingQueue`, as much as is needed).
final class BlockingQueue<T> {
    private let condition = NSCondition()
    private var items: [T] = []

    func put(_ item: T) {
        condition.lock()
        items.append(item)
        condition.signal()
        condition.unlock()
    }

    /// The next item, waiting up to [timeout] seconds for one.
    func poll(timeout: TimeInterval) -> T? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while items.isEmpty {
            if !condition.wait(until: deadline) { break }
        }
        return items.isEmpty ? nil : items.removeFirst()
    }

    /// The next item if there is one, without waiting.
    func poll() -> T? { poll(timeout: 0) }

    func clear() {
        condition.lock()
        items.removeAll()
        condition.unlock()
    }
}

/// A value read and written from several threads (Kotlin's `@Volatile`).
final class Locked<T> {
    private let lock = NSLock()
    private var value: T

    init(_ value: T) { self.value = value }

    var get: T {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: T) {
        lock.lock()
        value = newValue
        lock.unlock()
    }
}
