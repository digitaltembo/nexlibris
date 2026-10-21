import { encint } from './records';

/**
 * Trailing byte sequences (TBS): at the end of each text record, which table of contents
 * entries start, end, span or lie within it, so a Kindle can step between chapters without
 * reading the index. Both formats write them; KF8's arrange a record's entries in strands
 * (an entry, then its first child's, and so on down), MOBI 6's (a flat table) don't.
 */

export interface TocEntry {
  /** Its position in the index. */
  index: number;
  /** Where it starts in the text, and how far it runs. */
  offset: number;
  length: number;
  depth: number;
  parent?: number;
}

/** A number with flags in its lowest bits, then the values the flags announce. */
function sequence(value: number, extra: Map<number, number>, flagBits: number): number[] {
  let flags = 0;
  for (const flag of extra.keys()) flags |= flag;
  const out = encint(value * 2 ** flagBits + (flags & (2 ** flagBits - 1)));
  if (extra.has(0b10)) out.push(...encint(extra.get(0b10)!));
  if (extra.has(0b100)) out.push(extra.get(0b100)!);
  if (extra.has(0b1)) out.push(...encint(extra.get(0b1)!));
  return out;
}

type Action = 'spans' | 'ends' | 'starts' | 'completes';
interface Local extends TocEntry {
  action: Action;
}

/** An entry, then its first child's strand, else the siblings after it that have no children. */
function strand(top: Local, rest: Local[]): Local[] {
  const out = [top];
  const take = (entry: Local) => rest.splice(rest.indexOf(entry), 1);
  const child = rest.find((c) => c.parent === top.index);
  if (child) {
    take(child);
    return [...out, ...strand(child, rest)];
  }
  let current = top.index;
  for (const entry of [...rest]) {
    if (entry.depth !== top.depth || entry.parent !== top.parent || entry.index !== current + 1) continue;
    current++;
    take(entry);
    if (rest.some((c) => c.parent === entry.index)) {
      out.push(...strand(entry, rest));
      break;
    }
    out.push(entry);
  }
  return out;
}

class NegativeIndex extends Error {}

/** One record's KF8 sequences. `type` is 8, or 5 where a later strand starts before an earlier one ends. */
function kf8Sequences(local: Local[], type: number): number[] {
  const strands: Local[][][] = [];
  const rest = [...local];
  while (rest.length) {
    const top = rest.shift()!;
    const layers = new Map<number, Local[]>();
    for (const entry of strand(top, rest)) {
      if (!layers.has(entry.depth)) layers.set(entry.depth, []);
      layers.get(entry.depth)!.push(entry);
    }
    strands.push([...layers.values()]);
  }
  const first = strands[0]?.[0]?.[0];
  const sequences: [number, Map<number, number>][] = [];
  let lastIndex = 0;
  for (const layers of strands) {
    const own: [number, Map<number, number>][] = [];
    for (const entries of layers) {
      const extra = new Map<number, number>();
      if (entries.at(-1)!.action === 'spans') extra.set(0b1, 0);
      if (entries[0] === first) extra.set(0b10, type);
      if (entries.length > 1) extra.set(0b100, entries.length);
      let index = entries[0]!.index - (entries[0]!.parent ?? 0);
      if (sequences.length && !own.length) {
        // A later strand counts back from where the one before it ended.
        index = lastIndex - entries[0]!.index;
        if (index < 0) {
          if (type !== 5) throw new NegativeIndex();
          index = -index;
        } else extra.set(0b1000, 1);
      }
      lastIndex = entries.at(-1)!.index;
      own.push([index, extra]);
    }
    // Of consecutive spanning layers, only the last says so.
    for (let i = 0; i + 1 < own.length; i++) if (own[i]![1].has(0b1) && own[i + 1]![1].has(0b1)) own[i]![1].delete(0b1);
    sequences.push(...own);
  }
  return sequences.flatMap(([value, extra], i) => sequence(value, extra, i === 0 ? 3 : 4));
}

/** The entries touching each record, as each touches it. */
function touching(entries: TocEntry[], lengths: number[]): Local[][] {
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  const out: Local[][] = [];
  let start = 0;
  for (const length of lengths) {
    const local: Local[] = [];
    for (const entry of sorted) {
      if (entry.offset >= start + length) break;
      if (entry.offset + entry.length <= start) continue;
      const from = entry.offset - start;
      const to = from + entry.length;
      const action: Action = from < 0 ? (to > length ? 'spans' : 'ends') : to > length ? 'starts' : 'completes';
      local.push({ ...entry, action });
    }
    out.push(local);
    start += length;
  }
  return out;
}

/** Each text record's KF8 sequences, given its length before compression. */
export function kf8Tbs(entries: TocEntry[], lengths: number[]): number[][] {
  const records = touching(entries, lengths);
  try {
    return records.map((local) => kf8Sequences(local, 8));
  } catch (e) {
    if (!(e instanceof NegativeIndex)) throw e;
    return records.map((local) => kf8Sequences(local, 5));
  }
}

/** Each text record's MOBI 6 sequence, for a flat table of contents. */
export function mobi6Tbs(entries: TocEntry[], lengths: number[]): number[][] {
  return touching(entries, lengths).map((local) => {
    if (!local.length) return [];
    const spanning = local.find((e) => e.action === 'spans');
    if (spanning) return sequence(spanning.index, new Map([[0b10, 0], [0b1, 0]]), 3);
    const starts = local.filter((e) => e.action === 'starts');
    const ends = local.filter((e) => e.action === 'ends');
    const completes = local.filter((e) => e.action === 'completes');
    if (!completes.length && ((starts.length === 1 && !ends.length) || (ends.length === 1 && !starts.length))) {
      return sequence((starts[0] ?? ends[0])!.index, new Map([[0b10, 0]]), 3);
    }
    const nodes = [...starts, ...completes, ...ends].sort((a, b) => a.index - b.index);
    return sequence(nodes[0]!.index, new Map([[0b10, 0], [0b100, nodes.length]]), 3);
  });
}
