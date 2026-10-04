import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { EpubError, parseEpub } from './epub';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

async function buildEpub(opf: string, extra: Record<string, string | Uint8Array> = {}): Promise<Blob> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/content.opf', opf);
  for (const [path, data] of Object.entries(extra)) zip.file(path, data);
  return zip.generateAsync({ type: 'blob' });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('parseEpub', () => {
  it('reads Calibre-style EPUB 2 metadata', async () => {
    const epub = await buildEpub(
      `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
          <dc:title>The Left Hand of Darkness</dc:title>
          <dc:creator opf:role="aut" opf:file-as="Le Guin, Ursula K.">Ursula K. Le Guin</dc:creator>
          <dc:contributor opf:file-as="calibre" opf:role="bkp">calibre (5.0)</dc:contributor>
          <dc:date>2010-05-11T22:00:00+00:00</dc:date>
          <dc:date opf:event="original-publication">1969</dc:date>
          <dc:rights>All rights reserved</dc:rights>
          <dc:identifier opf:scheme="ISBN">978-0-441-47812-5</dc:identifier>
          <dc:identifier opf:scheme="calibre">42</dc:identifier>
          <dc:identifier>urn:uuid:1234-abcd</dc:identifier>
          <dc:language>en</dc:language>
          <dc:subject>Science Fiction</dc:subject>
          <dc:subject>science fiction, Anthropology; Classics</dc:subject>
          <meta name="calibre:series" content="Hainish Cycle"/>
          <meta name="calibre:series_index" content="4.0"/>
          <meta name="calibre:title_sort" content="Left Hand of Darkness, The"/>
          <meta name="cover" content="cover-img"/>
        </metadata>
        <manifest>
          <item id="cover-img" href="images/front%20cover.png" media-type="image/png"/>
        </manifest>
      </package>`,
      { 'OEBPS/images/front cover.png': PNG },
    );

    const parsed = await parseEpub(epub);
    expect(parsed).toMatchObject({
      title: 'The Left Hand of Darkness',
      creators: [{ name: 'Ursula K. Le Guin', role: 'aut' }],
      identifiers: { isbn: '9780441478125', uuid: '1234-abcd' },
      tags: ['Science Fiction', 'Anthropology', 'Classics'],
      metadata: {
        language: 'en',
        series: 'Hainish Cycle',
        seriesIndex: 4,
        titleSort: 'Left Hand of Darkness, The',
        authorSort: 'Le Guin, Ursula K.',
        published: '2010-05-12',
        originallyPublished: '1969',
        rights: 'All rights reserved',
      },
    });
    expect(parsed.cover?.mediaType).toBe('image/png');
    expect(new Uint8Array(await parsed.cover!.data.arrayBuffer())).toEqual(PNG);
  });

  it('reads EPUB 3 refinements and cover-image properties', async () => {
    const epub = await buildEpub(
      `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title id="sub">A Subtitle</dc:title>
          <dc:title id="main">Piranesi</dc:title>
          <meta refines="#main" property="title-type">main</meta>
          <meta refines="#sub" property="title-type">subtitle</meta>
          <meta refines="#main" property="file-as">Piranesi</meta>
          <dc:creator id="c1">Susanna Clarke</dc:creator>
          <meta refines="#c1" property="file-as">Clarke, Susanna</meta>
          <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
          <dc:creator id="c2">Some Translator</dc:creator>
          <meta refines="#c2" property="role" scheme="marc:relators">trl</meta>
          <dc:identifier>urn:isbn:9781635575637</dc:identifier>
          <meta property="belongs-to-collection" id="coll">Standalones</meta>
          <meta refines="#coll" property="collection-type">series</meta>
          <meta refines="#coll" property="group-position">2</meta>
        </metadata>
        <manifest>
          <item id="c" href="../cover.png" media-type="image/png" properties="cover-image"/>
        </manifest>
      </package>`,
      { 'cover.png': PNG },
    );

    const parsed = await parseEpub(epub);
    expect(parsed.title).toBe('Piranesi');
    expect(parsed.creators).toEqual([
      { name: 'Susanna Clarke', role: 'aut' },
      { name: 'Some Translator', role: 'trl' },
    ]);
    expect(parsed.identifiers).toEqual({ isbn: '9781635575637' });
    // The translator has no sort name, but only authors make the author sort.
    expect(parsed.metadata).toMatchObject({ series: 'Standalones', seriesIndex: 2, subtitle: 'A Subtitle', titleSort: 'Piranesi', authorSort: 'Clarke, Susanna' });
    expect(parsed.cover?.mediaType).toBe('image/png');
  });

  it('falls back to the filename for a missing title', async () => {
    const epub = await buildEpub(
      `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"/></package>`,
    );
    expect((await parseEpub(epub, 'Mystery Book.epub')).title).toBe('Mystery Book');
  });

  it('rejects files that are not EPUBs', async () => {
    await expect(parseEpub(new Blob(['not a zip']))).rejects.toThrow(EpubError);
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(parseEpub(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow(EpubError);
  });
});
