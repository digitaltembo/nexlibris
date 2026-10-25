import { useCallback, useEffect, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { FileButton, Muted } from '../../../styles/ui';
import type { CrossPointTarget } from '../client';
import { t } from '../../../i18n';

/** A reader tool's props: the reader, reached by its connection's address. */
export interface ToolProps {
  reader: CrossPointTarget;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? t('common.megabytes', { count: (bytes / 1024 / 1024).toFixed(1) })
    : t('common.kilobytes', { count: Math.max(1, Math.round(bytes / 1024)) });

/**
 * What a tool reads from the reader, loaded on opening and again after changes, and the work it's
 * doing (one thing at a time, with progress in words). `reload` reads again.
 */
export function useReaderState<T>(read: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const reload = useCallback(async () => {
    setError(undefined);
    try {
      setData(await read());
    } catch (e) {
      setError(errorMessage(e));
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- read is the tool's, fixed for its life
  }, []);
  // oxlint-disable-next-line react/set-state-in-effect -- loads once, on opening
  useEffect(() => void reload(), [reload]);

  /** Runs some work, saying what it's doing, then reads the reader again. */
  const run = async (label: string, work: (say: (text: string) => void) => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await work(setBusy);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
      await reload();
    }
  };
  return { data, error, busy, run, reload, setError };
}

/** Picked files, with their folders when a folder was picked. */
export const pickedFiles = (list: FileList | null) =>
  Array.from(list ?? []).map((file) => ({ path: file.webkitRelativePath || file.name, data: file as Blob, name: file.name }));

/** A button that picks files, or a whole folder. */
export function PickButton({
  children,
  accept,
  folder,
  disabled,
  onPick,
}: {
  children: ReactNode;
  accept?: string;
  folder?: boolean;
  disabled?: boolean;
  onPick(files: ReturnType<typeof pickedFiles>): void;
}) {
  return (
    <FileButton $variant="secondary" $size="small" aria-disabled={disabled} style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      {children}
      <input
        type="file"
        hidden
        multiple
        {...(accept && { accept })}
        ref={(input) => {
          // Not a React prop: picks a folder, whose files come with their paths.
          if (input) input.webkitdirectory = !!folder;
        }}
        onChange={(e) => {
          onPick(pickedFiles(e.target.files));
          e.target.value = '';
        }}
      />
    </FileButton>
  );
}

export const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 12px 0 4px;
`;

export const Rows = styled.ul`
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 0;
    border-top: 1px solid var(--soft-border);
  }

  li > div {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  small {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
`;

export const Note = styled(Muted).attrs({ as: 'p' })`
  margin: 8px 0;
  font-size: 0.9em;
`;

export const Problem = styled.p`
  margin: 8px 0;
  color: var(--danger);
`;

/** What's going on, or what went wrong. */
export function Status({ busy, error, problems }: { busy?: string | undefined; error?: string | undefined; problems?: string[] }) {
  return (
    <>
      {busy && <Note role="status">{busy}</Note>}
      {error && <Problem role="alert">{error}</Problem>}
      {problems && problems.length > 0 && (
        <Problem role="alert" as="ul">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </Problem>
      )}
    </>
  );
}
