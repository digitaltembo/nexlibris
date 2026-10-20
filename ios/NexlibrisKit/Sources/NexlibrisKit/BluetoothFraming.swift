import Foundation

/**
 * Sync messages split into Bluetooth-sized chunks and put back together: `chunkMessage` and
 * `MessageAssembler` in common/src/syncMessage.ts, which this must match (as must Android's
 * `BluetoothFraming.kt`). Each chunk is a flags byte ([lastChunk] on a message's final one) and
 * then part of the message.
 */
public enum BluetoothFraming {
    public static let lastChunk: UInt8 = 1

    /// Splits [message] into chunks of at most [size] bytes, flags included.
    public static func chunks(_ message: Data, size: Int) throws -> [Data] {
        try require(size >= 2, "Chunks of \(size) bytes can't carry anything")
        let bytes = [UInt8](message)
        let room = size - 1
        var chunks: [Data] = []
        var offset = 0
        repeat {
            let end = min(offset + room, bytes.count)
            var chunk = Data([offset + room >= bytes.count ? lastChunk : 0])
            chunk.append(contentsOf: bytes[offset..<end])
            chunks.append(chunk)
            offset += room
        } while offset < bytes.count
        return chunks
    }

    /// Puts one device's chunks back together; [push] returns the message once its last chunk is in.
    public final class Assembler {
        private var buffer = Data()

        public init() {}

        public func push(_ chunk: Data) -> Data? {
            guard let flags = chunk.first else { return nil }
            buffer.append(chunk.dropFirst())
            if flags & BluetoothFraming.lastChunk == 0 { return nil }
            defer { buffer = Data() }
            return buffer
        }

        public func reset() { buffer = Data() }
    }
}
