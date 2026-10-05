import { loadPdfjs } from '../formats/pdf';
import { loadRtfjs } from '../formats/text';
import { collapse, MAX_BOOK_TEXT, pause, textDoc, type TextDoc, type TextSection } from './extract';

/** Text from formats read in the page: PDFs through pdf.js (which runs its own worker), RTF through rtf.js (which renders to the DOM). */

export async function extractPdf(data: Blob): Promise<TextDoc> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const sections: TextSection[] = [];
    let total = 0;
    for (let page = 1; page <= doc.numPages; page++) {
      if (total >= MAX_BOOK_TEXT) return { kind: 'pdf', sections, truncated: true };
      const content = await (await doc.getPage(page)).getTextContent();
      let raw = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        raw += item.str + (item.hasEOL ? '\n' : '');
      }
      const text = collapse(raw.replace(/-\n(?=\p{Ll})/gu, ''));
      if (text) sections.push({ ref: String(page), label: `Page ${page}`, text });
      total += text.length;
      if (page % 10 === 0) await pause();
    }
    return { kind: 'pdf', sections };
  } finally {
    void task.destroy();
  }
}

export async function extractRtf(data: Blob): Promise<TextDoc> {
  const RTFJS = await loadRtfjs();
  const elements = await new RTFJS.Document(await data.arrayBuffer(), {}).render();
  return textDoc(collapse(elements.map((el) => el.textContent ?? '').join('\n')));
}
