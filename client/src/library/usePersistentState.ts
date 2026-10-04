import { useCallback, useState } from 'react';

/** State remembered in this browser between visits; a convenience only, so storage failures are ignored. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  // Stored as it's set, not after the next render, so a value set just before unmounting is kept.
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered this time.
      }
    },
    [key],
  );
  return [value, set];
}
