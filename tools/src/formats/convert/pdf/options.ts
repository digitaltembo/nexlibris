import type { OptionField } from '../../../options';

export type PageSize = 'a5' | '6x9' | 'a4' | 'letter';

/** A PDF's page sizes, in points. */
export const PAGE_SIZES: Record<PageSize, { label: string; width: number; height: number }> = {
  a5: { label: 'A5', width: 419.53, height: 595.28 },
  '6x9': { label: '6 × 9 in', width: 432, height: 648 },
  a4: { label: 'A4', width: 595.28, height: 841.89 },
  letter: { label: 'US Letter', width: 612, height: 792 },
};

export interface PdfOptions {
  pageSize: PageSize;
  pageNumbers: boolean;
  /** The book's title atop each page. */
  bookHeader: boolean;
  /** The chapter's title atop each page. */
  chapterHeader: boolean;
  /** "Chapter 3" opening each chapter, and its number in the headers and bookmarks. */
  chapterNumbers: boolean;
  romanNumerals: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  pageSize: 'a5',
  pageNumbers: true,
  bookHeader: false,
  chapterHeader: true,
  chapterNumbers: false,
  romanNumerals: false,
};

const yesNo = (key: keyof PdfOptions, label: string, help: string): OptionField => ({
  key,
  label,
  default: DEFAULT_PDF_OPTIONS[key] ? 'yes' : 'no',
  kind: 'checkbox',
  help,
});

export const PDF_FIELDS: OptionField[] = [
  {
    key: 'pageSize',
    label: 'Page size',
    default: DEFAULT_PDF_OPTIONS.pageSize,
    choices: Object.entries(PAGE_SIZES).map(([value, { label }]) => ({ value, label })),
    help: 'A5 and 6 × 9 in read well on tablets and print as paperbacks; A4 and Letter print on office paper.',
  },
  yesNo('pageNumbers', 'Include page numbers', 'At the foot of each page but the cover.'),
  yesNo('bookHeader', 'Include book page header', 'The book’s title at the top of each page.'),
  yesNo('chapterHeader', 'Include chapter page header', 'The chapter’s title at the top of each page. Pages opening a chapter have no header.'),
  yesNo('chapterNumbers', 'Include chapter numbers', 'Numbers the chapters, leaving out front and back matter and chapters already numbered.'),
  yesNo('romanNumerals', 'Chapter numbers as roman numerals', 'Chapter IV rather than Chapter 4, where chapters are numbered.'),
];

/** Options from the convert dialog's values (`PDF_FIELDS`), with the defaults for any missing or unknown. */
export function pdfOptionsFrom(values: Record<string, string>): PdfOptions {
  const d = DEFAULT_PDF_OPTIONS;
  const flag = (key: keyof PdfOptions) => (values[key] === 'yes' ? true : values[key] === 'no' ? false : (d[key] as boolean));
  return {
    pageSize: values.pageSize && values.pageSize in PAGE_SIZES ? (values.pageSize as PageSize) : d.pageSize,
    pageNumbers: flag('pageNumbers'),
    bookHeader: flag('bookHeader'),
    chapterHeader: flag('chapterHeader'),
    chapterNumbers: flag('chapterNumbers'),
    romanNumerals: flag('romanNumerals'),
  };
}

/** The writer's own version: bump it when its output changes. */
const PDF_WRITER_VERSION = '1';

/** The converter version for these options, the plain version for the defaults, so copies made with other options are made again. */
export function pdfVersion(options: PdfOptions): string {
  const d = DEFAULT_PDF_OPTIONS;
  const flags = (['pageNumbers', 'bookHeader', 'chapterHeader', 'chapterNumbers', 'romanNumerals'] as const)
    .filter((key) => options[key] !== d[key])
    .map((key) => `${options[key] ? '' : 'no-'}${key}`);
  return [PDF_WRITER_VERSION, options.pageSize !== d.pageSize && options.pageSize, ...flags].filter(Boolean).join('+');
}

/** A number in Roman numerals (to 3999; beyond, as it is). */
export function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const numerals: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [value, numeral] of numerals) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}
