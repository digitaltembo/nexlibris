import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildEpub } from './epubBuilder';
import { parseEpub } from './epub';
import { epubMetadataChanges, writeEpubMetadata } from './epubMetadata';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function epub2(): Promise<Blob> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    'content.opf',
    `<?xml version='1.0' encoding='utf-8'?>
    <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>Old Title</dc:title>
        <dc:creator opf:role="aut" opf:file-as="Writer, Old">Old Writer</dc:creator>
        <dc:identifier id="uid" opf:scheme="uuid">1234-abcd</dc:identifier>
        <dc:language>en</dc:language>
        <dc:subject>Old tag</dc:subject>
        <meta name="calibre:series" content="Old Series"/>
        <meta name="cover" content="cover-img"/>
      </metadata>
      <manifest><item id="cover-img" href="cover.png" media-type="image/png"/></manifest>
    </package>`,
  );
  zip.file('cover.png', PNG);
  return zip.generateAsync({ type: 'blob' });
}

describe('writeEpubMetadata', () => {
  it('replaces an EPUB 2 book’s metadata, keeping its identifiers and cover', async () => {
    const out = await writeEpubMetadata(await epub2(), {
      title: 'New Title',
      creators: [{ name: 'New Writer', role: 'aut' }, { name: 'A. Translator', role: 'trl' }],
      tags: ['Fiction'],
      series: 'New Series',
      seriesIndex: 2,
      description: 'A <b>bold</b> & new description',
    });
    const parsed = await parseEpub(out);
    expect(parsed).toMatchObject({
      title: 'New Title',
      creators: [{ name: 'New Writer', role: 'aut' }, { name: 'A. Translator', role: 'trl' }],
      identifiers: { uuid: '1234-abcd' },
      tags: ['Fiction'],
      metadata: { language: 'en', series: 'New Series', seriesIndex: 2, description: 'A <b>bold</b> & new description' },
    });
    expect(new Uint8Array(await parsed.cover!.data.arrayBuffer())).toEqual(PNG);

    const zip = await JSZip.loadAsync(await out.arrayBuffer());
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zip.file('content.opf')!.async('string')).not.toContain('Old');
  });

  it('writes EPUB 3 roles and series as refinements', async () => {
    const original = await buildEpub({
      title: 'Before',
      creators: [{ name: 'Someone', role: 'aut' }],
      series: 'Before Series',
      seriesIndex: 1,
      chapters: [{ id: 'c1', title: 'One', body: '<p>Hi</p>' }],
    });
    const parsed = await parseEpub(
      await writeEpubMetadata(original, { title: 'After', creators: [{ name: 'Editor', role: 'edt' }], series: 'After Series', seriesIndex: 3 }),
    );
    expect(parsed).toMatchObject({
      title: 'After',
      creators: [{ name: 'Editor', role: 'edt' }],
      metadata: { series: 'After Series', seriesIndex: 3 },
    });
  });

  it('leaves what the library lacks as the file has it, and writes sort names', async () => {
    const zip = await JSZip.loadAsync(await (await epub2()).arrayBuffer());
    const opf = (await zip.file('content.opf')!.async('string')).replace(
      '<dc:language>en</dc:language>',
      `<dc:language>en</dc:language><dc:description>From the file</dc:description><dc:publisher>Ace</dc:publisher>
       <dc:date opf:event="original-publication">1965</dc:date><dc:date>1990-09-01</dc:date>
       <meta name="calibre:title_sort" content="Old Title, The"/>`,
    );
    zip.file('content.opf', opf);
    const original = await zip.generateAsync({ type: 'blob' });

    const book = {
      title: 'New Title',
      creators: [{ name: 'Ann Writer', role: 'aut' }, { name: 'Bo Writer', role: 'aut' }, { name: 'Ed Itor', role: 'edt' }],
      published: '2001-05',
      titleSort: 'New Title',
      authorSort: 'Writer, Ann & Writer, Bo',
    };
    const parsed = await parseEpub(await writeEpubMetadata(original, book));
    expect(parsed).toMatchObject({
      title: 'New Title',
      // No tags in the library: the file's are kept, as are its description and publisher.
      tags: ['Old tag'],
      metadata: {
        description: 'From the file',
        publisher: 'Ace',
        series: 'Old Series',
        published: '2001-05',
        originallyPublished: '1965',
        titleSort: 'New Title',
        authorSort: 'Writer, Ann & Writer, Bo',
      },
    });
    expect(epubMetadataChanges(parsed, book)).toEqual([]);

    // A new title without a sort title of its own drops the file's old one.
    const retitled = await parseEpub(await writeEpubMetadata(original, { title: 'Other', creators: [] }));
    expect(retitled.metadata.titleSort).toBeUndefined();
    expect(retitled.creators).toEqual([{ name: 'Old Writer', role: 'aut' }]);
  });

  it('writes a non-breaking space as XML can read it, and the language as EPUB wants it', async () => {
    const book = { title: 'Dune', creators: [], description: 'One\u00a0two', language: 'fra' };
    const parsed = await parseEpub(await writeEpubMetadata(await epub2(), book));
    expect(parsed.metadata).toMatchObject({ description: 'One\u00a0two', language: 'fr' });
    expect(epubMetadataChanges(parsed, book)).toEqual([]);
    // The file's `en` is already the library's `eng`, and stays.
    const english = await parseEpub(await writeEpubMetadata(await epub2(), { ...book, language: 'eng' }));
    expect(english.metadata.language).toBe('en');
  });
});

