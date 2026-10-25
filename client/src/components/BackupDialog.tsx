import { useState } from 'react';
import styled from 'styled-components';
import { backupFileName, exportLibrary, restoreLibrary, type Backup, type RestoreResult } from '../library/backup';
import { useLibrary } from '../library/LibraryContext';
import { saveParts } from '../library/saveFile';
import { Button, FileButton, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';
import { t } from '../i18n';

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

const megabytes = (bytes: number) => t('common.megabytes', { count: Math.round(bytes / 1e6) });


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
        setExported(t('backup.notSaved'));
        return;
      }
      const missing = backup?.missing ?? [];
      setExported(
        missing.length
          ? t('backup.savedMissing', { count: missing.length })
          : t('backup.saved'),
      );
    });

  const runRestore = (file: File) =>
    run('restoring', async () => {
      setRestored(await restoreLibrary(backend, file));
      await refresh();
    });

  const items = Object.keys(library.items).length;

  return (
    <Modal title={t('backup.title')} onClose={busy ? () => undefined : onClose}>
      <Section>
        <h3>{t('backup.backUp')}</h3>
        <Muted as="p">
          {t('backup.explain', { count: items })}
        </Muted>
        <Button disabled={busy !== undefined || items === 0} onClick={() => void runExport()}>
          {busy !== 'exporting'
            ? t('backup.save')
            : progress
              ? t('backup.saving', { files: progress.files, total: progress.total, size: megabytes(progress.bytes) })
              : t('backup.preparing')}
        </Button>
        {exported && <Muted as="p">{exported}</Muted>}
      </Section>

      <Section>
        <h3>{t('backup.restore')}</h3>
        <Muted as="p">
          {t('backup.restoreExplain')}
        </Muted>
        <FileButton $variant="secondary" aria-disabled={busy !== undefined}>
          {busy === 'restoring' ? t('backup.restoring') : t('backup.choose')}
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
              {t('backup.restored', { count: restored.added.length })}
              {restored.skipped.length > 0 && t('backup.alreadyIn', { count: restored.skipped.length })}
              {t('backup.end')}
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
          {t('common.close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
