import type { FileRef, Item, LibraryBackend, Operation } from '@nexlibris/common';
import { convertersFrom, type Converter } from '../formats/convert/converters';
import { titleFromFilename, type FormatId } from '../formats/formats';

/** Conversions offered for `file`, leaving out ones whose current output the item already has. */
export function availableConversions(item: Item, file: FileRef): Converter[] {
  return convertersFrom(file.format).filter(
    (c) =>
      !item.files.some(
        (f) =>
          f.derivedFrom?.hash === file.hash &&
          f.derivedFrom.converter === c.id &&
          f.derivedFrom.converterVersion === c.version,
      ),
  );
}

/** Runs a conversion and stores the output, returning the file reference to attach. */
export async function runConversion(
  backend: LibraryBackend,
  item: Item,
  file: FileRef,
  data: Blob,
  converter: Converter,
): Promise<FileRef> {
  const coverData = item.cover && (await backend.getFile(item.cover.hash));
  const cover = coverData && item.cover ? { data: coverData, mediaType: item.cover.mediaType } : undefined;
  const output = await converter.run(data, file.format as FormatId, { item, cover });
  const { hash, size } = await backend.putFile(output);
  const base = file.name ? titleFromFilename(file.name) : item.title;
  return {
    hash,
    size,
    format: converter.to,
    name: `${base}.${converter.to}`,
    derivedFrom: { hash: file.hash, converter: converter.id, converterVersion: converter.version },
  };
}

/** Converts one of an item's stored files and returns the operation that attaches the result. */
export async function convertItemFile(
  backend: LibraryBackend,
  item: Item,
  file: FileRef,
  converter: Converter,
): Promise<Operation> {
  const data = await backend.getFile(file.hash);
  if (!data) throw new Error(`${file.name ?? file.format} is missing from storage`);
  return { type: 'attachFile', id: item.id, file: await runConversion(backend, item, file, data, converter) };
}

/** The first of an item's files that a target format can be made from. */
export function conversionSource(item: Item, to: FormatId): { file: FileRef; converter: Converter } | undefined {
  if (item.files.some((f) => f.format === to)) return undefined;
  for (const file of item.files) {
    const converter = availableConversions(item, file).find((c) => c.to === to);
    if (converter) return { file, converter };
  }
  return undefined;
}
