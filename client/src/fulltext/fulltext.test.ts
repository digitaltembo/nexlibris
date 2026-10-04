import { createItem, MemoryStorage, StoredLibraryBackend, type Item } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { buildEpub } from '../formats/epubBuilder';
import { parseXml } from '../formats/xml';
import { extractText, MAX_BOOK_TEXT, MAX_SECTION_SOURCE, type TextDoc } from './extract';
import { findPassages, locate, parseTextQuery, placeOf, score, wordList } from './match';
import { TextIndex } from './textIndex';

const epub = () =>
  buildEpub({
    title: 'Moby-Dick',
    creators: [{ name: 'Herman Melville', role: 'aut' }],
    chapters: [
      { id: 'c1', title: 'Loomings', body: '<h1>Loomings</h1><p>Call me <em>Ishmael</em>. Some years ago, never mind how long.</p>' },
      {
        id: 'c2',
        title: 'The Carpet-Bag',
        body: '<h1>The Carpet-Bag</h1><p>I stuffed a shirt or two into my old carpet-bag.</p><p>The harpooneer was   <b>Queequeg</b>, who sold heads.</p>',
      },
    ],
  });

const text = (body: string): TextDoc => ({ kind: 'text', sections: [{ ref: '', text: body }] });

describe('extractText', () => {
  it('takes an EPUB’s chapters in spine order, named from its table of contents', async () => {
    const doc = await extractText(await epub(), 'epub');
    expect(doc.kind).toBe('epub');
    expect(doc.sections.map((s) => [placeOf(doc, { section: doc.sections.indexOf(s), offset: 0 }), s.text])).toEqual([
      ['Loomings', 'Loomings\nCall me Ishmael. Some years ago, never mind how long.'],
      ['The Carpet-Bag', 'The Carpet-Bag\nI stuffed a shirt or two into my old carpet-bag.\nThe harpooneer was Queequeg, who sold heads.'],
    ]);
    expect(doc.sections[1]!.ref).toMatch(/^\/6\/4\[[^\]]+\]$/);
  });

  it('names passages by the table of contents’ anchors, for files holding several chapters', async () => {
    const book = await buildEpub({
      title: 'Two in one',
      creators: [],
      chapters: [{ id: 'c1', title: 'Both', body: `<h2 id="one">One</h2><p>First words.</p><p>${'Filler. '.repeat(20)}</p><h2 id="two">Two</h2><p>Second words.</p>` }],
      toc: [
        { label: 'Chapter One', href: 'text/c1.xhtml#one' },
        { label: 'Chapter Two', href: 'text/c1.xhtml#two' },
      ],
    });
    const doc = await extractText(book, 'epub');
    const places = findPassages(doc, parseTextQuery('words'))!.passages.map((p) => placeOf(doc, p));
    expect(places).toEqual(['Chapter One', 'Chapter Two']);
  });

  it('collapses a text file’s whitespace', async () => {
    const doc = await extractText(new Blob(['  Call me\tIshmael.\n\n\nSome  years ago. ']), 'txt');
    expect(doc).toEqual({ kind: 'text', sections: [{ ref: '', text: 'Call me Ishmael.\nSome years ago.' }] });
  });

  it('leaves out a chapter too big to read, and text past the most a book indexes', async () => {
    const book = await buildEpub({
      title: 'A dictionary',
      creators: [],
      chapters: [
        { id: 'c1', title: 'Front matter', body: '<p>How to use this dictionary.</p>' },
        { id: 'c2', title: 'A–Z', body: `<p>${'aardvark '.repeat(MAX_SECTION_SOURCE / 9 + 1)}</p>` },
      ],
    });
    const doc = await extractText(book, 'epub');
    expect(doc.sections.map((s) => s.text)).toEqual(['How to use this dictionary.']);
    expect(doc.truncated).toBe(true);

    const long = await extractText(new Blob(['word '.repeat(MAX_BOOK_TEXT / 5 + 10)]), 'txt');
    expect([long.sections[0]!.text.length, long.truncated]).toEqual([MAX_BOOK_TEXT, true]);
  });

  it('has nothing to say about comics', async () => {
    await expect(extractText(new Blob([]), 'cbz')).rejects.toThrow(/no text/);
  });
});

