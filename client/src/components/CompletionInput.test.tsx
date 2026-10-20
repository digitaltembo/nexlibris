import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionInput } from './CompletionInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => container.querySelector('input')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
const key = (key: string) => act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

function Field({ onPick, onEnter }: { onPick?(value: string): void; onEnter?(): void }) {
  const [value, setValue] = useState('');
  return (
    <CompletionInput
      aria-label="Tags"
      value={value}
      onChange={setValue}
      candidates={['Fantasy', 'Fairy Tales', 'Science Fiction']}
      exclude={['Fairy Tales']}
      onPick={onPick}
      onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
    />
  );
}

describe('a completion input', () => {
  it('offers the tags completing the one being typed, leaving out excluded ones', () => {
    act(() => root.render(<Field />));
    expect(options()).toEqual([]);
    type('f');
    expect(options()).toEqual(['Fantasy', 'Science Fiction']);
    type('Fantasy, sc');
    expect(options()).toEqual(['Science Fiction']);
  });

  it('picks the highlighted completion with the arrows and Enter, replacing the tag typed', () => {
    const onPick = vi.fn();
    const onEnter = vi.fn();
    act(() => root.render(<Field onPick={onPick} onEnter={onEnter} />));
    type('Classic, f');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(input().value).toBe('Classic, Science Fiction, ');
    expect(onPick).toHaveBeenCalledWith('Classic, Science Fiction, ');
    expect(onEnter).not.toHaveBeenCalled();
    expect(options()).toEqual([]);
  });

  it('leaves Enter to the field when nothing is highlighted, and closes on Escape', () => {
    const onEnter = vi.fn();
    act(() => root.render(<Field onEnter={onEnter} />));
    type('fan');
    key('Enter');
    expect(onEnter).toHaveBeenCalled();
    key('Escape');
    expect(options()).toEqual([]);
  });

  it('picks a completion clicked', () => {
    act(() => root.render(<Field />));
    type('sci');
    act(() => document.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(input().value).toBe('Science Fiction, ');
  });

  it('completes the whole text as one value when single', () => {
    function Name() {
      const [value, setValue] = useState('');
      return <CompletionInput single aria-label="Author" value={value} onChange={setValue} candidates={['Herbert, Frank', 'Le Guin, Ursula K.']} />;
    }
    act(() => root.render(<Name />));
    type('herbert, f');
    expect(options()).toEqual(['Herbert, Frank']);
    key('ArrowDown');
    key('Enter');
    expect(input().value).toBe('Herbert, Frank');
  });
});
