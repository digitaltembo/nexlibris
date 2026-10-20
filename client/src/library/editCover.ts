import type { Item, LibraryBackend, Operation } from '@nexlibris/common';
import { coverColor } from './coverColor';

/** A cover chosen in the editor, kept until it's saved. */
export interface NewCover {
  data: Blob;
  mediaType: string;
}

/** An image file as a cover, or undefined if it isn't an image. */
export function coverFromFile(file: File): NewCover | undefined {
  return file.type.startsWith('image/') ? { data: file, mediaType: file.type } : undefined;
}

/**
 * Stores a new cover and gives the operations that make it the item's, with its colour. None if
 * it's the cover the item has. The old cover's file is left for `freeFiles` to delete.
 */
export async function coverOperations(
  backend: LibraryBackend,
  item: Item,
  cover: NewCover,
  color: (image: Blob) => Promise<string | undefined> = coverColor,
): Promise<Operation[]> {
  const { hash } = await backend.putFile(cover.data);
  if (hash === item.cover?.hash) return [];
  const ops: Operation[] = [{ type: 'updateItem', id: item.id, patch: { cover: { hash, mediaType: cover.mediaType } } }];
  const shade = await color(cover.data);
  if (shade !== item.metadata.coverColor) ops.push({ type: 'setMetadata', id: item.id, key: 'coverColor', value: shade });
  return ops;
}
