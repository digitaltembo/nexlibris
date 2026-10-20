import type { Device, FileRef, Item, Library } from '@nexlibris/common';
import type { Converter } from '../formats/convert/converters';
import type { FormatId } from '../formats/formats';
import { conversionSource } from '../library/convert';
import { isBehind } from '../library/fileMetadata';
import type { StaleFile } from '../library/updateFiles';
import { itemFiles } from './selection';
import type { ConnectionType } from './types';

/**
 * What to ask before sending books to a connection. Sending never converts or rewrites a file, so
 * anything that would make what's sent better is done first, in the library, if the user wants:
 *
 * - `convertible`: books without a format the connection prefers (`ConnectionType.preferred`), which a
 *   converter can make from a file they have;
 * - `behind`: files that would be sent whose metadata is behind the library's (`fileMetadata.ts`),
 *   which can be updated first (`updateFiles`);
 * - `unsendable`: books with nothing the connection takes, and nothing to make it from.
 *
 * Nothing to ask means the books go as they are.
 */
export interface SendCheck {
  convertible: { item: Item; file: FileRef; converter: Converter }[];
  behind: StaleFile[];
  unsendable: Item[];
}

export const needsAsking = (check: SendCheck) => check.convertible.length > 0 || check.behind.length > 0;

export function checkSend(library: Library, device: Device, type: ConnectionType, items: Item[]): SendCheck {
  const check: SendCheck = { convertible: [], behind: [], unsendable: [] };
  const preferred = type.preferred?.(device) ?? [];
  for (const item of items) {
    // Files chosen for it by hand go as they are: the choice was the user's.
    const chosen = !!device.files?.[item.id];
    const source = chosen ? undefined : convertTo(item, preferred);
    if (source) check.convertible.push({ item, ...source });
    const files = itemFiles(item, device, type);
    if (!files.length && !source) check.unsendable.push(item);
    for (const file of files) if (isBehind(item, file)) check.behind.push({ item, file, changes: [] });
  }
  return check;
}

/** What to convert for a book that has none of `preferred`: the first preferred format a converter can make for it. */
function convertTo(item: Item, preferred: FormatId[]) {
  if (!preferred.length || item.files.some((file) => preferred.includes(file.format as FormatId))) return undefined;
  for (const format of preferred) {
    const source = conversionSource(item, format);
    if (source) return source;
  }
  return undefined;
}
