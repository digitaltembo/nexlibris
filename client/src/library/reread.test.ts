import { createItem, MemoryStorage, StoredLibraryBackend, type Operation } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import type { ParsedItem } from '../formats/formats';
import { rereadMetadata } from './reread';

const parsed = (fields: Partial<ParsedItem>): ParsedItem => ({ title: 'From file', creators: [], identifiers: {}, tags: [], metadata: {}, ...fields });

describe('rereadMetadata', () => {
  it('fills in what items lack from their best file, keeping what they have', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage(), 'Books');
    const epub = await backend.putFile(new Blob(['epub']));
    const pdf = await backend.putFile(new Blob(['pdf']));
    const edited = createItem({
      title: 'Dune',
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      tags: ['Mine'],
      identifiers: { isbn: '9780441172719' },
      metadata: { publisher: 'Edited', series: 'Dune' },
      files: [{ ...pdf, format: 'pdf' }, { ...epub, format: 'epub' }],
    });
    const bare = createItem({ title: 'Bare', files: [{ ...pdf, format: 'pdf' }] });
    const elsewhere = createItem({ title: 'Elsewhere', files: [{ hash: 'f'.repeat(64), size: 1, format: 'epub' }] });
    await backend.apply([edited, bare, elsewhere].map((item): Operation => ({ type: 'addItem', item })));

    const read: string[] = [];
    const parse = async (format: string) => {
      read.push(format);
      return format === 'epub'
        ? parsed({ creators: [{ name: 'Someone Else', role: 'aut' }], tags: ['Theirs'], identifiers: { isbn: '0', uuid: 'u' }, metadata: { publisher: 'Ace', titleSort: 'Dune', originallyPublished: '1965' } })
        : parsed({ creators: [{ name: 'Anon', role: 'aut' }], tags: ['PDF'], metadata: { pages: 12 }, cover: { data: new Blob(['cover']), mediaType: 'image/png' } });
    };
    const result = await rereadMetadata(backend, await backend.getLibrary(), (ops) => backend.apply(ops), { parse, color: async () => '#336699' });

    expect(read).toEqual(['epub', 'pdf']);
    const library = await backend.getLibrary();
    expect(library.items[edited.id]).toMatchObject({
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      tags: ['Mine'],
      identifiers: { isbn: '9780441172719', uuid: 'u' },
      metadata: { publisher: 'Edited', series: 'Dune', titleSort: 'Dune', originallyPublished: '1965' },
    });
    expect(library.items[bare.id]).toMatchObject({
      creators: [{ name: 'Anon', role: 'aut' }],
      tags: ['PDF'],
      metadata: { pages: 12, coverColor: '#336699' },
      cover: { mediaType: 'image/png' },
    });
    expect(result).toEqual({ updated: 2, filled: 8, notHere: 1, failed: [] });

    // Again: nothing left to fill.
    expect(await rereadMetadata(backend, library, (ops) => backend.apply(ops), { parse, color: async () => '#336699' })).toMatchObject({ updated: 0, filled: 0 });
  });
});
