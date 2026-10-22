import { filterItems, userData } from '@nexlibris/common';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { Muted } from '../styles/ui';

const Input = styled.input`
  width: 100%;
  font-family: inherit;
`;

/** How many of the library's books a search matches, or undefined for an empty one. */
export function useMatchCount(query: string): number | undefined {
  const { library } = useLibrary();
  if (!query.trim()) return undefined;
  return filterItems(Object.values(library.items), query, { ratings: userData(library).ratings }).length;
}

/**
 * A search in the search box's syntax (common's `search.ts`: words, `tag:Recommended`, `rating:4+`,
 * `or`, `has:cover`), typed as text, with how many books match it now. What connections' catalogs
 * and the books another instance keeps are chosen by.
 */
export function QueryInput({ value, onChange, placeholder = 'e.g. tag:Recommended rating:4+', ...rest }: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  'aria-label'?: string;
}) {
  const count = useMatchCount(value);
  return (
    <>
      <Input type="search" value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} {...rest} />
      {count !== undefined && <Muted as="small">{count === 1 ? '1 book matches' : `${count} books match`} now.</Muted>}
    </>
  );
}
