import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseEpub } from '@nexlibris/tools/formats/epub';
import { findCropBox, fitSize, flattenPixels, PROFILES } from './image';
import { DEFENSIVE_STYLE, fixOpf, optimizeEpub, stripImgDimensions, unwrapSvgImages } from './optimize';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function sampleEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:abc</dc:identifier><dc:title>Pics</dc:title></metadata>
  <manifest>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml" properties="svg"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`,
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body>
<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/cover.png"/></svg>
<p><img src="images/pic.gif" width="900" height='1200' style="width: 900px; border: 0"/></p></body></html>`,
  );
  zip.file('OEBPS/toc.ncx', `<ncx><head><meta name="dtb:uid" content="old"/></head></ncx>`);
  zip.file('OEBPS/style.css', `body { background: url(images/pic.gif) }`);
  zip.file('OEBPS/images/cover.png', new Uint8Array([1]));
  zip.file('OEBPS/images/pic.gif', new Uint8Array([2]));
  return zip.generateAsync({ type: 'blob' });
}

describe('optimizeEpub', () => {
  it('re-encodes images as JPEG and fixes the markup, OPF and NCX to match', async () => {
    const seen: string[] = [];
    const out = await optimizeEpub(await sampleEpub(), PROFILES.X4, undefined, async (_data, path) => {
      seen.push(path);
      return JPEG;
    });
    expect(seen).toEqual(['OEBPS/images/cover.png', 'OEBPS/images/pic.gif']);

    const zip = await JSZip.loadAsync(await out.arrayBuffer());
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(zip.file('OEBPS/images/cover.png')).toBeNull();
    expect(await zip.file('OEBPS/images/pic.jpg')!.async('uint8array')).toEqual(JPEG);

    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    expect(opf).toContain('<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>');
    expect(opf).toContain('<meta name="cover" content="cover"/></metadata>');

    const chapter = await zip.file('OEBPS/ch1.xhtml')!.async('string');
    // The size fix then drops the unwrapped image's height, as the Python's does.
    expect(chapter).toContain('<img style="max-width:100%;" src="images/cover.jpg" alt="" />');
    expect(chapter).toContain('<img src="images/pic.jpg" style=" border: 0"/>');
    expect(chapter).toContain(`${DEFENSIVE_STYLE}</head>`);
    expect(await zip.file('OEBPS/toc.ncx')!.async('string')).toContain('<meta name="dtb:uid" content="urn:uuid:abc"/>');
    expect(await zip.file('OEBPS/style.css')!.async('string')).toBe('body { background: url(images/pic.jpg) }');

    // Still a readable EPUB, cover and all.
    const parsed = await parseEpub(out);
    expect(parsed.title).toBe('Pics');
    expect(parsed.cover?.mediaType).toBe('image/jpeg');
  });

  it('keeps an image it can’t decode, under the name its references now use', async () => {
    const out = await optimizeEpub(await sampleEpub(), PROFILES.X4, undefined, async () => {
      throw new Error('bad image');
    });
    const zip = await JSZip.loadAsync(await out.arrayBuffer());
    expect(await zip.file('OEBPS/images/pic.jpg')!.async('uint8array')).toEqual(new Uint8Array([2]));
  });
});

describe('markup fixes', () => {
  it('strips image sizes but keeps other styles', () => {
    expect(stripImgDimensions(`<img src="a.jpg" width="10" style="height:5px;max-width:100%"/>`)).toBe(
      `<img src="a.jpg" style="max-width:100%"/>`,
    );
    expect(stripImgDimensions(`<img src="a.jpg" style="width:5px"/><p width="3">`)).toBe(`<img src="a.jpg"/><p width="3">`);
  });

  it('unwraps SVG images and leaves other SVG alone', () => {
    expect(unwrapSvgImages('<svg:svg><svg:image href="a.png"/></svg:svg>')).toBe(
      '<img style="max-width:100%;height:auto" src="a.jpg" alt="" />',
    );
    expect(unwrapSvgImages('<svg><circle r="1"/></svg>')).toBe('<svg><circle r="1"/></svg>');
  });

  it('points an existing cover meta at the cover image', () => {
    const opf = `<package><metadata><meta name="cover" content="wrong"/></metadata><manifest><item id="c" href="cover.jpg" media-type="image/jpeg"/></manifest></package>`;
    expect(fixOpf(opf)).toContain('<meta name="cover" content="c"/>');
  });
});

describe('image helpers', () => {
  const pixels = (width: number, height: number, ink: (x: number, y: number) => boolean) => {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (ink(x, y)) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    return { width, height, data };
  };

  it('fits images to the screen, upscaling only cropped ones', () => {
    expect(fitSize(1600, 1600, PROFILES.X4, false)).toEqual({ width: 480, height: 480 });
    expect(fitSize(300, 400, PROFILES.X4, false)).toEqual({ width: 300, height: 400 });
    expect(fitSize(300, 400, PROFILES.X4, true)).toEqual({ width: 480, height: 640 });
  });

  it('crops white margins with padding, and not when it saves too little', () => {
    const box = findCropBox(pixels(400, 400, (x, y) => x >= 100 && x < 300 && y >= 150 && y < 250));
    expect(box).toEqual({ left: 92, top: 142, right: 308, bottom: 258 });
    expect(findCropBox(pixels(400, 400, (x, y) => x >= 5 && x < 395 && y >= 5 && y < 395))).toBeUndefined();
  });

  it('flattens transparency onto white and converts to luma', () => {
    const p = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]) };
    flattenPixels(p, true);
    expect([...p.data]).toEqual([76, 76, 76, 255, 255, 255, 255, 255]);
  });
});
