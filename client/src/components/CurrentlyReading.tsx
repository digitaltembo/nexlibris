import styled from 'styled-components';
import type { Reading } from '../library/currentlyReading';
import { Muted } from '../styles/ui';
import { Cover } from './Cover';

interface Props {
  reading: Reading[];
  /** Reopens a book where it was left. */
  onRead(reading: Reading): void;
  /** Takes a book out of the section, keeping its place. */
  onSetAside(reading: Reading): void;
  /** Closes the notice till the app is next opened (the Library's Currently reading still lists the books). */
  onHide(): void;
}

/**
 * The books being read, each one click to reopen where it was left and one to take out. Shown in a
 * notice above the books (`App`) when the app opens, till hidden; the Library's Currently reading
 * lists them too.
 */
export function CurrentlyReading({ reading, onRead, onSetAside, onHide }: Props) {
  return (
    <Section aria-label="Currently reading">
      <Heading>
        <h2>Currently reading</h2>
        <Quiet onClick={onHide} title="Hide till nexlibris is next opened; the books stay under Library › Currently reading">
          Hide
        </Quiet>
      </Heading>
      <Books>
        {reading.map((r) => {
          const percent = r.position.progress !== undefined ? Math.round(r.position.progress * 100) : undefined;
          const authors = r.item.creators.map((c) => c.name).join(', ');
          return (
            <li key={r.item.id}>
              <Book onClick={() => onRead(r)} title={`Continue reading ${r.item.title}`}>
                <Thumb item={r.item} />
                <span>
                  <strong>{r.item.title}</strong>
                  {authors && <Muted>{authors}</Muted>}
                  {percent !== undefined && (
                    <Progress aria-label={`${percent}% read`}>
                      <span style={{ width: `${percent}%` }} />
                    </Progress>
                  )}
                </span>
              </Book>
              <SetAside aria-label={`Remove ${r.item.title} from Currently reading`} title="Remove from Currently reading (keeps your place)" onClick={() => onSetAside(r)}>
                ×
              </SetAside>
            </li>
          );
        })}
      </Books>
    </Section>
  );
}

const Section = styled.section`
  flex: 1;
  min-width: 0;
`;

const Heading = styled.div`
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;

  h2 {
    margin: 0;
    font-size: 1em;
  }
`;

const Quiet = styled.button.attrs({ type: 'button' })`
  margin-left: auto;
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.9em;
  cursor: pointer;

  &:hover {
    color: var(--text);
    text-decoration: underline;
  }
`;

const Books = styled.ul`
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 0 0 4px;
  overflow-x: auto;
  list-style: none;

  li {
    position: relative;
    flex: 0 0 auto;
  }
`;

const Book = styled.button.attrs({ type: 'button' })`
  display: flex;
  gap: 10px;
  align-items: center;
  width: 240px;
  padding: 6px 28px 6px 6px;
  border: 1px solid var(--soft-border);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  strong,
  ${Muted} {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  ${Muted} {
    font-size: 0.85em;
  }
`;

const Thumb = styled(Cover)`
  width: 34px;
  flex: none;
  font-size: 0;
`;

const Progress = styled.span`
  display: block;
  height: 4px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;

  span {
    display: block;
    height: 100%;
    background: var(--highlight);
  }
`;

const SetAside = styled.button.attrs({ type: 'button' })`
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: var(--soft);
    color: var(--text);
  }
`;
