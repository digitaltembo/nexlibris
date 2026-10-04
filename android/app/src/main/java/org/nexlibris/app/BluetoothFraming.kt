package org.nexlibris.app

import java.io.ByteArrayOutputStream

/**
 * Sync messages split into Bluetooth-sized chunks and put back together: `chunkMessage` and
 * `MessageAssembler` in common/src/syncMessage.ts, which this must match. Each chunk is a flags
 * byte ([LAST_CHUNK] on a message's final one) and then part of the message.
 */
object BluetoothFraming {
    const val LAST_CHUNK = 1

    /** Splits [message] into chunks of at most [size] bytes, flags included. */
    fun chunks(message: ByteArray, size: Int): List<ByteArray> {
        require(size >= 2) { "Chunks of $size bytes can't carry anything" }
        val room = size - 1
        val chunks = mutableListOf<ByteArray>()
        var offset = 0
        do {
            val end = minOf(offset + room, message.size)
            val chunk = ByteArray(1 + end - offset)
            chunk[0] = if (offset + room >= message.size) LAST_CHUNK.toByte() else 0
            message.copyInto(chunk, 1, offset, end)
            chunks += chunk
            offset += room
        } while (offset < message.size)
        return chunks
    }

    /** Puts one device's chunks back together; [push] returns the message once its last chunk is in. */
    class Assembler {
        private val buffer = ByteArrayOutputStream()

        fun push(chunk: ByteArray): ByteArray? {
            if (chunk.isEmpty()) return null
            buffer.write(chunk, 1, chunk.size - 1)
            if (chunk[0].toInt() and LAST_CHUNK == 0) return null
            return buffer.toByteArray().also { buffer.reset() }
        }

        fun reset() = buffer.reset()
    }
}
