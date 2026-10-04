import type { ItemId } from '@nexlibris/common';

/**
 * Which books are selected, as in a file manager: a click selects one and opens its preview,
 * Cmd/Ctrl-click (or a long press) adds or takes one away, Shift-click selects a range from the
 * last book clicked. The preview shows while exactly that one book is selected; selecting more
 * closes it, and the bulk actions take over.
 */
export interface SelectionState {
  selection: ReadonlySet<ItemId>;
  /** Where a Shift-click's range starts: the last book clicked without Shift. */
  anchor?: ItemId;
  /** The book open in the preview, if any. */
  previewId?: ItemId;
}

export const NO_SELECTION: SelectionState = { selection: new Set() };

export interface Modifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** The selection after clicking `id`, with `order` the books as shown. */
export function clickItem(state: SelectionState, id: ItemId, order: readonly ItemId[], keys: Modifiers): SelectionState {
  const adding = keys.metaKey || keys.ctrlKey;
  if (keys.shiftKey) {
    const from = order.indexOf(state.anchor ?? id);
    const to = order.indexOf(id);
    const range = from < 0 || to < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
    const selection = new Set(adding ? state.selection : []);
    for (const each of range) selection.add(each);
    return keepPreview(state, { selection, anchor: state.anchor ?? id });
  }
  if (adding) return toggleItem(state, id);
  return { selection: new Set([id]), anchor: id, previewId: id };
}

/** Adds `id` to the selection, or takes it away: Cmd/Ctrl-click, or a long press. */
export function toggleItem(state: SelectionState, id: ItemId): SelectionState {
  const selection = new Set(state.selection);
  if (!selection.delete(id)) selection.add(id);
  return keepPreview(state, { selection, anchor: id });
}

/** Keeps the preview only while its book is the whole selection. */
function keepPreview(state: SelectionState, next: SelectionState): SelectionState {
  const { previewId } = state;
  return previewId && next.selection.size === 1 && next.selection.has(previewId) ? { ...next, previewId } : next;
}
