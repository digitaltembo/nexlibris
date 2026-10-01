import { useState } from 'react';
import styled from 'styled-components';
import { backupFileName, exportLibrary, restoreLibrary, type Backup, type RestoreResult } from '../library/backup';
import { useLibrary } from '../library/LibraryContext';
import { saveParts } from '../library/saveFile';
import { Button, FileButton, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const Section = styled.section`
  margin-top: 16px;

  h3 {
    margin: 0 0 4px;
    font-size: 1rem;
  }

  p {
    margin: 0 0 8px;
  }

  ul {
    margin: 8px 0 0;
    padding-left: 20px;
    font-size: 0.9rem;
  }
`;

const ErrorText = styled.p`
  margin: 16px 0 0;
  color: var(--danger);
`;

type Busy = 'exporting' | 'restoring' | undefined;

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Backing up the whole library to a zip, and restoring one into it. */
export function BackupDialog({ onClose }: { onClose(): void }) {
  const { backend, library, refresh } = useLibrary();
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [exported, setExported] = useState<string>();
  const [restored, setRestored] = useState<RestoreResult>();
  /** Files and bytes saved so far, while a backup is saved. */
  const [progress, setProgress] = useState<{ files: number; total: number; bytes: number }>();

  const run = async (kind: NonNullable<Busy>, task: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const runExport = () =>
    run('exporting', async () => {
      const now = new Date();
      let backup: Backup | undefined;
      // Nothing is awaited before saveParts: a browser only shows its save picker straight after the click.
      const saved = await saveParts(
        backupFileName(library, now),
        () =>
          (async function* () {
            backup = await exportLibrary(backend, now, (files) => setProgress((p) => p && { ...p, files }));
            setProgress({ files: 0, total: backup.fileCount, bytes: 0 });
            yield* backup.parts;
          })(),
        {
          mimeType: 'application/zip',
          onProgress: (bytes) => setProgress((p) => p && { ...p, bytes }),
        },
      ).finally(() => setProgress(undefined));
      if (!saved) {
        setExported('Not saved.');
        return;
      }
      const missing = backup?.missing ?? [];
      setExported(
        missing.length
          ? `Saved, but ${plural(missing.length, 'file')} the library refers to could not be found and ${missing.length === 1 ? 'is' : 'are'} not included.`
          : 'Saved.',
      );
    });

  const runRestore = (file: File) =>
    run('restoring', async () => {
      setRestored(await restoreLibrary(backend, file));
      await refresh();
    });

  const items = Object.keys(library.items).length;

  return (
    <Modal title="Backup" onClose={busy ? () => undefined : onClose}>
      <Section>
        <h3>Back up</h3>
        <Muted as="p">
          Saves all {plural(items, 'item')}, with their files, covers, ratings, reviews and reading positions, as one zip file.
        </Muted>
        <Button disabled={busy !== undefined || items === 0} onClick={() => void runExport()}>
          {busy !== 'exporting'
            ? 'Save backup'
            : progress
              ? `Saving… file ${progress.files} of ${progress.total}, ${megabytes(progress.bytes)}`
              : 'Preparing…'}
        </Button>
        {exported && <Muted as="p">{exported}</Muted>}
      </Section>

      <Section>
        <h3>Restore</h3>
        <Muted as="p">
          Adds the items from a backup that aren’t already in this library. Nothing here is changed or removed.
        </Muted>
        <FileButton $variant="secondary" aria-disabled={busy !== undefined}>
          {busy === 'restoring' ? 'Restoring…' : 'Choose backup…'}
          <input
            type="file"
            accept=".zip,application/zip"
            hidden
            disabled={busy !== undefined}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void runRestore(file);
            }}
          />
        </FileButton>
        {restored && (
          <>
            <Muted as="p">
              Restored {plural(restored.added.length, 'item')}
              {restored.skipped.length > 0 && `; ${restored.skipped.length} already in the library`}.
            </Muted>
            {restored.warnings.length > 0 && (
              <ul>
                {restored.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      {error && <ErrorText role="alert">{error}</ErrorText>}

      <ModalFooter>
        <Spacer />
        <Button $variant="secondary" disabled={busy !== undefined} onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
