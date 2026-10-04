import { describe, expect, it } from 'vitest';
import { clickItem, NO_SELECTION, toggleItem, type SelectionState } from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const cmd = { ...plain, metaKey: true };
const ctrl = { ...plain, ctrlKey: true };
const shift = { ...plain, shiftKey: true };
const click = (state: SelectionState, id: string, keys = plain) => clickItem(state, id, order, keys);
const ids = (state: SelectionState) => [...state.selection].sort();

describe('clickItem', () => {
  it('selects one book and opens its preview on a plain click', () => {
    const state = click(click(NO_SELECTION, 'a'), 'c');
    expect(ids(state)).toEqual(['c']);
    expect(state.previewId).toBe('c');
  });

  it('adds books with Cmd or Ctrl, closing the preview, and takes them away again', () => {
    let state = click(NO_SELECTION, 'b');
    state = click(state, 'd', cmd);
    expect(ids(state)).toEqual(['b', 'd']);
    expect(state.previewId).toBeUndefined();
    state = click(state, 'e', ctrl);
    expect(ids(state)).toEqual(['b', 'd', 'e']);
    state = click(state, 'd', cmd);
    expect(ids(state)).toEqual(['b', 'e']);
    // Back to one book: it stays highlighted, without reopening the preview.
    state = click(state, 'e', cmd);
    expect(ids(state)).toEqual(['b']);
    expect(state.previewId).toBeUndefined();
  });

  it('selects a range with Shift from the last book clicked, in the order shown', () => {
    let state = click(NO_SELECTION, 'd');
    state = click(state, 'b', shift);
    expect(ids(state)).toEqual(['b', 'c', 'd']);
    expect(state.previewId).toBeUndefined();
    // Another Shift-click moves the range's far end, from the same anchor.
    state = click(state, 'e', shift);
    expect(ids(state)).toEqual(['d', 'e']);
    // With Cmd as well, the range is added to what's selected.
    state = click(click(state, 'a', cmd), 'b', { ...shift, metaKey: true });
    expect(ids(state)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('keeps the preview when a Shift-click selects only the previewed book', () => {
    const state = click(click(NO_SELECTION, 'c'), 'c', shift);
    expect(ids(state)).toEqual(['c']);
    expect(state.previewId).toBe('c');
  });

  it('treats a range from a book no longer shown as just the book clicked', () => {
    const state = clickItem(click(NO_SELECTION, 'a'), 'c', ['b', 'c'], shift);
    expect(ids(state)).toEqual(['c']);
  });
});

describe('toggleItem', () => {
  it('starts a selection without opening the preview, as a long press does', () => {
    const state = toggleItem(NO_SELECTION, 'b');
    expect(ids(state)).toEqual(['b']);
    expect(state.previewId).toBeUndefined();
    expect(ids(toggleItem(state, 'c'))).toEqual(['b', 'c']);
  });
});
