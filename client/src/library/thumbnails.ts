import type { Cover, FileHash, LibraryBackend } from '@nexlibris/common';

/**
 * Covers as shown: shrunk once, then kept in the backend's local files (`thumbs/<ab>/<hash>.jpg`,
 * by the cover's hash, so a thumbnail never goes stale), since a full-size cover decodes to
 * megabytes and a library shows hundreds. Thumbnails are this instance's own: not synced or
 * backed up, and made again if they're lost. Change the folder's name when their size or format
 * changes, so the old ones aren't used.
 */

/** The box a thumbnail fits in: the widest cover shown (a grid cell, about 200px) on a 2x screen. */
export const THUMBNAIL_WIDTH = 400;
export const THUMBNAIL_HEIGHT = 600;
const QUALITY = 0.85;
/** How many covers are shrunk at once; each decodes its full-size image. */
const AT_ONCE = 2;

export const thumbnailPath = (hash: FileHash) => `thumbs/${hash.slice(0, 2)}/${hash}.jpg`;

/** An image shrunk to fit the thumbnail box (never enlarged), as JPEG, on white where it's transparent. */
export async function makeThumbnail(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, THUMBNAIL_WIDTH / bitmap.width, THUMBNAIL_HEIGHT / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'undefined' ? Object.assign(document.createElement('canvas'), { width, height }) : new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('No canvas to draw the thumbnail on.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    if (canvas instanceof HTMLCanvasElement) {
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the thumbnail."))), 'image/jpeg', QUALITY),
      );
    }
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  } finally {
    bitmap.close();
  }
}

/** Runs tasks a few at a time, in the order they were asked for. */
function limiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

interface Thumbnails {
  pending: Map<FileHash, Promise<Blob | undefined>>;
  limit: ReturnType<typeof limiter>;
}

const perBackend = new WeakMap<LibraryBackend, Thumbnails>();

/**
 * A cover's thumbnail, made and kept the first time it's asked for; undefined if the cover isn't
 * stored here. If it can't be shrunk (an image the browser can't decode), the cover itself.
 * Asking again while it's being made shares the work. Either way it has its image type, as the
 * apps serve stored files untyped.
 */
export function coverThumbnail(
  backend: LibraryBackend,
  { hash, mediaType }: Cover,
  make: (image: Blob) => Promise<Blob> = makeThumbnail,
): Promise<Blob | undefined> {
  let thumbnails = perBackend.get(backend);
  if (!thumbnails) perBackend.set(backend, (thumbnails = { pending: new Map(), limit: limiter(AT_ONCE) }));
  const { pending, limit } = thumbnails;
  let thumbnail = pending.get(hash);
  if (thumbnail) return thumbnail;
  thumbnail = (async () => {
    const path = thumbnailPath(hash);
    const kept = await backend.readLocalFile(path).catch(() => undefined);
    if (kept) return kept.slice(0, kept.size, 'image/jpeg');
    return limit(async () => {
      const cover = await backend.getFile(hash);
      if (!cover) return undefined;
      let made: Blob;
      try {
        made = await make(cover);
      } catch {
        return cover.slice(0, cover.size, mediaType);
      }
      // Shown even if it can't be kept; it's made again next time.
      await backend.writeLocalFile(path, made).catch((e: unknown) => console.warn("Couldn't keep a cover's thumbnail", e));
      return made;
    });
  })().finally(() => pending.delete(hash));
  pending.set(hash, thumbnail);
  return thumbnail;
}
