/**
 * PalmDOC compression, which every Kindle reader reads: LZ77 over a 2047-byte window within one
 * text record (at most 4096 bytes), with three byte codes:
 *
 * - `0x00`, `0x09`–`0x7f`: the byte itself.
 * - `0x01`–`0x08`: that many bytes follow, copied as they are.
 * - `0x80`–`0xbf`: with the next byte, a copy of 3–10 bytes from 1–2047 bytes back.
 * - `0xc0`–`0xff`: a space, then the byte with its high bit cleared.
 */

const WINDOW = 2047;
const MIN_MATCH = 3;
const MAX_MATCH = 10;

const isLiteral = (byte: number) => byte === 0 || (byte > 8 && byte < 0x80);

export function compressPalmDoc(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 8) + 8);
  let length = 0;
  // Where each three-byte sequence was last seen, and before that, for finding matches quickly.
  const head = new Map<number, number>();
  const previous = new Int32Array(data.length).fill(-1);
  const key = (at: number) => (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
  let hashed = 0;
  const hashUpTo = (end: number) => {
    for (; hashed < end && hashed + MIN_MATCH <= data.length; hashed++) {
      const k = key(hashed);
      previous[hashed] = head.get(k) ?? -1;
      head.set(k, hashed);
    }
  };

  let i = 0;
  while (i < data.length) {
    // The longest copy of what follows that lies wholly before it, nearest first among equals.
    let best = 0;
    let bestDistance = 0;
    if (i + MIN_MATCH <= data.length) {
      hashUpTo(i);
      for (let candidate = head.get(key(i)) ?? -1; candidate >= 0 && i - candidate <= WINDOW; candidate = previous[candidate]!) {
        const limit = Math.min(MAX_MATCH, data.length - i, i - candidate);
        let n = 0;
        while (n < limit && data[candidate + n] === data[i + n]) n++;
        if (n > best) {
          best = n;
          bestDistance = i - candidate;
          if (n === MAX_MATCH) break;
        }
      }
    }
    if (best >= MIN_MATCH) {
      const code = 0x8000 | (bestDistance << 3) | (best - MIN_MATCH);
      out[length++] = code >> 8;
      out[length++] = code & 0xff;
      i += best;
      continue;
    }

    const byte = data[i]!;
    const next = data[i + 1];
    if (byte === 0x20 && next !== undefined && next >= 0x40 && next < 0x80) {
      out[length++] = next ^ 0x80;
      i += 2;
    } else if (isLiteral(byte)) {
      out[length++] = byte;
      i++;
    } else {
      // A run of up to eight bytes that can't stand for themselves.
      let end = i + 1;
      while (end < data.length && end - i < 8 && !isLiteral(data[end]!)) end++;
      out[length++] = end - i;
      out.set(data.subarray(i, end), length);
      length += end - i;
      i = end;
    }
  }
  return out.slice(0, length);
}

/** The inverse, for tests and checks. */
export function decompressPalmDoc(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const byte = data[i++]!;
    if (byte >= 1 && byte <= 8) {
      for (let n = 0; n < byte; n++) out.push(data[i++]!);
    } else if (byte < 0x80) {
      out.push(byte);
    } else if (byte >= 0xc0) {
      out.push(0x20, byte ^ 0x80);
    } else {
      const code = (byte << 8) | data[i++]!;
      const distance = (code >> 3) & 0x7ff;
      const count = (code & 7) + MIN_MATCH;
      const from = out.length - distance;
      for (let n = 0; n < count; n++) out.push(out[from + n]!);
    }
  }
  return Uint8Array.from(out);
}
