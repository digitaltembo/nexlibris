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
import { isBehind } from '../library/fileMetadata';

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

const ErrorText = styled.span`
  color: var(--danger);
  font-size: 0.85em;
  flex-basis: 100%;
`;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
  if (!blob) throw new Error('The file is missing from the library.');
  const type = isFormatId(file.format) ? FORMATS[file.format].mediaType : blob.type;
  await saveFile(new Blob([blob], { type }), fileName(item, file));
}

/**
 * One file's row: its name (which downloads it), Read, and a menu of the rest (download, show in the
 * file manager, add to a connection, remove, which asks again in the row). Converting is the book's (`ConvertDialog`).
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
  const name = fileName(item, file);

  const attempt = (what: string, task: () => Promise<void>) => async () => {
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError(`Couldn’t ${what} ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const download = attempt('download', () => downloadFile(backend, item, file));
  const show = attempt('show', () => showFileInFolder(file.hash));
  const remove = attempt('remove', async () => void (await removeFiles(backend, apply, [{ item, hashes: [file.hash] }])));

  const actions: MenuAction[] = [
    { label: 'Download', onSelect: () => void download() },
    ...(canShowFiles() && !notDownloaded ? [{ label: 'Show in folder', onSelect: () => void show() }] : []),
    ...(writableConnections(library).length ? [{ label: 'Add to…', onSelect: () => setAdding(true) }] : []),
    { label: 'Remove…', danger: true, onSelect: () => setConfirming(true) },
  ];

  return (
    <FileRow>
      <Name as="button" type="button" title="Download" onClick={() => void download()}>
        {name}
      </Name>
      <Meta>
        {formatLabel(file.format)} · {formatSize(file.size)}
        {file.derivedFrom && ' · converted'}
        {isBehind(item, file) && ' · details older than the library’s'}
        {notDownloaded && ' · not downloaded'}
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
              Remove
            </Button>
            <Button $variant="secondary" $size="small" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {isReadable(file) && (
              <Button $variant="secondary" $size="small" onClick={() => onRead(file)}>
                Read
              </Button>
            )}
            <MenuButton label={`Actions for ${name}`} actions={actions} />
          </>
        )}
      </Actions>
      {error && <ErrorText role="alert">{error}</ErrorText>}
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
        <Muted as="p">No files. This item is cataloged without media.</Muted>
      ) : (
        <Stack as="ul">
          {item.files.map((file) => (
            <FileItem key={file.hash} item={item} file={file} notDownloaded={notDownloaded.has(file.hash)} onRead={onRead} />
          ))}
        </Stack>
      )}
      <FileButton $variant="secondary" $size="small">
        Attach file…
        <input type="file" hidden multiple onChange={(e) => void attach(e.target.files)} />
      </FileButton>
    </>
  );
}

/** The editor's version: files can be detached, and are deleted from storage on save unless another item has them. */
export function EditableFiles({ item, files, onChange }: { item: Item; files: FileRef[]; onChange(files: FileRef[]): void }) {
  if (!files.length) return <Muted as="p">No files.</Muted>;
  return (
    <Stack as="ul">
      {files.map((file) => (
        <FileRow key={file.hash}>
          <Name>{fileName(item, file)}</Name>
          <Meta>
            {formatLabel(file.format)} · {formatSize(file.size)}
          </Meta>
          <DetachButton
            $variant="icon"
            aria-label={`Detach ${fileName(item, file)}`}
            onClick={() => onChange(files.filter((f) => f.hash !== file.hash))}
          >
            ×
          </DetachButton>
        </FileRow>
      ))}
    </Stack>
  );
}
