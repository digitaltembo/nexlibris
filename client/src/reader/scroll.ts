import { useEffect, useRef, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically (the reader's body, for scrolling viewers). */
export function scrollParent(element: Element): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * For viewers that show the whole document in one scrolling column: once
 * `ready`, scrolls to `position` (a fraction of the way down, as a string),
 * then reports the fraction as the reader scrolls.
 */
export function useScrollFraction(
  ref: RefObject<HTMLElement | null>,
  ready: boolean,
  position: string | undefined,
  onPosition: ((locator: string, progress?: number) => void) | undefined,
) {
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const restored = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!ready || !element) return;
    const scroller = scrollParent(element);
    const range = () => scroller.scrollHeight - scroller.clientHeight;
    if (!restored.current) {
      restored.current = true;
      const fraction = Number(position);
      if (fraction > 0 && fraction <= 1) scroller.scrollTop = fraction * range();
    }
    const onScroll = () => {
      const fraction = range() > 0 ? scroller.scrollTop / range() : 1;
      onPositionRef.current?.(fraction.toFixed(4), fraction);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [ref, ready, position]);
}
