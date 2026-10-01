import { emptyParsedItem, splitTags, type ParsedItem } from './formats';

/** pdf.js, with its worker configured. Loaded on first use since it's large. */
export async function loadPdfjs() {
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

const COVER_WIDTH = 400;

/** Library metadata from a PDF's document info, with its first page rendered as the cover. */
export async function parsePdf(data: Blob, filename: string): Promise<ParsedItem> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const parsed = emptyParsedItem(filename);
    const info = (await doc.getMetadata()).info as Record<string, unknown>;
    const field = (name: string) => (typeof info[name] === 'string' ? (info[name] as string).trim() : '') || undefined;

    parsed.title = field('Title') ?? parsed.title;
    // "Last, First" is common in PDF authors, so only split on unambiguous separators.
    parsed.creators = (field('Author')?.split(/\s*;\s*|\s+&\s+|\s+and\s+/) ?? [])
      .filter(Boolean)
      .map((name) => ({ name, role: 'aut' }));
    parsed.tags = splitTags([field('Keywords') ?? '']);
    const subject = field('Subject');
    if (subject) parsed.metadata.description = subject;
    parsed.metadata.pages = doc.numPages;

    const cover = await renderFirstPage(doc).catch(() => undefined);
    if (cover) parsed.cover = { data: cover, mediaType: cover.type };
    return parsed;
  } finally {
    void task.destroy();
  }
}

type PdfDocument = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>;

async function renderFirstPage(doc: PdfDocument): Promise<Blob | undefined> {
  const page = await doc.getPage(1);
  const unscaled = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: COVER_WIDTH / unscaled.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.85));
}
