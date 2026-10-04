import { readPairings, type FileRef, type Item } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { FORMATS, formatFromName, isFormatId } from '../formats/formats';
import { availableConversions, convertItemFile } from '../library/convert';
import { useLibrary } from '../library/LibraryContext';
import { saveFile } from '../library/saveFile';
import { isReadable } from '../reader/Reader';
import { Button, FileButton, Muted, SmallSelect, Stack } from '../styles/ui';
import { onFileFetched } from '../sync/files';
import { canSync } from '../sync/connect';

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
 * Saves the file when clicked. It's only read then: reading every format up
 * front, to have download URLs ready, made opening a big book's details slow.
 */
function DownloadLink({ item, file }: { item: Item; file: FileRef }) {
  const { backend } = useLibrary();
  const [error, setError] = useState<string>();
  const download = async () => {
    setError(undefined);
    try {
      const blob = await backend.getFile(file.hash);
      if (!blob) throw new Error('The file is missing from the library.');
      const type = isFormatId(file.format) ? FORMATS[file.format].mediaType : blob.type;
      await saveFile(new Blob([blob], { type }), fileName(item, file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <Name as="button" type="button" title="Download" onClick={() => void download()}>
        {fileName(item, file)}
      </Name>
      {error && <Meta role="alert">{error}</Meta>}
    </>
  );
}

function ConvertMenu({ item, file }: { item: Item; file: FileRef }) {
  const { backend, apply } = useLibrary();
  const [status, setStatus] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const conversions = availableConversions(item, file);
  if (!conversions.length) return null;

  const convert = async (id: string) => {
    const converter = conversions.find((c) => c.id === id);
    if (!converter) return;
    setStatus({ busy: true });
    try {
      await apply([await convertItemFile(backend, item, file, converter)]);
      setStatus({ busy: false });
    } catch (e) {
      setStatus({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <SmallSelect
        aria-label={`Convert ${fileName(item, file)}`}
        value=""
        disabled={status.busy}
        onChange={(e) => void convert(e.target.value)}
      >
        <option value="">{status.busy ? 'Converting…' : 'Convert…'}</option>
        {conversions.map((c) => (
          <option key={c.id} value={c.id}>
            to {formatLabel(c.to)}
          </option>
        ))}
      </SmallSelect>
      {status.error && <ErrorText>{status.error}</ErrorText>}
    </>
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

/** An item's files, with reading, downloading, converting and attaching (none of which need edit mode). */
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
            <FileRow key={file.hash}>
              <DownloadLink item={item} file={file} />
              <Meta>
                {formatLabel(file.format)} · {formatSize(file.size)}
                {file.derivedFrom && ' · converted'}
                {notDownloaded.has(file.hash) && ' · not downloaded'}
              </Meta>
              <Actions>
                {isReadable(file) && (
                  <Button $variant="secondary" $size="small" onClick={() => onRead(file)}>
                    Read
                  </Button>
                )}
                <ConvertMenu item={item} file={file} />
              </Actions>
            </FileRow>
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

/** The editor's version: files can be detached (on save). */
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
