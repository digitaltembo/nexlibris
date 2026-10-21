import type { FileRef, Item, LibraryBackend, Operation } from '@nexlibris/common';
import { betterPath, conversionPath, conversionPaths, type Converter } from '@nexlibris/tools/formats/convert/converters';
import { isEpub, titleFromFilename, type FormatId } from '@nexlibris/tools/formats/formats';
import { fileMetadata, metadataKey } from './fileMetadata';

/** A file and the conversions that make a format from it, in turn (more than one by way of other formats). */
export interface ConversionSource {
  file: FileRef;
  path: Converter[];
}

/** What a path records on the file it makes: its converters' ids and versions, joined (one converter's as they are). */
export const pathId = (path: Converter[]) => path.map((c) => c.id).join('+');
const pathVersion = (path: Converter[]) => path.map((c) => c.version).join('+');

/** The formats `file` converts to and how, the least lossy first, leaving out ones whose current output the item already has. */
export function availableConversions(item: Item, file: FileRef): Map<FormatId, Converter[]> {
  const paths = conversionPaths(file.format);
  for (const [to, path] of paths) {
    const made = item.files.some(
      (f) =>
        f.derivedFrom?.hash === file.hash &&
        f.derivedFrom.converter === pathId(path) &&
        f.derivedFrom.converterVersion === pathVersion(path),
    );
    if (made) paths.delete(to);
  }
  return paths;
}

/**
 * Runs a conversion, one converter after another, and stores the output (not what's made on the way),
 * returning the file reference to attach. An EPUB made gets the item's current metadata: one made
 * from another EPUB (a reader's optimized copy) has it written in, as it would otherwise say what its
 * source did; the rest are made from the item.
 */
export async function runConversion(
  backend: LibraryBackend,
  item: Item,
  file: FileRef,
  data: Blob,
  path: Converter[],
): Promise<FileRef> {
  const last = path.at(-1);
  if (!last) throw new Error('Nothing to convert with');
  const coverData = item.cover && (await backend.getFile(item.cover.hash));
  const cover = coverData && item.cover ? { data: coverData, mediaType: item.cover.mediaType } : undefined;
  let output = data;
  let from = file.format as FormatId;
  for (const converter of path) {
    const input = from;
    output = await converter.run(output, input, { item, cover });
    from = converter.to;
    if (converter === last && isEpub(converter.to) && isEpub(input)) {
      output = await (await import('@nexlibris/tools/formats/epubMetadata')).writeEpubMetadata(output, fileMetadata(item));
    }
  }
  const epub = isEpub(last.to);
  const { hash, size } = await backend.putFile(output);
  const base = file.name ? titleFromFilename(file.name) : item.title;
  return {
    hash,
    size,
    format: last.to,
    name: `${base}.${last.to}`,
    derivedFrom: { hash: file.hash, converter: pathId(path), converterVersion: pathVersion(path) },
    ...(epub && { metadataKey: metadataKey(item) }),
  };
}

/** Converts one of an item's stored files and returns the operation that attaches the result. */
export async function convertItemFile(
  backend: LibraryBackend,
  item: Item,
  file: FileRef,
  path: Converter[],
): Promise<Operation> {
  const data = await backend.getFile(file.hash);
  if (!data) throw new Error(`${file.name ?? file.format} is missing from storage`);
  return { type: 'attachFile', id: item.id, file: await runConversion(backend, item, file, data, path) };
}

/**
 * The best way to make a format for an item that lacks it: from the file whose conversion loses least
 * (the most kept, `pathFidelity`; as much in fewer conversions, else the first such file), or, given `from`, its first file in that format.
 */
export function conversionSource(item: Item, to: FormatId, from?: string): ConversionSource | undefined {
  if (item.files.some((f) => f.format === to)) return undefined;
  let best: ConversionSource | undefined;
  for (const file of item.files) {
    if (from && file.format !== from) continue;
    const path = conversionPath(file.format, to);
    if (path && (!best || betterPath(path, best.path))) best = { file, path };
  }
  return best;
}
