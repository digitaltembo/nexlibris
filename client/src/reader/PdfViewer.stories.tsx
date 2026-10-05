import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import PdfViewer from './PdfViewer';

/** A small PDF made here: text, grey, and coloured shapes, to show how pages take the theme's colours. */
function samplePdf(): Blob {
  const content = [
    'BT /F1 28 Tf 72 720 Td (A Page in the Theme) Tj ET',
    'BT /F1 14 Tf 72 690 Td (Paper takes the surface colour, ink the text colour.) Tj ET',
    'BT /F1 14 Tf 72 670 Td (Colours keep roughly their hue; the dark scheme inverts the page first.) Tj ET',
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
  component: PdfViewer,
  args: { data: samplePdf(), format: 'pdf', storageKey: 'sample', onClose: fn(), options: { forcePdfjs: true } },
  decorators: [(Story) => <div style={{ height: '100vh', overflow: 'auto', background: 'var(--bg)' }}><Story /></div>],
} satisfies Meta<typeof PdfViewer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** pdf.js's rendering, as on Android, in the theme's colours (switch the colour scheme to see the dark one). */
export const Themed: Story = {};
