import { describe, expect, it } from 'vitest';
import { chunkMessage, decodeMessage, encodeMessage, LAST_CHUNK, MessageAssembler, messageFetch } from './syncMessage';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('sync messages', () => {
  it('encodes a header and body, and splits and reassembles it in chunks', () => {
    const body = new Uint8Array(1000).map((_, i) => i % 251);
    const message = encodeMessage({ method: 'PUT', path: 'api/sync/files/x' }, body);
    const chunks = chunkMessage(message, 185);
    expect(chunks.every((chunk) => chunk.length <= 185)).toBe(true);
    expect(chunks.map((chunk) => chunk[0])).toEqual([...Array(chunks.length - 1).fill(0), LAST_CHUNK]);
    const assembler = new MessageAssembler();
    const out = chunks.map((chunk) => assembler.push(chunk));
    expect(out.slice(0, -1).every((part) => part === undefined)).toBe(true);
    const { header, body: back } = decodeMessage<{ method: string }>(out.at(-1)!);
    expect(header.method).toBe('PUT');
    expect(back).toEqual(body);
    // An empty message is still one chunk.
    expect(chunkMessage(new Uint8Array(), 20)).toEqual([new Uint8Array([LAST_CHUNK])]);
  });

  it('matches the Android app’s framing (BluetoothFramingTest.kt uses the same bytes)', () => {
    const chunks = chunkMessage(encodeMessage({ status: 200 }, new Uint8Array([1, 2, 3])), 8);
    expect(chunks.map(hex)).toEqual(['000e0000007b2273', '007461747573223a', '013230307d010203']);
  });

  it('makes fetch calls as messages, with the key and body', async () => {
    let seen: unknown;
    const fetchOver = messageFetch(async (message) => {
      const { header, body } = decodeMessage(message);
      seen = { header, body: new TextDecoder().decode(body) };
      return encodeMessage({ status: 201 }, new TextEncoder().encode('{"ok":true,"value":1}'));
    });
    const response = await fetchOver('bluetooth://hub/api/sync/state', {
      method: 'POST',
      headers: { Authorization: 'Bearer k3y' },
      body: '{"since":0}',
    });
    expect(seen).toEqual({ header: { method: 'POST', path: 'api/sync/state', key: 'k3y' }, body: '{"since":0}' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, value: 1 });
  });
});
