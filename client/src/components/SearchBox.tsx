import styled from 'styled-components';
import { SearchIcon } from './icons';
import { t } from '../i18n';

const Box = styled.div`
  position: relative;
  display: flex;
  flex: 1 1 180px;
  min-width: 0;
`;

/** Looks like a search field; opens the search dialog. */
const Trigger = styled.button.attrs({ type: 'button' })<{ $actions: number }>`
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px ${(p) => 8 + p.$actions * 34}px 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: text;

  > svg {
    flex: none;
    color: var(--muted);
  }

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

/** Marks a search of the text inside books, as opposed to one of the books. */
const ModeLabel = styled.span`
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--soft);
  font-size: 0.8em;
  font-weight: 600;
`;

const Placeholder = styled.span`
  color: var(--muted);
`;

const Actions = styled.span`
  position: absolute;
  top: 2px;
  right: 2px;
  bottom: 2px;
  display: flex;
  gap: 2px;
`;

const InnerButton = styled.button.attrs({ type: 'button' })`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  border: none;
  border-radius: calc(var(--radius) - 1px);
  background: none;
  color: var(--muted);
  font-size: 1rem;
  cursor: pointer;

  &:hover {
    color: var(--text);
    background: var(--hover);
  }

  &[aria-pressed='true'] {
    color: var(--highlight-text);
    background: var(--highlight);
  }
`;

interface Props {
  value: string;
  /** The search is of the text inside books. */
  inText?: boolean;
  placeholder: string;
  /** Opens the search dialog. */
  onOpen(): void;
  onClear(): void;
}

/** The search in the top bar: what's searched for, opening the search dialog, with a button to clear it. */
export function SearchBox({ value, inText, placeholder, onOpen, onClear }: Props) {
  const label = value ? t(inText ? 'searchBox.searchInsideFor' : 'searchBox.searchFor', { value }) : t('searchBox.search');
  return (
    <Box>
      <Trigger $actions={value ? 1 : 0} aria-label={label} aria-haspopup="dialog" onClick={onOpen}>
        <SearchIcon />
        {value && inText && <ModeLabel>{t('searchBox.insideBooks')}</ModeLabel>}
        {value ? <span>{value}</span> : <Placeholder>{placeholder}</Placeholder>}
      </Trigger>
      <Actions>
        {value && (
          <InnerButton aria-label={t('searchBox.clear')} title={t('searchBox.clear')} onClick={onClear}>
            ×
          </InnerButton>
        )}
      </Actions>
    </Box>
  );
}
