import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { completeTag, completions as complete, tagCompletions } from '../library/completion';
import { MenuEntry, MenuPanel } from './MenuButton';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  /** Comma-separated tags, or with `single`, one value. */
  value: string;
  onChange(value: string): void;
  /** Values to complete from, best first. */
  candidates: string[];
  /** Values not to offer, e.g. tags the book already has. */
  exclude?: string[];
  /** Completes the whole text as one value (a name, which may hold commas) rather than a list of tags. */
  single?: boolean;
  /** After a completion is picked, with the text it makes. */
  onPick?(value: string): void;
}

const Entry = styled(MenuEntry)`
  &[aria-selected='true'] {
    background: var(--soft);
  }
`;

/**
 * An input for comma-separated tags, or one value, that offers the candidates completing what's being
 * typed, in a list below it (fixed to the viewport, so a scrolling panel doesn't clip it). Arrow keys
 * move through the list; Enter or Tab picks the highlighted value, a click any; Escape closes it.
 */
export function CompletionInput({ value, onChange, candidates, exclude, single, onPick, onKeyDown, onBlur, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number }>();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const completions = !open ? [] : single ? complete(value, candidates, exclude) : tagCompletions(value, candidates, exclude);
  const shown = completions.length > 0;

  useLayoutEffect(() => {
    if (!shown || !input.current) return;
    const anchor = input.current.getBoundingClientRect();
    setPlace({ top: anchor.bottom + 4, left: anchor.left, minWidth: anchor.width });
  }, [shown, value]);

  useEffect(() => {
    if (!shown) return;
    const away = () => setOpen(false);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [shown]);

  const pick = (picked: string) => {
    const next = single ? picked : completeTag(value, picked);
    onChange(next);
    setOpen(false);
    onPick?.(next);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (shown) {
      // Through the completions and back to none (-1), the text as typed.
      const move = (by: number) => setActive((at) => ((at + 1 + by + completions.length + 1) % (completions.length + 1)) - 1);
      if (event.key === 'ArrowDown') move(1);
      else if (event.key === 'ArrowUp') move(-1);
      else if (event.key === 'Escape') setOpen(false);
      else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) pick(completions[active]!);
      else return onKeyDown?.(event);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onKeyDown?.(event);
  };

  return (
    <>
      <input
        {...rest}
        ref={input}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={keyDown}
        onBlur={(e) => {
          setOpen(false);
          onBlur?.(e);
        }}
      />
      {shown && (
        <MenuPanel
          id={listId}
          role="listbox"
          aria-label="Suggestions"
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth } : { visibility: 'hidden' }}
        >
          {completions.map((tag, i) => (
            <Entry
              key={tag}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              // Keeps the input focused, so its blur doesn't act on the half-typed tag.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(tag)}
            >
              {tag}
            </Entry>
          ))}
        </MenuPanel>
      )}
    </>
  );
}
