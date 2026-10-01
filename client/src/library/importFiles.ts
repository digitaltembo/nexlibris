import { createItem, type FileRef, type Item, type LibraryBackend, type Operation } from '@nexlibris/common';
import { CONVERTERS } from '../formats/convert/converters';
import { formatFromName, KINDLE_FORMATS } from '../formats/formats';
import { parseFile } from '../formats/parseFile';
import { runConversion } from './convert';

export interface ImportResult {
  added: Item[];
  skipped: { name: string; reason: string }[];
  /** Imported, but with something to report (e.g. a failed automatic conversion). */
  warnings: { name: string; message: string }[];
}

const kindleToEpub = CONVERTERS.find((c) => c.id === 'kindle-epub')!;

/** Imports files as new items, one per file, skipping files already in the library. */
export async function importFiles(backend: LibraryBackend, files: File[]): Promise<ImportResult> {
  const library = await backend.getLibrary();
  const knownHashes = new Set(Object.values(library.items).flatMap((item) => item.files.map((f) => f.hash)));
  const result: ImportResult = { added: [], skipped: [], warnings: [] };
  const ops: Operation[] = [];

  for (const file of files) {
    const format = formatFromName(file.name);
    if (!format) {
      result.skipped.push({ name: file.name, reason: 'unsupported file type' });
      continue;
    }
    try {
      const { hash, size } = await backend.putFile(file);
      if (knownHashes.has(hash)) {
        result.skipped.push({ name: file.name, reason: 'already in the library' });
        continue;
      }
      const parsed = await parseFile(format, file, file.name);
      knownHashes.add(hash);
      const cover = parsed.cover && {
        hash: (await backend.putFile(parsed.cover.data)).hash,
        mediaType: parsed.cover.mediaType,
      };
      const original: FileRef = { hash, size, format, name: file.name };
      const item = createItem({
        title: parsed.title,
        creators: parsed.creators,
        identifiers: parsed.identifiers,
        tags: parsed.tags,
        metadata: parsed.metadata,
        files: [original],
        cover,
      });
      // Kindle files are read via EPUB, so make one straight away; the original is kept.
      if (KINDLE_FORMATS.includes(format)) {
        try {
          item.files.push(await runConversion(backend, item, original, file, kindleToEpub));
        } catch (e) {
          result.warnings.push({ name: file.name, message: `couldn't convert to EPUB: ${e instanceof Error ? e.message : e}` });
        }
      }
      ops.push({ type: 'addItem', item });
      result.added.push(item);
    } catch (e) {
      result.skipped.push({ name: file.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (ops.length) await backend.apply(ops);
  return result;
}
