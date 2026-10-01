import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openComic, parseComic } from './comic';

// happy-dom rewrites import.meta.url, so resolve from the package root vitest runs in.
const fixture = async (name: string) => new Blob([await readFile(join(process.cwd(), 'src/formats/fixtures', name))]);

async function unrarWasm(): Promise<ArrayBuffer> {
  const path = createRequire(join(process.cwd(), 'package.json')).resolve('node-unrar-js/esm/js/unrar.wasm');
  const bytes = await readFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Both fixtures hold Issue/page1.png, page2.png and page10.png plus ComicInfo.xml;
// the CBZ also has macOS resource-fork junk that must be ignored.
describe.each(['cbz', 'cbr'] as const)('%s', (format) => {
  it('lists image pages in natural order', async () => {
    const comic = await openComic(format, await fixture(`sample.${format}`), { unrarWasm: await unrarWasm() });
    expect(comic.pages.map((p) => p.name.split(/[\\/]/).pop())).toEqual(['page1.png', 'page2.png', 'page10.png']);
    const first = await comic.pages[0]!.load();
    expect(first.type).toBe('image/png');
    expect(first.size).toBeGreaterThan(0);
  });

  it('reads ComicInfo.xml into item metadata, with the first page as cover', async () => {
    const parsed = await parseComic(format, await fixture(`sample.${format}`), `sample.${format}`, {
      unrarWasm: await unrarWasm(),
    });
    expect(parsed).toMatchObject({
      title: 'The Test Issue',
      creators: [
        { name: 'Ann Writer', role: 'aut' },
        { name: 'Pat Artist', role: 'art' },
        { name: 'Ann Writer', role: 'art' },
      ],
      tags: ['Adventure', 'Humor'],
      metadata: { series: 'Sample Comics', seriesIndex: 3, published: '2024-05' },
    });
    expect(parsed.cover?.mediaType).toBe('image/png');
  });
});

it('rejects archives that are not comics', async () => {
  await expect(openComic('cbz', new Blob(['nope']))).rejects.toThrow(/Not a valid CBZ/);
  await expect(openComic('cbr', new Blob(['nope']), { unrarWasm: await unrarWasm() })).rejects.toThrow(/Not a readable CBR/);
});
