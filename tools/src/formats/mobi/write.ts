import type { ConvertContext } from '../convert/bookFromItem';
import { readEpubPackage } from './epub';
import { writeKf8 } from './kf8';
import { writeMobi6 } from './mobi6';

/**
 * An EPUB as a Kindle book: AZW3 as KF8, which keeps its HTML and CSS; MOBI and AZW as MOBI 6,
 * which every Kindle reads, with its formatting as far as that format's markup can carry it.
 * The metadata and cover are the library's, as in every conversion.
 */
export async function epubToKindle(data: Blob, ctx: ConvertContext, format: 'mobi' | 'azw' | 'azw3'): Promise<Blob> {
  const pkg = await readEpubPackage(data);
  return format === 'azw3' ? writeKf8(pkg, ctx) : writeMobi6(pkg, ctx);
}
