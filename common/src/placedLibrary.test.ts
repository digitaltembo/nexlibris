import { describe, expect, it } from 'vitest';
import { createItem } from './operations';
import { LAYOUT_PATH, PlacedLibraryBackend, servedLibraryPath, type Placer } from './placedLibrary';
import { MemoryStorage } from './storage';
import type { Item } from './types';

/** Books at `<author>/<title>.<format>`, as the client's templates would put them. */
const placer: Placer = (library) => {
  const wanted = new Map<string, string>();
  for (const item of Object.values(library.items)) {
    for (const file of item.files) wanted.set(file.hash, `${item.creators[0]?.name ?? 'Unknown'}/${item.title}.${file.format}`);
  }
  return wanted;
};
const layout = { folder: '<author>', fileName: '<title>' };

async function open(root = new MemoryStorage()) {
  const backend = await PlacedLibraryBackend.open(root, placer, layout);
  await backend.place();
  return { root, backend };
}

async function addBook(backend: PlacedLibraryBackend, title: string, text: string): Promise<Item> {
  const { hash, size } = await backend.putFile(new Blob([text]));
  const item = createItem({ title, creators: [{ name: 'Frank Herbert', role: 'aut' }], files: [{ hash, size, format: 'epub' }] });
  await backend.apply([{ type: 'addItem', item }]);
  await backend.place();
  return item;
}

describe('a library in a folder of the user’s', () => {
  it('keeps its own files in .nexlibris and the books where the layout says', async () => {
    const { root, backend } = await open();
    const dune = await addBook(backend, 'Dune', 'spice');
    expect(root.allPaths()).toEqual([
      '.nexlibris/changes.jsonl',
      '.nexlibris/layout.json',
      '.nexlibris/library.json',
      '.nexlibris/placed.json',
      'Frank Herbert/Dune.epub',
    ]);
    expect(await (await backend.getFile(dune.files[0]!.hash))?.text()).toBe('spice');
    expect(await backend.hasFile(dune.files[0]!.hash)).toBe(true);
    // Storing it again finds it placed.
    await backend.putFile(new Blob(['spice']));
    expect(root.allPaths()).not.toContain(expect.stringMatching(/^\.nexlibris\/files\//));
  });

  it('moves a book’s files when its details change, and puts away files no book has', async () => {
    const { root, backend } = await open();
    const dune = await addBook(backend, 'Dune', 'spice');
    await backend.apply([{ type: 'updateItem', id: dune.id, patch: { title: 'Dune Messiah' } }]);
    await backend.place();
    expect(root.allPaths()).toContain('Frank Herbert/Dune Messiah.epub');
    expect(root.allPaths()).not.toContain('Frank Herbert/Dune.epub');

    const hash = dune.files[0]!.hash;
    await backend.apply([{ type: 'detachFile', id: dune.id, hash }]);
    await backend.place();
    expect(root.allPaths()).toContain(`.nexlibris/files/${hash.slice(0, 2)}/${hash}`);
    await backend.deleteFile(hash);
    expect(await backend.hasFile(hash)).toBe(false);
  });

  it('swaps two books whose paths each want the other’s', async () => {
    const { root, backend } = await open();
    const a = await addBook(backend, 'A', 'first');
    const b = await addBook(backend, 'B', 'second');
    await backend.apply([
      { type: 'updateItem', id: a.id, patch: { title: 'B' } },
      { type: 'updateItem', id: b.id, patch: { title: 'A' } },
    ]);
    await backend.place();
    expect(await root.readText('Frank Herbert/B.epub')).toBe('first');
    expect(await root.readText('Frank Herbert/A.epub')).toBe('second');
  });

  it('moves everything when the layout changes, and opens again as it was left', async () => {
    const { root, backend } = await open();
    const dune = await addBook(backend, 'Dune', 'spice');
    await backend.setLayout({ folder: '', fileName: '<title>' });
    const byTitle: Placer = (library) => new Map(Object.values(library.items).flatMap((i) => i.files.map((f) => [f.hash, `${i.title}.${f.format}`])));
    const again = await PlacedLibraryBackend.open(root, byTitle);
    await again.place();
    expect(JSON.parse((await root.readText(LAYOUT_PATH))!)).toEqual({ folder: '', fileName: '<title>' });
    expect(root.allPaths()).toContain('Dune.epub');
    expect((await again.getLibrary()).items[dune.id]?.title).toBe('Dune');
  });

  it('leaves alone a file that isn’t the library’s', async () => {
    const root = new MemoryStorage();
    await root.writeText('Frank Herbert/Dune.epub', 'mine');
    const { backend } = await open(root);
    const dune = await addBook(backend, 'Dune', 'spice');
    expect(await root.readText('Frank Herbert/Dune.epub')).toBe('mine');
    expect(await (await backend.getFile(dune.files[0]!.hash))?.text()).toBe('spice');
  });

  it('serves the app books and thumbnails, never its data', () => {
    expect(servedLibraryPath('files/ab/abc', false)).toBe(true);
    expect(servedLibraryPath('library.json', false)).toBe(false);
    expect(servedLibraryPath('Frank Herbert/Dune.epub', true)).toBe(true);
    expect(servedLibraryPath('.nexlibris/local/thumbs/ab/x.jpg', true)).toBe(true);
    expect(servedLibraryPath('.nexlibris/library.json', true)).toBe(false);
    expect(servedLibraryPath('Frank Herbert/.hidden', true)).toBe(false);
  });
});
