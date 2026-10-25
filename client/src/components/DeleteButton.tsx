import { useState } from 'react';
import { Button } from '../styles/ui';
import { t } from '../i18n';

interface Props {
  /** The button's label, e.g. "Delete 3 items" or "Remove"; "Delete" unless given. */
  label?: string;
  /** Small buttons, as in a list's rows. */
  small?: boolean;
  disabled?: boolean;
  onDelete(): void;
}

/** A delete button that asks for confirmation in place before acting. */
export function DeleteButton({ label = t('common.delete'), small, disabled, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false);
  const size = small ? ({ $size: 'small' } as const) : {};
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
        {t('common.cancel')}
      </Button>
    </>
  );
}
