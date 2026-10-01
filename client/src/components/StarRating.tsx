import styled from 'styled-components';

interface Props {
  value: number | undefined;
  /** Omit for a read-only display. Clicking the current rating clears it. */
  onChange?: (rating: number | undefined) => void;
}

const Stars = styled.span`
  color: var(--star);
  letter-spacing: 1px;
`;

const Star = styled.button.attrs({ type: 'button' })<{ $on: boolean }>`
  background: none;
  border: none;
  padding: 0 1px;
  font-size: 1.3em;
  color: ${(p) => (p.$on ? 'var(--star)' : 'var(--border)')};
`;

export function StarRating({ value, onChange }: Props) {
  if (!onChange) {
    if (value === undefined) return null;
    return <Stars aria-label={`${value} of 5 stars`}>{'★'.repeat(Math.round(value))}</Stars>;
  }
  return (
    <Stars role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          $on={value !== undefined && n <= value}
          onClick={() => onChange(value === n ? undefined : n)}
        >
          ★
        </Star>
      ))}
    </Stars>
  );
}
