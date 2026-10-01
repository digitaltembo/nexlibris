import { MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { describe, expect, it, vi } from 'vitest';
import { importFiles } from './importFiles';

// Under Node the real Kindle parser fetches its resources over the network, so stand in for parsing and conversion.
vi.mock('../formats/parseFile', () => ({
  parseFile: async (_format: string, _data: Blob, name: string) => ({
    title: name,
    creators: [],
    identifiers: {},
    tags: [],
    metadata: {},
    ...(name.endsWith('.mobi') && { cover: { data: new Blob(['cover']), mediaType: 'image/jpeg' } }),
  }),
}));
vi.mock('./convert', () => ({
  runConversion: async () => ({ hash: 'converted', size: 1, format: 'epub' }),
}));

const formatsOf = async (names: string[]) => {
  const backend = new StoredLibraryBackend(new MemoryStorage());
  const { added } = await importFiles(backend, names.map((name) => new File([name], name)));
  return added.map((item) => ({ formats: item.files.map((f) => f.format), cover: !!item.cover, title: item.title }));
};

describe('importFiles with Kindle books', () => {
  it('converts to EPUB only when the book came without one', async () => {
    expect(await formatsOf(['a.mobi'])).toEqual([{ formats: ['mobi', 'epub'], cover: true, title: 'a.mobi' }]);
    expect(await formatsOf(['a.mobi', 'a.x4.epub'])).toEqual([{ formats: ['mobi', 'x4.epub'], cover: true, title: 'a.mobi' }]);
  });

  it('takes the cover from another format when the preferred one has none', async () => {
    expect(await formatsOf(['a.epub', 'a.mobi'])).toEqual([{ formats: ['epub', 'mobi'], cover: true, title: 'a.epub' }]);
  });
});
