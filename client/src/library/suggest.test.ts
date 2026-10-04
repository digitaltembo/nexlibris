import { createItem } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { filterFields } from './filters';
import { suggest, wordAt } from './suggest';

const items = [
  createItem({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }], tags: ['Science Fiction'], metadata: { series: 'Dune' } }),
  createItem({ title: 'Emma', creators: [{ name: 'Jane Austen', role: 'aut' }], tags: ['Classic', 'Romance'] }),
  createItem({ title: 'Frankenstein', creators: [{ name: 'Mary Shelley', role: 'aut' }], tags: ['Classic', 'Horror'] }),
];
const fields = filterFields(items);
const at = (query: string) => suggest(query, query.length, items, fields);

describe('wordAt', () => {
  it('finds the word at the caret, keeping quoted spaces in it', () => {
    expect(wordAt('dune tag:"science fi', 20)).toEqual({ start: 5, end: 20 });
    expect(wordAt('a bc d', 3)).toEqual({ start: 2, end: 4 });
    expect(wordAt('', 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('suggest', () => {
  it('turns a word into the fields and values it starts', () => {
    expect(at('fran').map((s) => `${s.kind}: ${s.label}`)).toEqual(['Author: Frank Herbert']);
    expect(at('aut')[0]).toMatchObject({ label: 'author:', kind: 'Field', query: 'author:', caret: 7 });
    expect(at('class')).toEqual([{ label: 'Classic', kind: 'Tag', query: 'tag:Classic ', caret: 12 }]);
    expect(at('')).toEqual([]);
  });

  it('completes a field’s values, quoting where needed and keeping a minus', () => {
    expect(at('emma tag:sci')).toEqual([{ label: 'Science Fiction', kind: 'Tags', query: 'emma tag:"Science Fiction" ', caret: 27 }]);
    expect(at('-tag:"hor')[0]!.query).toBe('-tag:Horror ');
    expect(at('tag:').map((s) => s.label)).toEqual(['Classic', 'Horror', 'Romance', 'Science Fiction']);
    expect(at('rating:').map((s) => s.label)).toContain('4+');
    expect(at('has:c').map((s) => s.label)).toEqual(['cover']);
    expect(at('nosuch:x')).toEqual([]);
  });

  it('replaces the word at the caret, leaving the rest', () => {
    expect(suggest('jane cla rating:4+', 8, items, fields)[0]).toMatchObject({ query: 'jane tag:Classic rating:4+', caret: 17 });
  });
});