describe('matching', () => {
  it('parses words and phrases, folding case and accents', () => {
    expect(parseTextQuery('Café "old  Carpet" don’t')).toEqual([['cafe'], ['old', 'carpet'], ['don', 't']]);
    expect(parseTextQuery('  "" , ')).toEqual([]);
  });

  it('rules books in or out by their words alone, with the rarest term’s count', () => {
    const list = wordList(text('the whale the whales a harpoon'));
    expect(list.words).toEqual(['a', 'harpoon', 'the', 'whale', 'whales']);
    expect(score(list, parseTextQuery('whale'))).toBe(2);
    expect(score(list, parseTextQuery('whale harp'))).toBe(1);
    expect(score(list, parseTextQuery('whale ship'))).toBeUndefined();
  });

  it('finds passages, highlighting each match, with the closest together first', () => {
    const body = `Call me Ishmael. ${'Filler words go here. '.repeat(10)}Ishmael met Queequeg at the inn.`;
    const found = findPassages(text(body), parseTextQuery('ishmael queequeg'))!;
    expect(found.total).toBe(3);
    expect(found.passages.map((p) => p.terms)).toEqual([2, 1]);
    const [best] = found.passages;
    expect(best!.highlights.map(([a, b]) => best!.snippet.slice(a, b))).toEqual(['Ishmael', 'Queequeg']);
    expect(best!.snippet.startsWith('…')).toBe(true);
  });

  it('matches phrases in order, and needs every term', () => {
    const doc = text('my old carpet-bag; an old, old carpet');
    expect(findPassages(doc, parseTextQuery('"old carpet"'))!.total).toBe(2);
    expect(findPassages(doc, parseTextQuery('"carpet old"'))).toBeUndefined();
    expect(findPassages(doc, parseTextQuery('carpet whale'))).toBeUndefined();
  });

  it('locates a passage as a page, a fraction, or a CFI epub.js resolves to the match', async () => {
    const pdf: TextDoc = { kind: 'pdf', sections: [{ ref: '7', text: 'whale' }] };
    expect(locate(pdf, { section: 0, offset: 0 })).toBe('7');
    expect(locate(text('0123456789'), { section: 0, offset: 5 })).toBe('0.5000');

    const doc = await extractText(await epub(), 'epub');
    const passage = findPassages(doc, parseTextQuery('queequeg'))!.passages[0]!;
    const cfi = locate(doc, passage);
    expect(cfi).toMatch(/^epubcfi\(\/6\/4\[[^\]]+\]!\/4\/6\/2\/1:0\)$/);

    // epub.js, as epubier opens it, finds the word there.
    // oxlint-disable-next-line typescript/ban-ts-comment -- epub.js's source has no types
    // @ts-ignore
    const { default: EpubCFI } = await import('../../../../epubierjs/node_modules/epubjs/src/epubcfi.js');
    const zip = await (await import('jszip')).default.loadAsync(await (await epub()).arrayBuffer());
    const chapter = parseXml(await zip.file('OEBPS/text/c2.xhtml')!.async('string'))!;
    const range = new EpubCFI(cfi).toRange(chapter);
    expect(range.startContainer.textContent.slice(range.startOffset)).toMatch(/^Queequeg/);
  });
});

describe('TextIndex', () => {
  it('finds the books with every term, the most mentions of the rarest first, and forgets books removed', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const items: Item[] = [];
    for (const [title, text] of [
      ['Moby-Dick', 'The whale. The whale again. A harpoon.'],
      ['Jaws', 'A shark, then a whale, then a harpoon, then another harpoon.'],
      ['Walden', 'Woods and a pond.'],
    ]) {
      const { hash, size } = await backend.putFile(new Blob([text!]));
      items.push(createItem({ title: title!, files: [{ hash, size, format: 'txt' }] }));
    }
    const index = new TextIndex(backend);
    for (const { file } of await index.pending(items)) await index.add(file);
    expect(await index.pending(items)).toEqual([]);

    const found = await index.candidates(items, parseTextQuery('whale harpoon'));
    // One mention of "whale" in Jaws and one "harpoon" in Moby-Dick: a tie, by title.
    expect(found.map((r) => [r.item.title, r.score])).toEqual([
      ['Jaws', 1],
      ['Moby-Dick', 1],
    ]);
    expect((await index.candidates(items, parseTextQuery('harpoon'))).map((r) => r.item.title)).toEqual(['Jaws', 'Moby-Dick']);

    await index.prune(items.slice(1));
    expect(await backend.readLocalState(`fulltext-${items[0]!.files[0]!.hash}`)).toBeNull();
    expect((await index.candidates(items.slice(1), parseTextQuery('harpoon'))).map((r) => r.item.title)).toEqual(['Jaws']);
  });
});
