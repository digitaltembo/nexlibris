import { useEffect, useRef } from 'react';

/**
 * Makes the Back button (the browser's, or Android's, which the app maps to
 * history) close the topmost open overlay, such as the reader or a dialog,
 * instead of leaving the page.
 *
 * Each open overlay has a history entry above the page's own, added when it
 * opens. Back pops one, closing the topmost overlay. Closing an overlay any
 * other way removes its entry.
 *
 * Entries are only ever added when something opens, which follows a click.
 * Chrome skips entries added without a user gesture when going back, so
 * adding one in response to Back itself would not work.
 */

type Overlay = { close(): void };
type TrapState = { nexlibrisOverlays: number };

const stack: Overlay[] = [];
/** How many of our entries are on top of the page's history. */
let entries = 0;
/** Pops caused by our own history.go(), which aren't the user pressing Back. */
let ownPops = 0;
let syncScheduled = false;
let listening = false;

const depthOf = (state: unknown) => (state as TrapState | null)?.nexlibrisOverlays ?? 0;

/**
 * Brings history in line with the stack. Deferred, so overlays that open and
 * close within one tick (as StrictMode does with effects, or one overlay
 * replacing another) only change what they need to.
 */
function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
    while (entries < stack.length) history.pushState({ nexlibrisOverlays: ++entries } satisfies TrapState, '');
    if (entries > stack.length) {
      ownPops++;
      history.go(stack.length - entries);
      entries = stack.length;
    }
  }, 0);
}

function onPopState(event: PopStateEvent) {
  const depth = depthOf(event.state);
  if (ownPops > 0) {
    ownPops--;
    return;
  }
  entries = depth;
  // Back (normally by one entry): close overlays from the top until they match.
  // Forward onto stale entries: drop them again.
  for (let i = stack.length - 1; i >= depth; i--) stack[i]?.close();
  if (depth > stack.length) scheduleSync();
}

/** While `open`, Back calls `onClose` (when this is the most recently opened overlay). */
export function useBackToClose(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    if (!listening) {
      window.addEventListener('popstate', onPopState);
      listening = true;
      entries = depthOf(history.state);
    }
    const overlay: Overlay = { close: () => onCloseRef.current() };
    stack.push(overlay);
    scheduleSync();
    return () => {
      const index = stack.indexOf(overlay);
      if (index >= 0) stack.splice(index, 1);
      scheduleSync();
    };
  }, [open]);
}
