import { describe, expect, it } from 'vitest';
import { opdsItem } from './asItem';
import { parseOpdsFeed } from './opdsFeed';

/** An entry as calibre3opds (and so nexlibris's export) writes it, calibre's namespace under another prefix. */
const ENTRY = `<?xml version='1.0' encoding='utf-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:ns2="http://calibre-ebook.com">
<title>Poirot</title>
<entry>
<id>urn:uuid:5d3f2a8e-0000-4000-8000-000000000920</id>
<title>The Mysterious Affair at Styles</title>
<updated>2026-09-04T02:59:49+00:00</updated>
<author><name>Agatha Christie</name></author>
<summary type="html">&lt;p&gt;Poirot’s first case.&lt;/p&gt;</summary>
<category>Mystery</category>
<category term="poirot" label="Poirot"/>
<ns2:series>Poirot</ns2:series>
<ns2:series_index>1.0</ns2:series_index>
<dc:language>eng</dc:language>
<dc:publisher>Standard Ebooks</dc:publisher>
<dc:issued>1920-10</dc:issued>
<dc:identifier>urn:isbn:0-00-712082-6</dc:identifier>
<link rel="http://opds-spec.org/acquisition" href="/books/styles.x4.epub" type="application/epub+zip" />
<link rel="http://opds-spec.org/acquisition" href="/books/styles.epub" type="application/epub+zip" length="250000" />
<link rel="http://opds-spec.org/image" href="/covers/920.jpg" type="image/jpeg" />
</entry>
</feed>`;

describe('a catalog’s books as the library shows them', () => {
  const feed = parseOpdsFeed(ENTRY, 'https://library.example/navigation/series/poirot/page-1.xml');
  const book = feed.entries[0]!;

  it('reads what calibre’s and nexlibris’s catalogs say of a book', () => {
    expect(book).toMatchObject({
      kind: 'book',
      tags: ['Mystery', 'Poirot'],
      series: 'Poirot',
      seriesIndex: 1,
      publisher: 'Standard Ebooks',
      language: 'eng',
      published: '1920-10',
      updated: '2026-09-04T02:59:49+00:00',
    });
    // The plain EPUB first; the copy made for the X4 kept as that.
    expect(book.kind === 'book' && book.downloads.map((d) => d.format)).toEqual(['epub', 'x4.epub']);
  });

  it('fills in an item: authors, identifiers, metadata, and the downloads as files', () => {
    if (book.kind !== 'book') throw new Error('not a book');
    const item = opdsItem('library', book, '2026-10-08T00:00:00.000Z');
    expect(item).toMatchObject({
      id: 'opds:library:urn:uuid:5d3f2a8e-0000-4000-8000-000000000920',
      title: 'The Mysterious Affair at Styles',
      creators: [{ name: 'Agatha Christie', role: 'aut' }],
      identifiers: { isbn: '9780007120826', uuid: '5d3f2a8e-0000-4000-8000-000000000920' },
      tags: ['Mystery', 'Poirot'],
      metadata: {
        description: '<p>Poirot’s first case.</p>',
        series: 'Poirot',
        seriesIndex: 1,
        publisher: 'Standard Ebooks',
        language: 'eng',
        published: '1920-10',
      },
      addedAt: '2026-09-04T02:59:49.000Z',
    });
    expect(item.files.map(({ format, size }) => ({ format, size }))).toEqual([
      { format: 'epub', size: 250000 },
      { format: 'x4.epub', size: 0 },
    ]);
    expect(item.cover).toBeUndefined();
  });
});
