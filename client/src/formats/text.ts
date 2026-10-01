import { emptyParsedItem, type ParsedItem } from './formats';

/** Decodes text as UTF-8 (honoring a BOM), falling back to Windows-1252 for legacy files. */
export function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export async function loadRtfjs() {
  const { RTFJS } = await import('rtf.js');
  RTFJS.loggingEnabled(false);
  return RTFJS;
}

/** Plain text has no metadata of its own, so the title comes from the filename. */
export async function parseText(_data: Blob, filename: string): Promise<ParsedItem> {
  return emptyParsedItem(filename);
}

/** Library metadata from an RTF's `\info` group. */
export async function parseRtf(data: Blob, filename: string): Promise<ParsedItem> {
  const parsed = emptyParsedItem(filename);
  const RTFJS = await loadRtfjs();
  const info = new RTFJS.Document(await data.arrayBuffer(), {}).metadata() as Record<string, unknown>;
  const field = (name: string) => (typeof info[name] === 'string' ? (info[name] as string).trim() : '') || undefined;
  parsed.title = field('title') ?? parsed.title;
  const author = field('author');
  if (author) parsed.creators = [{ name: author, role: 'aut' }];
  parsed.tags = field('keywords')?.split(/\s*[,;]\s*/).filter(Boolean) ?? [];
  const subject = field('subject');
  if (subject) parsed.metadata.description = subject;
  return parsed;
}
