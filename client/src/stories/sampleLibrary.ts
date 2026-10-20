import {
  createCategory,
  createDevice,
  createItem,
  hashBlob,
  LOCAL_USER,
  MemoryStorage,
  StoredLibraryBackend,
  type FileRef,
  type Item,
  type LibraryBackend,
  type Operation,
} from '@nexlibris/common';
import { EXTRACTOR_VERSION, type TextDoc } from '../fulltext/extract';
import { wordList } from '../fulltext/match';

/**
 * A small library for Storybook: a few books with covers, tags, series, ratings and files, and a
 * device. Stories that take items as props use `sampleItems`; the preview wraps every story in a
 * `LibraryProvider` over `openSampleLibrary`, a fresh in-memory copy each time, so components that
 * read or edit the library work and nothing is stored.
 */

/** A plain SVG cover: the title on a colored panel. */
function coverSvg(title: string, background: string, ink: string): Blob {
  const lines = title.split(' ').reduce<string[]>((acc, word) => {
    const last = acc.at(-1);
    if (last && (last + ' ' + word).length <= 12) acc[acc.length - 1] = `${last} ${word}`;
    else acc.push(word);
    return acc;
  }, []);
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = lines
    .map((line, i) => `<text x="100" y="${110 + i * 34}" text-anchor="middle">${escape(line)}</text>`)
    .join('');
  return new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${background}"/>` +
        `<rect x="12" y="12" width="176" height="276" fill="none" stroke="${ink}" stroke-width="2"/>` +
        `<g fill="${ink}" font-family="Georgia, serif" font-size="26">${text}</g></svg>`,
    ],
    { type: 'image/svg+xml' },
  );
}

