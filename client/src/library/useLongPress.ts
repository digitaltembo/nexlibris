import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

const LONG_PRESS_MS = 500;
/** How far a finger may drift before it's a scroll rather than a press. */
const SLOP_PX = 10;

/**
 * Long presses on touch screens, for selecting more than one book where there's no Cmd/Ctrl or
 * Shift. `bind(id)` gives an element's handlers; a long press calls `onLongPress(id)`, and the
 * click (and context menu) that would follow it are swallowed. Mice are left alone.
 */
export function useLongPress<Id>(onLongPress: (id: Id) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number }>(undefined);
  /** Set when a long press fired, until the click it leads to is swallowed. */
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = undefined;
  };
  useEffect(() => cancel, []);

  return (id: Id) => ({
    onPointerDown: (e: PointerEvent) => {
      cancel();
      fired.current = false;
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press.current = undefined;
          fired.current = true;
          navigator.vibrate?.(10);
          callback.current(id);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: PointerEvent) => {
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => {
      // The browser's long-press menu (or Android's text selection) would cover the selection.
      if (fired.current || press.current) e.preventDefault();
    },
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  });
}
