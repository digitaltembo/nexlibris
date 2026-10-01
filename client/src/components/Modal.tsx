import { useEffect, useId, useRef, type ReactNode } from 'react';
import styled from 'styled-components';

const Dialog = styled.dialog`
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);

  &::backdrop {
    background: rgb(0 0 0 / 0.35);
  }
`;

const Body = styled.div`
  padding: 20px;

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

interface Props {
  title: string;
  /** Called on Escape and on a click outside the dialog. */
  onClose(): void;
  children: ReactNode;
}

/** A modal `<dialog>`, open while mounted. */
export function Modal({ title, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // No close() on cleanup: it fires `close`, which would call onClose when StrictMode
  // re-runs this effect. Unmounting removes the dialog, which ends the modal anyway.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  return (
    <Dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dialog element itself (not its contents) is a click on the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Body>
        <h2 id={titleId}>{title}</h2>
        {children}
      </Body>
    </Dialog>
  );
}
