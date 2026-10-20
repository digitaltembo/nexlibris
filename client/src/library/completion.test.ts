import { describe, expect, it } from 'vitest';
import type { Item } from '@nexlibris/common';
import { completeTag, completions, creatorsIn, tagCompletions, tagsIn } from './completion';

const item = (tags: string[], creators: string[] = []) => ({ tags, creators: creators.map((name) => ({ name })) }) as unknown as Item;
const all = ['Science Fiction', 'Fantasy', 'Classic', 'Hard Science', 'Fairy Tales'];

describe('tagsIn', () => {
  it('lists tags most used first, once whatever their case', () => {
    expect(tagsIn([item(['fantasy', 'Classic']), item(['Fantasy']), item(['fantasy'])])).toEqual(['fantasy', 'Classic']);
  });
});

describe('creatorsIn', () => {
  it('lists creators most common first', () => {
    expect(creatorsIn([item([], ['Ursula K. Le Guin']), item([], ['Frank Herbert', 'ursula k. le guin'])])).toEqual([
      'Ursula K. Le Guin',
      'Frank Herbert',
    ]);
  });
});

describe('completions', () => {
  it('completes the whole text, commas and all', () => {
    const names = ['Herbert, Frank', 'Herbert, Brian', 'Le Guin, Ursula K.'];
    expect(completions('herbert, f', names)).toEqual(['Herbert, Frank']);
    expect(completions('urs', names, ['herbert, frank'])).toEqual(['Le Guin, Ursula K.']);
  });
});

describe('tagCompletions', () => {
  it('offers tags the typed text starts, then ones with a word it starts', () => {
    expect(tagCompletions('sci', all)).toEqual(['Science Fiction', 'Hard Science']);
    expect(tagCompletions('fa', all)).toEqual(['Fantasy', 'Fairy Tales']);
  });

  it('completes only the tag after the last comma', () => {
    expect(tagCompletions('Classic, fan', all)).toEqual(['Fantasy']);
  });

  it('leaves out tags already typed, excluded or typed in full', () => {
    expect(tagCompletions('fantasy, f', all)).toEqual(['Fairy Tales', 'Science Fiction']);
    expect(tagCompletions('fa', all, ['fairy tales'])).toEqual(['Fantasy']);
    expect(tagCompletions('Fantasy', all)).toEqual([]);
  });

  it('offers nothing before anything is typed', () => {
    expect(tagCompletions('', all)).toEqual([]);
    expect(tagCompletions('Classic, ', all)).toEqual([]);
  });

  it('ignores case and accents', () => {
    expect(tagCompletions('CLÁ', all)).toEqual(['Classic']);
  });
});

describe('completeTag', () => {
  it('replaces the tag being typed', () => {
    expect(completeTag('fan', 'Fantasy')).toBe('Fantasy, ');
    expect(completeTag('Classic, fan', 'Fantasy')).toBe('Classic, Fantasy, ');
  });
});
