package org.nexlibris.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BluetoothFramingTest {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /** `{"status":200}` with body 01 02 03, as common/src/syncMessage.ts encodes it. */
    private val message = byteArrayOf(14, 0, 0, 0) + "{\"status\":200}".toByteArray() + byteArrayOf(1, 2, 3)

    @Test
    fun chunksAsTheWebAppDoes() {
        // The same bytes as syncMessage.test.ts expects.
        assertEquals(
            listOf("000e0000007b2273", "007461747573223a", "013230307d010203"),
            BluetoothFraming.chunks(message, 8).map(::hex),
        )
        assertEquals(listOf("01"), BluetoothFraming.chunks(ByteArray(0), 20).map(::hex))
    }

    @Test
    fun reassemblesChunksIntoMessages() {
        val assembler = BluetoothFraming.Assembler()
        val chunks = BluetoothFraming.chunks(message, 5)
        chunks.dropLast(1).forEach { assertNull(assembler.push(it)) }
        assertArrayEquals(message, assembler.push(chunks.last()))
        // And the next message starts afresh.
        assertArrayEquals(byteArrayOf(9), assembler.push(byteArrayOf(1, 9)))
    }
}
