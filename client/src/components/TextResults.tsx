import type { FileRef, Item, ItemId } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import type { Passage } from '@nexlibris/tools/fulltext/match';
import { useTextSearch, type TextCoverage, type TextHit } from '../fulltext/TextIndexContext';
import { NARROW } from '../styles/GlobalStyle';
import { Muted } from '../styles/ui';
import { Cover } from './Cover';

const Summary = styled.p`
  margin: 4px 0 16px;
  color: var(--muted);
`;

const Books = styled.ol`
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Book = styled.li`
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 4px 14px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);

  ${NARROW} {
    grid-template-columns: 40px minmax(0, 1fr);
  }
`;

const CoverButton = styled.button.attrs({ type: 'button' })`
  grid-row: span 2;
  align-self: start;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
`;

const Heading = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
`;

const TitleButton = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
`;

const Passages = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
`;

const PassageButton = styled.button.attrs({ type: 'button' })`
  display: block;
  width: 100%;
  padding: 6px 8px;
  margin-left: -8px;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text);
  font: inherit;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
`;

const Where = styled.span`
  display: block;
  color: var(--muted);
  font-size: 0.8em;
`;

const More = styled.button.attrs({ type: 'button' })`
  align-self: start;
  margin-top: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.9em;
  text-decoration: underline;
  cursor: pointer;
`;

/** A passage's text, with its matches marked. */
export const Snippet = ({ passage }: { passage: Passage }) => {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [i, [start, end]] of passage.highlights.entries()) {
    if (start < at) continue;
    parts.push(passage.snippet.slice(at, start), <mark key={i}>{passage.snippet.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(passage.snippet.slice(at));
  return <>{parts}</>;
};

/** Where a passage is, for its label: the chapter, or the page. */
/** Where a passage is in its book: its chapter, or a PDF's page. */
export const passagePlace = (_hit: TextHit, passage: Passage) => passage.place;

/** How much of the library was searched, in words, when not all of it could be. */
export function coverageNote(coverage: TextCoverage | undefined): string | undefined {
  if (!coverage) return undefined;
  const notes = [];
  if (coverage.pending) notes.push(`${coverage.pending} ${coverage.pending === 1 ? 'is' : 'are'} still being indexed`);
  if (coverage.elsewhere) notes.push(`${coverage.elsewhere} ${coverage.elsewhere === 1 ? 'isn’t' : 'aren’t'} stored on this device`);
  if (coverage.without) notes.push(`${coverage.without} ${coverage.without === 1 ? 'has' : 'have'} no text to search (comics, scans, no file)`);
  if (!notes.length) return undefined;
  const books = coverage.searched + coverage.pending + coverage.elsewhere + coverage.without;
  return `Searched the text of ${coverage.searched} of ${books} books; ${notes.join(', ')}.`;
}

const SHOWN = 3;

interface Props {
  query: string;
  items: Item[];
  /** Opens the reader at a passage. */
  onRead(item: Item, file: FileRef, locator: string): void;
  /** Opens a book's preview. */
  onOpenItem(id: ItemId): void;
}

/** A search inside books: the books whose text matches, each with the passages that do. */
export function TextResults({ query, items, onRead, onOpenItem }: Props) {
  const { hits, searching, coverage } = useTextSearch(query, items);
  const [expanded, setExpanded] = useState<ReadonlySet<ItemId>>(new Set());
  const total = hits.reduce((n, h) => n + h.match.total, 0);
  const note = coverageNote(coverage);

  return (
    <section aria-label="Text search results">
      <Summary role="status">
        {hits.length
          ? `${hits.length} ${hits.length === 1 ? 'book has' : 'books have'} “${query}” in the text, ${total} ${total === 1 ? 'time' : 'times'}${searching ? ' so far…' : '.'}`
          : searching
            ? 'Searching the text…'
            : `No book’s text has “${query}”.`}
        {note && (
          <>
            {' '}
            <Muted>{note}</Muted>
          </>
        )}
      </Summary>
      <Books>
        {hits.map((hit) => {
          const open = expanded.has(hit.item.id);
          const passages = open ? hit.match.passages : hit.match.passages.slice(0, SHOWN);
          const more = hit.match.passages.length - passages.length;
          return (
            <Book key={hit.item.id}>
              <CoverButton aria-label={`Show ${hit.item.title}`} onClick={() => onOpenItem(hit.item.id)}>
                <Cover item={hit.item} />
              </CoverButton>
              <Heading>
                <TitleButton onClick={() => onOpenItem(hit.item.id)}>{hit.item.title}</TitleButton>
                <Muted>{hit.item.creators[0]?.name}</Muted>
                <Muted>
                  · {hit.match.total} {hit.match.total === 1 ? 'match' : 'matches'}
                </Muted>
              </Heading>
              <Passages>
                {passages.map((passage, i) => (
                  <li key={i}>
                    <PassageButton
                      title="Read from here"
                      onClick={() => onRead(hit.item, hit.file, passage.locator)}
                    >
                      {passagePlace(hit, passage) && <Where>{passagePlace(hit, passage)}</Where>}
                      <Snippet passage={passage} />
                    </PassageButton>
                  </li>
                ))}
                {more > 0 && (
                  <li>
                    <More onClick={() => setExpanded(new Set([...expanded, hit.item.id]))}>
                      {more} more {more === 1 ? 'passage' : 'passages'}
                    </More>
                  </li>
                )}
              </Passages>
            </Book>
          );
        })}
      </Books>
    </section>
  );
}