describe('writeEpubMetadata with a cover', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const book = { title: 'Dune', creators: [] };
  const bytes = async (blob: Blob | undefined) => [...new Uint8Array(await blob!.arrayBuffer())];
  const files = async (blob: Blob) => Object.keys((await JSZip.loadAsync(await blob.arrayBuffer())).files).sort();
  const text = async (blob: Blob, path: string) => (await JSZip.loadAsync(await blob.arrayBuffer())).file(path)!.async('string');

  it('replaces a cover of the same type in place', async () => {
    const out = await writeEpubMetadata(await epub2(), book, { data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])]), mediaType: 'image/png' });
    const parsed = await parseEpub(out);
    expect(await bytes(parsed.cover?.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 1]);
    expect(await files(out)).toEqual(['META-INF/', 'META-INF/container.xml', 'content.opf', 'cover.png', 'mimetype']);
  });

  it('renames a cover of another type, and the pages naming it', async () => {
    const zip = await JSZip.loadAsync(await (await epub2()).arrayBuffer());
    zip.file('titlepage.xhtml', '<html><body><img src="cover.png"/></body></html>');
    const out = await writeEpubMetadata(await zip.generateAsync({ type: 'blob' }), book, { data: new Blob([JPEG]), mediaType: 'image/jpeg' });
    const parsed = await parseEpub(out);
    expect(parsed.cover?.mediaType).toBe('image/jpeg');
    expect(await bytes(parsed.cover?.data)).toEqual([...JPEG]);
    expect(await files(out)).toContain('cover.jpg');
    expect(await files(out)).not.toContain('cover.png');
    expect(await text(out, 'titlepage.xhtml')).toContain('src="cover.jpg"');
  });

  it('adds one, marked both ways, to a book without', async () => {
    const plain = await buildEpub({ title: 'Dune', creators: [], chapters: [{ id: 'c1', title: 'One', body: '<p>Hi</p>' }] });
    expect((await parseEpub(plain)).cover).toBeUndefined();
    const out = await writeEpubMetadata(plain, book, { data: new Blob([JPEG]), mediaType: 'image/jpeg' });
    expect(await bytes((await parseEpub(out)).cover?.data)).toEqual([...JPEG]);
    const opf = await text(out, 'OEBPS/content.opf');
    expect(opf).toMatch(/<item id="nexlibris-cover" href="cover.jpg" media-type="image\/jpeg" properties="cover-image"\/>/);
    expect(opf).toContain('<meta name="cover" content="nexlibris-cover"/>');
  });
});

describe('epubMetadataChanges', () => {
  const file = { title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }], identifiers: {}, tags: ['SF', 'Classic'], metadata: { series: 'Dune', seriesIndex: 1 } };

  it('names the fields the library has that the file says otherwise', () => {
    expect(epubMetadataChanges(file, { title: 'Dune', creators: file.creators, tags: ['Classic', 'SF'], series: 'Dune', seriesIndex: 1 })).toEqual([]);
    expect(
      epubMetadataChanges(file, {
        title: 'Dune ',
        creators: [{ name: 'Frank Herbert', role: 'aut' }, { name: 'Someone', role: 'trl' }],
        tags: ['SF', 'Classic', '1960s'],
        series: 'Dune Chronicles',
        seriesIndex: 1,
        publisher: 'Ace',
        published: '-0570',
      }),
    ).toEqual(['creators', 'tags', 'publisher', 'series']);
  });

  it('takes a language in another form, or with a region, as the same', () => {
    const english = { ...file, metadata: { ...file.metadata, language: 'en-US' } };
    expect(epubMetadataChanges(english, { title: 'Dune', creators: [], language: 'eng' })).toEqual([]);
    expect(epubMetadataChanges(english, { title: 'Dune', creators: [], language: 'fra' })).toEqual(['language']);
  });

  it('ignores what the library lacks', () => {
    expect(epubMetadataChanges(file, { title: 'Dune', creators: [], tags: [] })).toEqual([]);
  });
});
