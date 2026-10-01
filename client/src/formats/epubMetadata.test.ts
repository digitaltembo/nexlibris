import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildEpub } from './epubBuilder';
import { parseEpub } from './epub';
import { writeEpubMetadata } from './epubMetadata';

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
});
