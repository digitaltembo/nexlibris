import { readPairings, type FileRef, type Item, type LibraryBackend } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { FORMATS, formatFromName, isFormatId } from '@nexlibris/tools/formats/formats';
import { removeFiles } from '../library/freeFiles';
import { useLibrary } from '../library/LibraryContext';
import { canShowFiles, showFileInFolder } from '../library/libraryFolder';
import { saveFile } from '../library/saveFile';
import { isReadable } from '../reader/Reader';
import { Button, FileButton, Muted, Stack } from '../styles/ui';
import { onFileFetched } from '../sync/files';
import { canSync } from '../sync/connect';
import { MenuButton, type MenuAction } from './MenuButton';
import { AddTo } from './AddTo';
import { writableConnections } from './SendTo';
import { canWriteMetadata, isBehind } from '../library/fileMetadata';
import { updateFiles } from '../library/updateFiles';
import { useOptionalTextIndex } from '../fulltext/TextIndexContext';
import { t } from '../i18n';

const FileRow = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
`;

const Name = styled.span`
  flex: 1 1 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:is(button) {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    color: var(--accent);
    cursor: pointer;
  }
`;

const Meta = styled(Muted)`
  font-size: 0.85em;
`;

const Actions = styled.span`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
`;

const DetachButton = styled(Button)`
  margin-left: auto;
`;

const Note = styled(Muted)`
  font-size: 0.85em;
  flex-basis: 100%;
`;

const ErrorText = styled.span`
  color: var(--danger);
  font-size: 0.85em;
  flex-basis: 100%;
