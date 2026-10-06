import { useState } from 'react';
import { Button } from '../styles/ui';

interface Props {
  /** What's being deleted, for the button labels, e.g. "3 items". Omit for "Delete…". */
  what?: string;
  /** The action's word, "Delete" unless given (e.g. "Remove"). */
  verb?: string;
  /** Small buttons, as in a list's rows. */
  small?: boolean;
  disabled?: boolean;
  onDelete(): void;
}

/** A delete button that asks for confirmation in place before acting. */
export function DeleteButton({ what, verb = 'Delete', small, disabled, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const size = small ? ({ $size: 'small' } as const) : {};
  const label = `${verb}${what ? ` ${what}` : ''}`;
  if (!confirming) {
    return (
      <Button $variant="secondary" {...size} disabled={disabled} onClick={() => setConfirming(true)}>
        {label}…
      </Button>
    );
  }
  return (
    <>
      <Button
        $variant="danger"
        {...size}
        disabled={disabled}
        autoFocus
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
      >
        {label}
      </Button>
      <Button $variant="secondary" {...size} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </>
  );
}
