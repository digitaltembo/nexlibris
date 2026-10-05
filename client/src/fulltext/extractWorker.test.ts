// @vitest-environment node
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractText } from './extract';
import { locate } from './match';

/** A hand-made EPUB, so nothing here needs a DOM: `node` has none, as a worker hasn't. */
async function epub(chapter: string) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version='1.0'?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file(
    'OEBPS/content.opf',
    `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
      <metadata><dc:title>T</dc:title></metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="Text/c%201.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/></spine>
    </package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ops="http://www.idpf.org/2007/ops"><body>
      <nav ops:type="landmarks"><ol><li><a href="Text/c%201.xhtml">Start</a></li></ol></nav>
      <nav ops:type="toc"><ol><li><a href="Text/c%201.xhtml#two">Second &amp; last</a></li></ol></nav>
    </body></html>`,
  );
  zip.file('OEBPS/Text/c 1.xhtml', chapter);
  return zip.generateAsync({ type: 'blob' });
}

describe('extractText without a DOM', () => {
  it('reads XHTML with HTML entities, skips scripts and styles, and keeps CFI paths', async () => {
    const doc = await extractText(
      await epub(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Head</title><style>p { color: red }</style></head>
<body><p>Caf&eacute;&nbsp;au&#160;lait &amp; <i>more</i></p><script>ignored()</script>
<h2 id="two">Two</h2><p><![CDATA[raw]]>Done.</p></body></html>`),
      'epub',
    );
    const section = doc.sections[0]!;
    expect(section.text).toBe('Café au lait & more\nTwo\nDone.');
    expect(section.labels).toEqual([[20, 'Second & last']]);
    // body is the html's second element (/4); in it p, script, h2, p are /2, /4, /6, /8; "more" is in the first p's i.
    expect(locate(doc, { section: 0, offset: section.text.indexOf('more') })).toBe('epubcfi(/6/2[c1]!/4/2/2/1:0)');
    expect(locate(doc, { section: 0, offset: section.text.indexOf('Done') })).toBe('epubcfi(/6/2[c1]!/4/8/1:0)');
  });

  it('reads malformed markup as best it can', async () => {
    const doc = await extractText(await epub('<html><body><p>Unclosed <b>bold<p>Next</body></html>'), 'epub');
    expect(doc.sections[0]!.text).toContain('Unclosed bold');
    expect(doc.sections[0]!.text).toContain('Next');
  });
});
