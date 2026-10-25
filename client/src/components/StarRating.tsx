import styled from 'styled-components';
import { t } from '../i18n';

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
    return <Stars aria-label={t('starRating.stars', { value })}>{'★'.repeat(Math.round(value))}</Stars>;
  }
  return (
    <Stars role="radiogroup" aria-label={t('starRating.label')}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          role="radio"
          aria-checked={value === n}
          aria-label={t('starRating.star', { count: n })}
          $on={value !== undefined && n <= value}
          onClick={() => onChange(value === n ? undefined : n)}
        >
          ★
        </Star>
      ))}
    </Stars>
  );
}
