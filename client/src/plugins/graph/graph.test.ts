import { createItem } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { booksOf, buildGraph } from './graph';

const by = (name: string, role = 'aut') => ({ name, role });

describe('the books as a graph', () => {
  const mort = createItem({ title: 'Mort', creators: [by('Terry Pratchett')], tags: ['Fantasy', 'Read'], metadata: { series: 'Discworld', coverColor: '#223344' } });
  const omens = createItem({ title: 'Good Omens', creators: [by('Terry Pratchett'), by('Neil Gaiman')], tags: ['Fantasy', 'Read'] });
  const genji = createItem({ title: 'The Tale of Genji', creators: [by('Murasaki Shikibu'), by('Royall Tyler', 'trl')], tags: ['Read'] });
  const anon = createItem({ title: 'Beowulf', creators: [by('Seamus Heaney', 'trl')] });

  it('joins each book to its authors, tags and series, counting the books each joins', () => {
    const graph = buildGraph([mort, omens, genji, anon]);
    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(node(mort.id)).toEqual({ id: mort.id, kind: 'book', label: 'Mort', detail: 'Terry Pratchett', color: '#223344', books: 1 });
    expect(node('author:Terry Pratchett')).toMatchObject({ kind: 'author', books: 2 });
    expect(node('tag:Fantasy')).toMatchObject({ kind: 'tag', books: 2 });
    expect(node('series:Discworld')).toMatchObject({ kind: 'series', books: 1 });
    // Translators aren't authors, unless a book has no one else.
    expect(node('author:Royall Tyler')).toBeUndefined();
    expect(node(anon.id)!.detail).toBe('Seamus Heaney');
    expect(graph.links.filter((l) => l.source === omens.id).map((l) => l.target)).toEqual(['author:Terry Pratchett', 'author:Neil Gaiman', 'tag:Fantasy', 'tag:Read']);
    expect([...booksOf(graph, 'author:Terry Pratchett')].sort()).toEqual([mort.id, omens.id].sort());
    expect([...booksOf(graph, mort.id)]).toEqual([mort.id]);
    expect(booksOf(graph, 'tag:Nothing').size).toBe(0);
  });

  it('leaves out tags on so many books that they would pull everything together', () => {
    const many = Array.from({ length: 40 }, (_, i) => createItem({ title: `Book ${i}`, tags: ['Read', ...(i < 5 ? ['Poetry'] : [])] }));
    const graph = buildGraph(many);
    expect(graph.nodes.some((n) => n.id === 'tag:Read')).toBe(false);
    expect(graph.nodes.find((n) => n.id === 'tag:Poetry')?.books).toBe(5);
    // A few books may all share a tag.
    expect(buildGraph([mort, omens, genji]).nodes.find((n) => n.id === 'tag:Read')?.books).toBe(3);
  });
});