const file = (name: string, format: string, size: number): FileRef => ({
  // Not stored: enough for the file lists, not for opening.
  hash: Array.from(name, (c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64),
  format,
  size,
  name,
});

const books = [
  {
    title: 'Dune',
    creators: [{ name: 'Frank Herbert', role: 'aut' }],
    tags: ['Science Fiction', 'Classic'],
    metadata: {
      series: 'Dune',
      seriesIndex: 1,
      publisher: 'Ace',
      published: '2005-08-02',
      originallyPublished: '1965-08-01',
      authorSort: 'Herbert, Frank',
      coverColor: '#c47a2c',
    },
    identifiers: { isbn: '9780441013593' },
    files: [file('Dune.epub', 'epub', 1_240_000), file('Dune.x4.epub', 'x4.epub', 980_000)],
    rating: 5,
    colors: ['#c8692c', '#fdf2dc'],
  },
  {
    title: 'The Left Hand of Darkness',
    creators: [{ name: 'Ursula K. Le Guin', role: 'aut' }],
    tags: ['Science Fiction'],
    metadata: { series: 'Hainish Cycle', seriesIndex: 4 },
    files: [file('The Left Hand of Darkness.epub', 'epub', 610_000)],
    rating: 4,
    colors: ['#24365c', '#e8eefc'],
  },
  {
    title: 'Piranesi',
    creators: [{ name: 'Susanna Clarke', role: 'aut' }],
    tags: ['Fantasy'],
    files: [file('Piranesi.epub', 'epub', 420_000)],
    colors: ['#6b4a2b', '#f6e7cf'],
  },
  {
    title: 'Emma',
    creators: [{ name: 'Jane Austen', role: 'aut' }],
    tags: ['Classic', 'Romance'],
    metadata: {
      description: '<p>Emma Woodhouse, handsome, clever, and rich, with a comfortable home and happy disposition…</p>',
    },
    files: [file('Emma.epub', 'epub', 890_000), file('Emma.pdf', 'pdf', 2_400_000)],
    rating: 3,
    colors: ['#3f6b4f', '#eef6ee'],
  },
  {
    title: 'A Christmas Carol',
    creators: [{ name: 'Charles Dickens', role: 'aut' }],
    tags: ['Classic'],
    files: [],
  },
] as const;

const covers = await Promise.all(
  books.map(async (book) => {
    if (!('colors' in book)) return undefined;
    const blob = coverSvg(book.title, book.colors[0], book.colors[1]);
    return { blob, cover: { hash: await hashBlob(blob), mediaType: 'image/svg+xml' } };
  }),
);

const ADDED = '2026-09-28T10:00:00.000Z';

export const sampleItems: Item[] = books.map((book, i) =>
  createItem(
    {
      title: book.title,
      creators: [...book.creators],
      tags: [...book.tags],
      metadata: 'metadata' in book ? { ...book.metadata } : {},
      identifiers: 'identifiers' in book ? { ...book.identifiers } : {},
      files: [...book.files],
      ...(covers[i] && { cover: covers[i].cover }),
    },
    ADDED,
  ),
);

export const sampleDevice = createDevice({ name: 'X4', type: 'crosspoint.reader', settings: { model: 'X4', address: 'http://192.168.0.42' } }, ADDED);

/** An OPDS catalog connection, written once, with Piranesi in it. */
export const sampleCatalog = createDevice({ name: 'Shelf', type: 'opds.catalog', settings: { url: 'https://books.example' } }, ADDED);

/** A browse category of the user's own, with two entries. */
export const sampleCategory = createCategory({
  name: 'Moods',
  entries: [
    { label: 'Far away', query: 'tag:"Science Fiction"' },
    { label: 'Old favourites', query: 'tag:Classic' },
  ],
});

/** Made-up text for two books, as if indexed, so searching inside books finds something. */
const sampleText: Record<string, TextDoc> = {
  Dune: {
    kind: 'epub',
    sections: [
      { ref: '/6/4[c1]', labels: [[0, 'Book One']], text: 'The desert wind carried sand across the dunes at dawn.\nNobody crossed the open desert without a stillsuit.' },
      { ref: '/6/6[c2]', labels: [[0, 'Book Two']], text: 'Far out in the deep desert, the old wells were dry, and the spice smelled of cinnamon.' },
    ],
  },
  Emma: {
    kind: 'epub',
    sections: [{ ref: '/6/4[c1]', labels: [[0, 'Chapter 1']], text: 'A long walk across the village ended at the vicarage, where the tea was cold.' }],
  },
};

/** Where the sample sync put Dune on the X4. */
export const SAMPLE_PLACED_PATH = '/Books/Dune - Frank Herbert.epub';

/** A fresh in-memory library holding the sample books, their covers and ratings, and the device. */
export async function openSampleLibrary(): Promise<LibraryBackend> {
  const backend = new StoredLibraryBackend(new MemoryStorage(), 'Sample library');
  const indexed: Record<string, { version: number; chars: number }> = {};
  for (const item of sampleItems) {
    const doc = sampleText[item.title];
    const hash = item.files[0]?.hash;
    if (!doc || !hash) continue;
    await backend.writeLocalState(`fulltext-${hash}`, doc);
    await backend.writeLocalState(`fulltext-${hash}-words`, wordList(doc));
    indexed[hash] = { version: EXTRACTOR_VERSION, chars: doc.sections.reduce((n, s) => n + s.text.length, 0) };
  }
  await backend.writeLocalState('fulltext', { files: indexed });
  for (const cover of covers) if (cover) await backend.putFile(cover.blob);
  const ops: Operation[] = sampleItems.map((item) => ({ type: 'addItem', item }));
  books.forEach((book, i) => {
    if ('rating' in book) ops.push({ type: 'setRating', userId: LOCAL_USER, itemId: sampleItems[i]!.id, rating: book.rating });
  });
  const [dune, leftHand, piranesi] = sampleItems;
  const x4Copy = dune!.files.find((f) => f.format === 'x4.epub')!;
  ops.push(
    { type: 'addDevice', device: sampleDevice },
    { type: 'addDeviceItems', id: sampleDevice.id, itemIds: [dune!.id, leftHand!.id] },
    {
      type: 'recordDeviceSync',
      id: sampleDevice.id,
      placed: { [SAMPLE_PLACED_PATH]: { itemId: dune!.id, hash: x4Copy.hash, size: x4Copy.size } },
      removed: [],
    },
    { type: 'setCategory', category: sampleCategory },
    { type: 'addDevice', device: sampleCatalog },
    { type: 'addDeviceItems', id: sampleCatalog.id, itemIds: [piranesi!.id] },
    {
      type: 'recordDeviceSync',
      id: sampleCatalog.id,
      placed: { 'books/piranesi.epub': { itemId: piranesi!.id, hash: piranesi!.files[0]!.hash, size: piranesi!.files[0]!.size } },
      removed: [],
    },
  );
  await backend.apply(ops);
  return backend;
}
