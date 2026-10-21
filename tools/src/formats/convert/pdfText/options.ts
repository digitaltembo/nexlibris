import type { OptionField } from '../../../options';
import type { Side } from './layout';

export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PdfTextOptions {
  /** Which side the PDF's first page is: right-hand (recto, as a book's first page) or left-hand. */
  firstPage: Side;
  /** Margins whose text is ignored (scanners' edges, notes, watermarks), as shares of the page, by side. */
  margins: Record<Side, Margins>;
  /** Where chapters come from: the PDF's bookmarks where it has them, else its chapter openings; the openings alone; or none. */
  chapters: 'auto' | 'headings' | 'none';
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const;
const none = (): Margins => ({ top: 0, bottom: 0, left: 0, right: 0 });

export const DEFAULT_PDF_TEXT_OPTIONS: PdfTextOptions = { firstPage: 'right', margins: { right: none(), left: none() }, chapters: 'auto' };

const marginField = (side: Side, edge: (typeof SIDES)[number]): OptionField => ({
  key: `${side}${edge[0]!.toUpperCase()}${edge.slice(1)}`,
  label: `${side === 'right' ? 'Right' : 'Left'}-hand pages: ${edge} margin to ignore (%)`,
  default: '0',
  range: { min: 0, max: 45 },
  ...(side === 'right' && edge === 'top' && { help: 'Text this close to the edge, as a share of the page, is left out: a scanner’s edges, notes, a library’s stamp. Page numbers and running heads are found and left out anyway.' }),
});

export const PDF_TEXT_FIELDS: OptionField[] = [
  {
    key: 'chapters',
    label: 'Chapters',
    default: 'auto',
    choices: [
      { value: 'auto', label: 'From the PDF’s bookmarks, else its chapter openings' },
      { value: 'headings', label: 'From chapter openings' },
      { value: 'none', label: 'None: one long chapter' },
    ],
    help: 'A chapter opening is a heading over text set lower on its page than the rest.',
  },
  {
    key: 'firstPage',
    label: 'First page',
    default: 'right',
    choices: [
      { value: 'right', label: 'Right-hand page' },
      { value: 'left', label: 'Left-hand page' },
    ],
    help: 'Which side of an open book the PDF’s first page is, so each page gets its side’s margins.',
  },
  ...(['right', 'left'] as const).flatMap((side) => SIDES.map((edge) => marginField(side, edge))),
];

/** Options from the convert dialog's values, with the defaults for any missing or out of range. */
export function pdfTextOptionsFrom(values: Record<string, string>): PdfTextOptions {
  const d = DEFAULT_PDF_TEXT_OPTIONS;
  const percent = (key: string) => {
    const n = Number(values[key]);
    return Number.isFinite(n) && n >= 0 && n <= 45 ? n / 100 : 0;
  };
  const margins = (side: Side): Margins => Object.fromEntries(SIDES.map((edge) => [edge, percent(`${side}${edge[0]!.toUpperCase()}${edge.slice(1)}`)])) as unknown as Margins;
  return {
    firstPage: values.firstPage === 'left' ? 'left' : d.firstPage,
    margins: { right: margins('right'), left: margins('left') },
    chapters: values.chapters === 'headings' || values.chapters === 'none' ? values.chapters : d.chapters,
  };
}

/** The reader's own version: bump it when its output changes. */
const PDF_TEXT_VERSION = '1';

/** The converter version for these options, the plain version for the defaults. */
export function pdfTextVersion(options: PdfTextOptions): string {
  const parts: string[] = [];
  if (options.chapters !== 'auto') parts.push(`chapters-${options.chapters}`);
  if (options.firstPage !== 'right') parts.push('first-left');
  for (const side of ['right', 'left'] as const) {
    const m = options.margins[side];
    if (SIDES.some((edge) => m[edge])) parts.push(`${side}-${SIDES.map((edge) => Math.round(m[edge] * 100)).join('-')}`);
  }
  return [PDF_TEXT_VERSION, ...parts].join('+');
}
