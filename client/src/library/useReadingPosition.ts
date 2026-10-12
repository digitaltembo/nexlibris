import { LOCAL_USER, userData, type FileRef, type ItemId, type Library } from '@nexlibris/common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from './LibraryContext';

/** How long the position has to stay put before it's saved, so page turns don't each add a change. */
const SAVE_DELAY_MS = 3000;

/** Where the user left off in an item, if it's in a file the item still has. */
export function savedPosition(library: Library, itemId: ItemId) {
  const position = userData(library).positions?.[itemId];
  const file = position && library.items[itemId]?.files.find((f) => f.hash === position.hash);
  return position && file ? { ...position, file } : undefined;
}

/**
 * The reading position for one file of an item: where to open (fixed when the
 * reader opens), and `report`, which viewers call as the reader moves. Reports
 * are saved to the library once they settle, when the reader closes, and when
 * the page is hidden (e.g. the Android app goes to the background).
 */
export function useReadingPosition(itemId: ItemId, file: FileRef) {
  const { library, apply } = useLibrary();
  const [initial] = useState(() => {
    const saved = userData(library).positions?.[itemId];
    return saved?.hash === file.hash ? saved.locator : undefined;
  });
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const save = useCallback(
    (locator: string, progress?: number) => {
      const position = { hash: file.hash, locator, ...(progress !== undefined && { progress }) };
      // Fails if the item was deleted meanwhile, which leaves nothing to remember.
      applyRef.current([{ type: 'setPosition', userId: LOCAL_USER, itemId, position }]).catch(() => undefined);
    },
    [itemId, file.hash],
  );
  return { initial, report: usePositionReports(save, initial) };
}

/**
 * `report` for a viewer's positions, passing them to `save` once they settle (`SAVE_DELAY_MS`),
 * when the reader closes, and when the page is hidden. `saved` is where it opened, which needn't
 * be saved again.
 */
export function usePositionReports(save: (locator: string, progress?: number) => void, saved?: string) {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ locator: string; progress?: number }>(undefined);
  const lastSaved = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = undefined;
    if (!next || next.locator === lastSaved.current) return;
    lastSaved.current = next.locator;
    saveRef.current(next.locator, next.progress);
  }, []);

  const report = useCallback(
    (locator: string, progress?: number) => {
      pending.current = { locator, progress: progress === undefined ? undefined : Math.min(1, Math.max(0, progress)) };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    // A window closing may not be hidden first.
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  return report;
}