`;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('size.bytes', { count: bytes });
  if (bytes < 1024 * 1024) return t('size.kilobytes', { count: (bytes / 1024).toFixed(0) });
  if (bytes < 1024 * 1024 * 1024) return t('size.megabytes', { count: (bytes / 1024 / 1024).toFixed(1) });
  return t('size.gigabytes', { count: (bytes / 1024 / 1024 / 1024).toFixed(2) });
}

export const formatLabel = (format: string) => (isFormatId(format) ? FORMATS[format].label : format.toUpperCase());

function fileName(item: Item, file: FileRef) {
  return file.name ?? `${item.title}.${file.format}`;
}

/**
 * Saves the file. It's only read then: reading every format up front, to have download URLs
 * ready, made opening a big book's details slow.
 */
async function downloadFile(backend: LibraryBackend, item: Item, file: FileRef) {
  const blob = await backend.getFile(file.hash);
  if (!blob) throw new Error(t('itemFiles.missing'));
  const type = isFormatId(file.format) ? FORMATS[file.format].mediaType : blob.type;
  await saveFile(new Blob([blob], { type }), fileName(item, file));
}

/**
 * One file's row: its name (which downloads it), Read, and a menu of the rest (download, show in the
 * file manager, add to a connection, write the library's metadata into it as Clean up's "Update book files" does,
 * remove, which asks again in the row). Converting is the book's (`ConvertDialog`).
 */
function FileItem({ item, file, notDownloaded, onRead }: {
  item: Item;
  file: FileRef;
  notDownloaded: boolean;
  onRead(file: FileRef): void;
}) {
  const { backend, apply, library } = useLibrary();
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const text = useOptionalTextIndex();
  const name = fileName(item, file);

  const attempt = (what: 'download' | 'show' | 'update' | 'remove', task: () => Promise<void>) => async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (e) {
      setError(t(`itemFiles.failed.${what}`, { name, message: e instanceof Error ? e.message : String(e) }));
    }
  };
  const download = attempt('download', () => downloadFile(backend, item, file));
  const show = attempt('show', () => showFileInFolder(file.hash));
  // Written, checked and swapped in as the cleanup does; the row is then the new file's.
  const updateMetadata = attempt('update', async () => {
    setUpdating(true);
    const resume = text?.pause();
    try {
      const result = await updateFiles(backend, [{ item, file, changes: [] }], apply, {
        ...(text && { carryText: (from, to) => text.index.carry(from, to) }),
      });
      if (result.failed[0]) throw new Error(result.failed[0].message);
      if (!result.updated) setNotice(t('itemFiles.upToDate'));
    } finally {
      resume?.();
      setUpdating(false);
    }
  });
  const remove = attempt('remove', async () => void (await removeFiles(backend, apply, [{ item, hashes: [file.hash] }])));

  const actions: MenuAction[] = [
    { label: t('itemFiles.download'), onSelect: () => void download() },
    ...(canShowFiles() && !notDownloaded ? [{ label: t('itemFiles.show'), onSelect: () => void show() }] : []),
    ...(writableConnections(library).length ? [{ label: t('itemFiles.addTo'), onSelect: () => setAdding(true) }] : []),
    ...(canWriteMetadata(file) && !notDownloaded
      ? [{ label: updating ? t('itemFiles.updating') : t('itemFiles.update'), disabled: updating, onSelect: () => void updateMetadata() }]
      : []),
    { label: t('itemFiles.remove'), danger: true, onSelect: () => setConfirming(true) },
  ];

  return (
    <FileRow>
      <Name as="button" type="button" title={t('itemFiles.download')} onClick={() => void download()}>
        {name}
      </Name>
      <Meta>
        {t('itemFiles.meta', { format: formatLabel(file.format), size: formatSize(file.size) })}
        {file.derivedFrom && t('itemFiles.converted')}
        {isBehind(item, file) && t('itemFiles.behind')}
        {notDownloaded && t('itemFiles.notDownloaded')}
      </Meta>
      <Actions>
        {confirming ? (
          <>
            <Button
              $variant="danger"
              $size="small"
              autoFocus
              onClick={() => {
                setConfirming(false);
                void remove();
              }}
            >
              {t('itemFiles.removeConfirm')}
            </Button>
            <Button $variant="secondary" $size="small" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            {isReadable(file) && (
              <Button $variant="secondary" $size="small" onClick={() => onRead(file)}>
                {t('itemFiles.read')}
              </Button>
            )}
            <MenuButton label={t('itemFiles.actions', { name })} actions={actions} />
          </>
        )}
      </Actions>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {notice && <Note role="status">{notice}</Note>}
      {adding && <AddTo items={[item]} file={file} onClose={() => setAdding(false)} />}
    </FileRow>
  );
}

/**
 * Which of these files aren't stored here, in an instance paired with a hub: they're on the hub,
 * and fetched when opened (checked again as files arrive).
 */
function useNotDownloaded(files: FileRef[]): Set<string> {
  const { backend } = useLibrary();
  const [missing, setMissing] = useState(new Set<string>());
  const hashes = files.map((file) => file.hash).join(' ');
  useEffect(() => {
    if (!canSync() || !hashes) return;
    let cancelled = false;
    const list = hashes.split(' ');
    const check = async () => {
      if (!(await readPairings(backend)).length) return;
      const stored = await Promise.all(list.map((hash) => backend.hasFile(hash)));
      if (!cancelled) setMissing(new Set(list.filter((_, i) => !stored[i])));
    };
    void check();
    const unsubscribe = onFileFetched(() => void check());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [backend, hashes]);
  return missing;
}

/**
 * An item's files, with reading, downloading, showing where they are (in the desktop
 * app; all but reading in each file's menu), attaching and removing (none of which need edit mode). Removing a file deletes it from the library's storage unless another item has it.
 */
export function ItemFiles({ item, onRead }: { item: Item; onRead(file: FileRef): void }) {
  const { backend, apply } = useLibrary();
  const notDownloaded = useNotDownloaded(item.files);

  const attach = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const { hash, size } = await backend.putFile(file);
      const format = formatFromName(file.name) ?? file.name.split('.').pop()?.toLowerCase() ?? 'bin';
      await apply([{ type: 'attachFile', id: item.id, file: { hash, size, format, name: file.name } }]);
    }
  };

  return (
    <>
      {item.files.length === 0 ? (
        <Muted as="p">{t('itemFiles.none')}</Muted>
      ) : (
        <Stack as="ul">
          {item.files.map((file) => (
            <FileItem key={file.hash} item={item} file={file} notDownloaded={notDownloaded.has(file.hash)} onRead={onRead} />
          ))}
        </Stack>
      )}
      <FileButton $variant="secondary" $size="small">
        {t('itemFiles.attach')}
        <input type="file" hidden multiple onChange={(e) => void attach(e.target.files)} />
      </FileButton>
    </>
  );
}

/** The editor's version: files can be detached, and are deleted from storage on save unless another item has them. */
export function EditableFiles({ item, files, onChange }: { item: Item; files: FileRef[]; onChange(files: FileRef[]): void }) {
  if (!files.length) return <Muted as="p">{t('itemFiles.noFiles')}</Muted>;
  return (
    <Stack as="ul">
      {files.map((file) => (
        <FileRow key={file.hash}>
          <Name>{fileName(item, file)}</Name>
          <Meta>
            {t('itemFiles.meta', { format: formatLabel(file.format), size: formatSize(file.size) })}
          </Meta>
          <DetachButton
            $variant="icon"
            aria-label={t('itemFiles.detach', { name: fileName(item, file) })}
            onClick={() => onChange(files.filter((f) => f.hash !== file.hash))}
          >
            ×
          </DetachButton>
        </FileRow>
      ))}
    </Stack>
  );
}
