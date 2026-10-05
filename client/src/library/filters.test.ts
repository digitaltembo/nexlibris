import { createItem, type Item } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { describeRule, filterFields, filtersQuery, parseFilters, type Filters } from './filters';
import { filterItems, formatQuery, parseQuery } from './search';

const item = (title: string, extra: Partial<Item> = {}, addedAt = '2026-09-20T00:00:00Z'): Item => ({
  ...createItem({ title, ...extra }),
  addedAt,
});

const dune = item('Dune', {
  creators: [{ name: 'Frank Herbert', role: 'aut' }],
  tags: ['Science fiction', 'Classics'],
  metadata: { series: 'Dune', seriesIndex: 1, pages: 896, published: '1965', mood: 'Epic' },
  identifiers: { isbn: '978-0-441-17271-9' },
  files: [{ hash: 'a', size: 1, format: 'epub' }],
  cover: { hash: 'c', mediaType: 'image/jpeg' },
});
const emma = item('Emma', {
  creators: [{ name: 'Jane Austen', role: 'aut' }],
  tags: ['Classics', 'Romance'],
  metadata: { pages: 474, published: '1815-12' },
}, '2025-01-01T00:00:00Z');
const verne = item('Twenty Thousand Leagues Under the Seas', {
  creators: [{ name: 'Jules Verne', role: 'aut' }],
  tags: ['Science fiction fantasy'],
  files: [{ hash: 'b', size: 1, format: 'pdf' }],
});
const all = [dune, emma, verne];
const ratings = { [dune.id]: 5, [emma.id]: 3 };
const now = new Date('2026-10-01T00:00:00Z');
const find = (query: string) => filterItems(all, query, { ratings, now }).map((i) => i.title.split(' ')[0]);

describe('search syntax', () => {
  it('matches words, phrases and negated words', () => {
    expect(find('herb')).toEqual(['Dune']);
    expect(find('"jules verne"')).toEqual(['Twenty']);
    expect(find('"verne jules"')).toEqual([]);
    expect(find('classics -austen')).toEqual(['Dune']);
  });

  it('matches fields', () => {
    expect(find('author:austen')).toEqual(['Emma']);
    expect(find('by:"frank herbert"')).toEqual(['Dune']);
    // Tags match whole values, ignoring case.
    expect(find('tag:"science fiction"')).toEqual(['Dune']);
    expect(find('tag:romance,"Science fiction fantasy"')).toEqual(['Emma', 'Twenty']);
    expect(find('tag:romance|"Science fiction fantasy"')).toEqual(['Emma', 'Twenty']);
    expect(find('format:pdf')).toEqual(['Twenty']);
    expect(find('isbn:9780441172719')).toEqual(['Dune']);
    expect(find('mood:epic')).toEqual(['Dune']);
    expect(find('-tag:classics')).toEqual(['Twenty']);
  });

  it('compares numbers and dates', () => {
    expect(find('rating:4+')).toEqual(['Dune']);
    expect(find('rating:>=3')).toEqual(['Dune', 'Emma']);
    expect(find('rating:3')).toEqual(['Emma']);
    expect(find('pages:<500')).toEqual(['Emma']);
    expect(find('published:<1900')).toEqual(['Emma']);
    expect(find('added:>=2026-09')).toEqual(['Dune', 'Twenty']);
    expect(find('added:"last 30 days"')).toEqual(['Dune', 'Twenty']);
    expect(find('added:"last year"')).toEqual(['Dune', 'Twenty']);
    expect(find('added:"last 2 years"')).toEqual(['Dune', 'Emma', 'Twenty']);
  });

  it('checks for values with has:, and the older field:none', () => {
    expect(find('has:cover')).toEqual(['Dune']);
    expect(find('-has:file')).toEqual(['Emma']);
    expect(find('-has:series')).toEqual(['Emma', 'Twenty']);
    expect(find('series:none')).toEqual(['Emma', 'Twenty']);
    expect(find('-has:rating')).toEqual(['Twenty']);
  });

  it('joins with or, which binds looser than and', () => {
    expect(find('author:austen or format:pdf')).toEqual(['Emma', 'Twenty']);
    expect(find('classics rating:5 or format:pdf')).toEqual(['Dune', 'Twenty']);
  });

  it('searches an unknown field: as words', () => {
    expect(find('dune: herbert')).toEqual(['Dune']);
    expect(find('herbert:dune')).toEqual(['Dune']);
  });

  it('writes terms back as it reads them', () => {
    const query = '-tag:"Science fiction",Romance author:herbert "a phrase" or rating:4+ added:"last 30 days"';
    expect(formatQuery(parseQuery(query))).toBe(query);
  });
});

