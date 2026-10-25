import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import styled from 'styled-components';

const Dialog = styled.dialog<{ $wide: boolean }>`
  width: min(${(p) => (p.$wide ? '880px' : '480px')}, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  ${(p) => p.$wide && 'height: min(680px, calc(100vh - 64px));'}
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);

  &:focus {
    outline: none;
  }

  &::backdrop {
    background: rgb(0 0 0 / 0.35);
  }
`;

const Body = styled.div<{ $wide: boolean }>`
  padding: 20px;
  ${(p) => p.$wide && 'display: flex; flex-direction: column; height: 100%; box-sizing: border-box;'}

  h2 {
    margin: 0;
    font-size: 1.15rem;
  }
`;

export const ModalFooter = styled.footer`
  display: flex;
  gap: 8px;
  margin-top: 20px;
`;

const InlineTitle = styled.h3`
  margin: 0;
  font-size: 1.1rem;
`;

/**
 * Inside, a `Modal` renders in place rather than as a dialog of its own (a tab of the settings), handing its onClose to
 * this for the dialog it's in to call on Escape. Modals it opens in turn are dialogs again.
 */
export const InlineModal = createContext<((onClose: () => void) => void) | undefined>(undefined);

interface Props {
  title: string;
  /** Called on Escape and on a click outside the dialog. */
  onClose(): void;
  /** Larger and of a fixed height, its contents laying themselves out (the settings). */
  wide?: boolean;
  children: ReactNode;
}

/** A modal `<dialog>`, open while mounted; in place inside `InlineModal`. */
export function Modal({ title, onClose, wide = false, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const inline = useContext(InlineModal);

  // No close() on cleanup: it fires `close`, which would call onClose when StrictMode
  // re-runs this effect. Unmounting removes the dialog, which ends the modal anyway.
  useEffect(() => {
    if (inline || ref.current?.open) return;
    ref.current?.showModal();
    // Rather than its first button (the settings' first tab), outlined as if tabbed to.
    if (wide) ref.current?.focus();
  }, [inline, wide]);
  useEffect(() => {
    inline?.(onClose);
  });

  if (inline) {
    return (
      <InlineModal.Provider value={undefined}>
        <section aria-labelledby={titleId}>
          <InlineTitle id={titleId}>{title}</InlineTitle>
          {children}
        </section>
      </InlineModal.Provider>
    );
  }

  return (
    <Dialog
      ref={ref}
      $wide={wide}
      tabIndex={wide ? -1 : undefined}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dialog element itself (not its contents) is a click on the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Body $wide={wide}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </Body>
    </Dialog>
  );
}
