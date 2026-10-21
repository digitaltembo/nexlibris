import { describe, expect, it } from 'vitest';
import { classifyPage, computeStats, mergeSplitLines, repeatedEdges, type LayoutLine } from './layout';
import { pdfTextOptionsFrom, pdfTextVersion } from './options';
import { BookVocabulary, headingLabel, joinLines, normalize, pageBlocks, parseHeading } from './reflow';
import { textLayerLines, type Line, type TextItem } from './textLayer';

/** A line of words at a height on the page, from x0 to x1, its words spread evenly. */
function line(text: string, y: number, x0 = 0.1, x1 = 0.9): Line {
  const words = text.split(' ');
  const step = (x1 - x0) / words.length;
  return { words: words.map((w, i) => ({ text: w, bbox: [x0 + i * step, y, x0 + (i + 1) * step - 0.005, y + 0.02] })) };
}

const PROSE = 'the quick brown fox jumps over the lazy dog and runs into the deep green woods';

/** A page of justified prose, with a head and a page number, and a paragraph starting at `indentAt`. */
function page(n: number, opening?: string[]): Line[] {
  const lines: Line[] = [line(`${n % 2 ? 'THE BOOK' : 'A CHAPTER'}`, 0.05, 0.4, 0.6)];
  let y = opening ? 0.3 : 0.1;
  for (const [i, text] of (opening ?? []).entries()) lines.push(line(text, 0.15 + i * 0.04, 0.4, 0.6));
  for (let i = 0; i < 20; i++, y += 0.03) {
    const indented = i === 8;
    const ends = i === 7 || i === 19;
    lines.push(line(`${PROSE} ${i}`, y, indented ? 0.13 : 0.1, ends ? 0.5 : 0.9));
  }
  lines.push(line(String(n), 0.95, 0.49, 0.51));
  return lines;
}

function analyse(pages: Line[][]) {
  const merged = pages.map((lines) => mergeSplitLines(lines));
  const stats = computeStats(merged.map((lines, i) => [i % 2 ? 'left' : 'right', lines]));
  const repeated = repeatedEdges(merged);
  return merged.map((lines, i) => classifyPage(lines, stats[i % 2 ? 'left' : 'right'], 0, repeated));
}

const kinds = (lines: LayoutLine[]) => lines.map((l) => l.kind);

describe('PDF text layout', () => {
  it('reads runs of text as lines, joining a word split across runs', () => {
    const item = (str: string, x: number, y: number, width: number, size = 10): TextItem => ({ str, width, transform: [size, 0, 0, size, x, y], fontName: 'f' });
    const lines = textLayerLines(
      [item('A small ', 10, 90, 40), item('T', 50, 90, 6, 12), item('ALE', 56, 90, 18, 9), item('second line', 10, 76, 50), item('   ', 60, 76, 60), item('4', 120, 76, 5)],
      { f: { ascent: 0.8, descent: -0.2 } },
      [0, 0, 200, 100],
    );
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([['A', 'small', 'TALE'], ['second', 'line'], ['4']]);
    expect(lines[0]!.words[0]!.bbox[0]).toBeCloseTo(0.05);
    expect(lines[0]!.words[0]!.bbox[1]).toBeCloseTo(0.02);
  });

  it('leaves out running heads and page numbers, and finds chapter openings', () => {
    const layouts = analyse([page(1, ['CHAPTER IV', 'THE STORM']), page(2), page(3), page(4), page(5), page(6)]);
    expect(layouts[0]!.flags).toContain('chapter_start');
    expect(layouts[1]!.flags).not.toContain('chapter_start');
    for (const layout of layouts) {
      expect(kinds(layout.lines)[0]).toBe('running_head');
      expect(kinds(layout.lines).at(-1)).toBe('folio');
    }
    expect(layouts[0]!.lines.filter((l) => l.kind === 'heading').map((l) => l.text)).toEqual(['CHAPTER IV', 'THE STORM']);
  });

  it('makes paragraphs from indents and short lines, across pages too', () => {
    const vocabulary = new BookVocabulary([]);
    const [first, second] = analyse([page(1), page(2), page(3), page(4), page(5), page(6)]).map((layout) => pageBlocks(layout, vocabulary));
    // A short line ends a paragraph, an indented one starts one.
    expect(first!.map((b) => b.tag)).toEqual(['p', 'p']);
    expect(first!.map((b) => b.lines.length)).toEqual([8, 12]);
    expect(first![0]!.text).toBe(`${PROSE} 0 ${PROSE} 1 ${PROSE} 2 ${PROSE} 3 ${PROSE} 4 ${PROSE} 5 ${PROSE} 6 ${PROSE} 7`);
    // The next page's first paragraph may run on from this one: it isn't indented.
    expect(second![0]!.continued).toBe(true);
  });

  it('joins words broken with a hyphen, keeping the book’s compounds', () => {
    const vocabulary = new BookVocabulary(['a well-known face', 'the garden grew']);
    expect(joinLines(['in the gar-', 'den we sat'], vocabulary)).toBe('in the garden we sat');
    expect(joinLines(['a well-', 'known face'], vocabulary)).toBe('a well-known face');
    expect(joinLines(['the Anglo-', 'Saxon kings'], vocabulary)).toBe('the Anglo-Saxon kings');
    expect(joinLines(['he paused—', 'then went on'], vocabulary)).toBe('he paused—then went on');
    expect(normalize('"It\'s fine ," she said -- and left . . .')).toBe('“It’s fine ,” she said—and left …');
    expect(normalize('ﬁne ; then')).toBe('fine; then');
  });

  it('names chapters from their printed headings', () => {
    expect(parseHeading(['CHAPTER IV', 'THE STORM AT SEA'])).toEqual({ section: 'chapter', ordinal: 4, label: 'Chapter IV', title: 'The Storm at Sea' });
    expect(headingLabel(parseHeading(['Chapter 2: Roots']))).toBe('Chapter 2: Roots');
    expect(headingLabel(parseHeading(['PREFACE']))).toBe('Preface');
    expect(headingLabel(parseHeading(['XII']))).toBe('XII');
    expect(headingLabel(parseHeading(['3. Installer calibre']))).toBe('3. Installer calibre');
    expect(headingLabel(parseHeading(['CHAPITRE II', 'LE VILLAGE']))).toBe('Chapitre II: Le Village');
    expect(headingLabel(parseHeading(['The Village']))).toBe('The Village');
  });

  it('keeps its options in its version', () => {
    expect(pdfTextVersion(pdfTextOptionsFrom({}))).toBe('1');
    const options = pdfTextOptionsFrom({ chapters: 'headings', firstPage: 'left', rightLeft: '5', leftRight: '12', leftTop: '99' });
    expect(options.margins).toEqual({ right: { top: 0, bottom: 0, left: 0.05, right: 0 }, left: { top: 0, bottom: 0, left: 0, right: 0.12 } });
    expect(pdfTextVersion(options)).toBe('1+chapters-headings+first-left+right-0-0-5-0+left-0-0-0-12');
  });
});