describe('filters', () => {
  const fields = filterFields(all);

  it('offers the built-in fields and the library’s other metadata', () => {
    expect(fields.map((f) => f.id)).toContain('mood');
    expect(fields.map((f) => f.id)).not.toContain('seriesIndex');
    expect(fields.find((f) => f.id === 'pages')?.kind).toBe('number');
  });

  it('turns rules into search text and back', () => {
    const filters: Filters = {
      any: false,
      rules: [
        { field: 'tag', condition: 'anyOf', values: ['Science fiction', 'Romance'] },
        { field: 'rating', condition: 'atLeast', values: ['4'] },
        { field: 'format', condition: 'absent', values: [] },
        { field: 'added', condition: 'inLast', values: ['30 days'] },
        { field: 'author', condition: 'notContains', values: ['Austen'] },
        { field: 'published', condition: 'before', values: ['1900'] },
      ],
    };
    const query = filtersQuery(filters);
    expect(query).toBe('tag:"Science fiction",Romance rating:4+ -has:format added:"last 30 days" -author:Austen published:<1900');
    expect(parseFilters(query, fields)).toEqual(filters);
    expect(filtersQuery({ ...filters, any: true })).toMatch(/^tag:.* or rating:4\+ or -has:format or /);
    expect(parseFilters(filtersQuery({ ...filters, any: true }), fields)).toEqual({ ...filters, any: true });
  });

  it('takes dates before AD 1 as a minus year', () => {
    const filters: Filters = { any: false, rules: [{ field: 'originallyPublished', condition: 'before', values: ['-0500'] }] };
    expect(filtersQuery(filters)).toBe('originallyPublished:<-0500');
    expect(parseFilters('originallyPublished:<-0500', fields)).toEqual(filters);
  });

  it('leaves out rules without a value, and reads plain words as Anything', () => {
    expect(filtersQuery({ any: false, rules: [{ field: 'author', condition: 'contains', values: [' '] }] })).toBe('');
    expect(parseFilters('verne', fields)).toEqual({ any: false, rules: [{ field: 'text', condition: 'contains', values: ['verne'] }] });
  });

  it('says when search text is more than rules can show', () => {
    expect(parseFilters('"a phrase"', fields)).toBeUndefined();
    expect(parseFilters('a b or c', fields)).toBeUndefined();
    expect(parseFilters('rating:>4', fields)).toBeUndefined();
  });

  it('describes rules in words', () => {
    expect(describeRule({ field: 'rating', condition: 'atLeast', values: ['4'] }, fields)).toBe('Rating is at least 4★');
    expect(describeRule({ field: 'format', condition: 'absent', values: [] }, fields)).toBe('Has no file');
    expect(describeRule({ field: 'cover', condition: 'present', values: [] }, fields)).toBe('Has a cover');
    expect(describeRule({ field: 'series', condition: 'absent', values: [] }, fields)).toBe('Series is empty');
    expect(describeRule({ field: 'format', condition: 'anyOf', values: ['epub', 'pdf'] }, fields)).toBe('Format is epub or pdf');
    expect(describeRule({ field: 'tag', condition: 'anyOf', values: ['Fantasy', 'Sci-fi', 'Horror'] }, fields)).toBe(
      'Tags include Fantasy, Sci-fi or Horror',
    );
    expect(describeRule({ field: 'added', condition: 'inLast', values: ['30 days'] }, fields)).toBe('Added in the last 30 days');
  });
});
