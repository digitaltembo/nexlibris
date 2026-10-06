import type { Item, ItemId } from '@nexlibris/common';

/**
 * The books as a graph, as on the readings site (~/Documents/readings): each book a node, joined
 * to a node for each of its authors, tags and series, so books that share them are drawn together.
 * The layout is left to the force simulation (`ForceGraph.tsx`); this is only the nodes and links,
 * kept apart so it can be tested without WebGL.
 */

export type NodeKind = 'book' | 'author' | 'tag' | 'series';

export interface GraphNode {
  /** A book's item id; `author:`, `tag:` or `series:` and the name for the others. */
  id: string;
  kind: NodeKind;
  label: string;
  /** For a book, its authors as a byline. */
  detail?: string;
  /** For a book, its cover's colour, when known. */
  color?: string;
  /** How many books link to it (1 for a book), which sizes it. */
  books: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: Exclude<NodeKind, 'book'>;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * Tags on more than this share of the books shown (and of at least `HUB_MIN` of them) are left
 * out: "Read" or "20th Century" would pull every book into one knot, as the readings site leaves
 * out its "read" tag.
 */
export const HUB_SHARE = 0.25;
const HUB_MIN = 20;

/** The nodes and links for `items`. Authors are the item's `aut` creators, or all its creators if none are. */
export function buildGraph(items: Item[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const tagCounts = new Map<string, number>();
  for (const item of items) for (const tag of new Set(item.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const hub = (tag: string) => {
    const count = tagCounts.get(tag) ?? 0;
    return count >= HUB_MIN && count > items.length * HUB_SHARE;
  };

  const link = (book: Item, kind: GraphLink['kind'], name: string) => {
    const id = `${kind}:${name}`;
    const node = nodes.get(id);
    if (node) node.books++;
    else nodes.set(id, { id, kind, label: name, books: 1 });
    links.push({ source: book.id, target: id, kind });
  };

  for (const item of items) {
    const authors = authorsOf(item);
    nodes.set(item.id, {
      id: item.id,
      kind: 'book',
      label: item.title,
      ...(authors.length && { detail: authors.join(', ') }),
      ...(item.metadata.coverColor && { color: item.metadata.coverColor }),
      books: 1,
    });
    for (const name of new Set(authors)) link(item, 'author', name);
    for (const tag of new Set(item.tags)) if (!hub(tag)) link(item, 'tag', tag);
    const series = item.metadata.series;
    if (typeof series === 'string' && series.trim()) link(item, 'series', series.trim());
  }
  return { nodes: [...nodes.values()], links };
}

function authorsOf(item: Item): string[] {
  const authors = item.creators.filter((c) => c.role === 'aut');
  return (authors.length ? authors : item.creators).map((c) => c.name.trim()).filter(Boolean);
}

/** The books a node joins (for a book, itself), to pick out and zoom to. */
export function booksOf(graph: Graph, id: string): Set<ItemId> {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return new Set();
  if (node.kind === 'book') return new Set([id]);
  return new Set(graph.links.filter((l) => endId(l.target) === id).map((l) => endId(l.source)));
}

/** A link's end: an id until the simulation swaps in the node itself. */
export const endId = (end: string | { id?: string | number }) => (typeof end === 'object' ? String(end.id) : end);
