import styled, { css, keyframes } from 'styled-components';
import { NARROW } from '../styles/GlobalStyle';
import { Button, Muted } from '../styles/ui';
import { formatSize } from './ItemFiles';
import { t } from '../i18n';

/** Where an import has got to: each phase it can be in, with what's known of it. */
export type ImportProgressState =
  /** The native app's picker is open, or it's listing the folder chosen. */
  | { phase: 'finding' }
  /** Looking through a dropped folder. */
  | { phase: 'reading'; found: number }
  /** The native app copying the chosen files into the library. */
  | { phase: 'copying'; files: number; totalFiles: number; bytes: number; totalBytes: number; current?: string }
  /** Adding the books, counted by book (0 of 0 until they're known), `current` the one being added. */
  | { phase: 'importing'; done: number; total: number; current?: string };

/** A fixed width, so the bar and what's beside it stay put as the counts and file names change. */
const Wrap = styled.span`
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10px;
  width: 540px;
  max-width: 100%;

  ${NARROW} {
    flex-basis: 100%;
    width: auto;
    gap: 6px;
  }
`;

const Text = styled.span`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
  /* Digits all one width, so counts don't jiggle as they go up. */
  font-variant-numeric: tabular-nums;
`;

const Line = styled(Muted)`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Current = styled(Line)`
  font-size: 0.8em;

  ${NARROW} {
    display: none;
  }
`;

const Track = styled.span`
  position: relative;
  flex: none;
  width: 120px;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--border);

  ${NARROW} {
    flex: 1;
    width: auto;
    min-width: 60px;
  }
`;

const sweep = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
`;

/** The filled part; its width is set inline, as it changes often. Without a fraction it sweeps across. */
const Fill = styled.span<{ $sweeping: boolean }>`
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.2s;
  ${(p) =>
    p.$sweeping &&
    css`
      width: 40%;
      animation: ${sweep} 1.2s ease-in-out infinite;

      @media (prefers-reduced-motion: reduce) {
        width: 100%;
        opacity: 0.5;
        animation: none;
      }
    `}
`;

const count = (n: number) => n.toLocaleString();

/** What it says, and how far along it is (0–1, undefined while that isn't known). */
function describe(progress: ImportProgressState): { label: string; detail?: string; fraction?: number } {
  switch (progress.phase) {
    case 'finding':
      return { label: t('importProgress.finding') };
    case 'reading':
      return { label: t('importProgress.reading', { count: progress.found, n: count(progress.found) }) };
    case 'copying': {
      const { files, totalFiles, bytes, totalBytes } = progress;
      return {
        label: t('importProgress.copying', { count: totalFiles, n: count(Math.min(files + 1, totalFiles)), total: count(totalFiles) }),
        detail: totalBytes ? t('importProgress.copied', { done: formatSize(bytes), total: formatSize(totalBytes) }) : undefined,
        // By bytes when the sizes are known: one big file shouldn't look like a stall.
        fraction: totalBytes ? bytes / totalBytes : totalFiles ? files / totalFiles : undefined,
      };
    }
    case 'importing':
      // Until the files are sorted into books, how many there are isn't known.
      if (!progress.total) return { label: t('importProgress.importing') };
      return {
        label: t('importProgress.importingBooks', { count: progress.total, n: count(Math.min(progress.done + 1, progress.total)), total: count(progress.total) }),
        fraction: progress.done / progress.total,
      };
  }
}

/** What an import is doing, in words: for a menu entry standing in for the progress. */
export const importProgressLabel = (progress: ImportProgressState) => describe(progress).label;

interface Props {
  progress: ImportProgressState;
  /** Stops the import; books already added are kept. Without it, there's no Stop button. */
  onStop?(): void;
}

/** An import's progress, for the top bar: what it's doing, a bar, and a Stop button. */
export function ImportProgress({ progress, onStop }: Props) {
  const { label, detail, fraction } = describe(progress);
  const current = 'current' in progress ? progress.current : undefined;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  return (
    <Wrap role="status" aria-live="polite">
      <Track
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== undefined && { 'aria-valuenow': percent })}
      >
        <Fill $sweeping={percent === undefined} style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }} />
      </Track>
      <Text>
        <Line title={detail ? t('importProgress.detail', { label, detail }) : label}>
          {label}
          {detail && `${t('common.list')}${detail}`}
        </Line>
        {current && <Current title={current}>{current.split('/').pop()}</Current>}
      </Text>
      {onStop && (
        <Button $variant="secondary" $size="small" onClick={onStop}>
          {t('importProgress.stop')}
        </Button>
      )}
    </Wrap>
  );
}
