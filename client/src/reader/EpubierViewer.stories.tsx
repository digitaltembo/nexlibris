import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import azw3Url from '../../../tools/src/formats/fixtures/sample.azw3?url';
import cbrUrl from '../../../tools/src/formats/fixtures/sample.cbr?url';
import cbzUrl from '../../../tools/src/formats/fixtures/sample.cbz?url';
import EpubierViewer from './EpubierViewer';

/** A small PDF made here: text, grey, and coloured shapes. */
function samplePdf(): Blob {
  const content = [
    'BT /F1 28 Tf 72 720 Td (A Sample Page) Tj ET',
    'BT /F1 14 Tf 72 690 Td (Drawn by pdf.js in epubier, which colours the page by its theme.) Tj ET',
    '0.5 g 72 560 140 80 re f',
    '0.93 0.59 0.29 rg 232 560 140 80 re f',
    '0.05 0.23 0.4 rg 392 560 140 80 re f',
    '0.96 0.83 0.37 rg 72 460 460 60 re f',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: 'application/pdf' });
}

const meta = {
  component: EpubierViewer,
  args: { data: samplePdf(), format: 'pdf', storageKey: 'sample-pdf', onClose: fn() },
  decorators: [(Story) => <div style={{ height: '100vh' }}><Story /></div>],
} satisfies Meta<typeof EpubierViewer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A file fixture, fetched before the story renders. */
const fixture = (url: string) => async () => ({ data: await (await fetch(url)).blob() });

/** A PDF, drawn by pdf.js, with its pages, outline and search. */
export const Pdf: Story = {};

/** A Kindle book (AZW3), turned into an ePub in memory, so it reflows and takes the font and text settings. */
export const Kindle: Story = {
  args: { format: 'azw3', storageKey: 'sample-azw3' },
  loaders: [fixture(azw3Url)],
  render: (args, { loaded }) => <EpubierViewer {...args} data={loaded.data as Blob} />,
};

/** A CBZ comic, its images as pages. */
export const Comic: Story = {
  args: { format: 'cbz', storageKey: 'sample-cbz' },
  loaders: [fixture(cbzUrl)],
  render: (args, { loaded }) => <EpubierViewer {...args} data={loaded.data as Blob} />,
};

/** A CBR comic, read by libarchive in epubier's worker, a page at a time. */
export const ComicRar: Story = {
  args: { format: 'cbr', storageKey: 'sample-cbr' },
  loaders: [fixture(cbrUrl)],
  render: (args, { loaded }) => <EpubierViewer {...args} data={loaded.data as Blob} />,
};
