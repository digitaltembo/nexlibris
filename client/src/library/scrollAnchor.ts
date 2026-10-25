/**
 * Keeping the books in view while they move, as the right-hand pane opens and closes. The views mark each book's
 * element with `data-item` (its id); the page scrolls, under the sticky top bar.
 */

/** A book at the top of the view and where its top was, so the view can be put back after the books reflow. */
export interface ScrollAnchor {
  id: string;
  top: number;
}

/** A book's element in the view shown. */
export const bookElement = (id: string) => document.querySelector<HTMLElement>(`main [data-item="${CSS.escape(id)}"]`);

/**
 * The first book at least partly in view below the top bar: the first of its row, so every book in view comes after
 * it. Books' tops only grow in document order (rows of a grid, a list's rows), so it's found by bisection.
 */
export function topAnchor(): ScrollAnchor | undefined {
  const books = document.querySelectorAll<HTMLElement>('main [data-item]');
  const line = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
  const top = (i: number) => books[i]!.getBoundingClientRect().top;
  // The first book starting below the line.
  let lo = 0;
  let hi = books.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top(mid) > line) hi = mid;
    else lo = mid + 1;
  }
  // The row above it, if it shows below the line.
  let i = lo > 0 && books[lo - 1]!.getBoundingClientRect().bottom > line ? lo - 1 : lo;
  while (i > 0 && i < books.length && top(i - 1) === top(i)) i--;
  const book = books[i];
  return book?.dataset.item ? { id: book.dataset.item, top: top(i) } : undefined;
}

/** Scrolls the anchor's book back to where its top was. */
export function restoreAnchor(anchor: ScrollAnchor) {
  const book = bookElement(anchor.id);
  if (book) window.scrollBy(0, book.getBoundingClientRect().top - anchor.top);
}
