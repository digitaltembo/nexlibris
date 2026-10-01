import { useState } from 'react';
import { Button } from '../styles/ui';

interface Props {
  /** What's being deleted, for the button labels, e.g. "3 items". Omit for "Delete…". */
  what?: string;
  onDelete(): void;
}

/** A delete button that asks for confirmation in place before acting. */
export function DeleteButton({ what, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button $variant="secondary" onClick={() => setConfirming(true)}>
        Delete{what && ` ${what}`}…
      </Button>
    );
  }
  return (
    <>
      <Button $variant="danger" autoFocus onClick={onDelete}>
        Delete{what && ` ${what}`}
      </Button>
      <Button $variant="secondary" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </>
  );
}
