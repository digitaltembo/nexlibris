import type { Item } from '@nexlibris/common';
import { pathOptions, pathWithOptions } from '@nexlibris/tools/formats/convert/converters';
import { useState } from 'react';
import styled from 'styled-components';
import { availableConversions, convertItemFile } from '../library/convert';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, SmallSelect, Spacer } from '../styles/ui';
import { ConvertOptions, Field, IndirectNote, pathLabel, useOptionValues } from './ConvertOptions';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';

const ErrorText = styled.p`
  color: var(--danger);
`;

/** The book's files that convert to something, with what each makes. */
export function convertibleFiles(item: Item) {
  return item.files.map((file) => ({ file, targets: availableConversions(item, file) })).filter((s) => s.targets.size > 0);
}

/**
 * Converting a book: which of its files to convert from (by format, with the file's name where two
 * share one), the format to make (any the conversions reach, by way of others if need be, which it
 * warns of), and the options of the conversions that would run. The result is kept beside the source.
 */
export function ConvertDialog({ item, onClose }: { item: Item; onClose(): void }) {
  const { backend, apply } = useLibrary();
  const sources = convertibleFiles(item);
  const [hash, setHash] = useState(sources[0]?.file.hash);
  const source = sources.find((s) => s.file.hash === hash) ?? sources[0];
  const targets = source ? [...source.targets] : [];
  const [to, setTo] = useState<string>();
  const [target, path] = targets.find(([format]) => format === to) ?? targets[0] ?? [];
  const fields = path ? pathOptions(path) : [];
  const [values, setValues] = useOptionValues(fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const sourceLabel = (s: (typeof sources)[number]) =>
    sources.filter((other) => other.file.format === s.file.format).length > 1
      ? `${formatLabel(s.file.format)} (${s.file.name ?? s.file.hash.slice(0, 8)})`
      : formatLabel(s.file.format);

  const convert = async () => {
    if (!source || !path) return;
    setBusy(true);
    setError(undefined);
    try {
      await apply([await convertItemFile(backend, item, source.file, pathWithOptions(path, values))]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Convert ${item.title}`} onClose={() => !busy && onClose()}>
      {!source || !path ? (
        <Muted as="p">None of this book’s files can be converted to anything it lacks.</Muted>
      ) : (
        <>
          <Field>
            From
            <SmallSelect value={source.file.hash} disabled={busy} onChange={(e) => setHash(e.target.value)}>
              {sources.map((s) => (
                <option key={s.file.hash} value={s.file.hash}>
                  {sourceLabel(s)}
                </option>
              ))}
            </SmallSelect>
          </Field>
          <Field>
            To
            <SmallSelect value={target} disabled={busy} onChange={(e) => setTo(e.target.value)}>
              {targets.map(([format, steps]) => (
                <option key={format} value={format}>
                  {`${formatLabel(format)}${steps.length > 1 ? ' (indirect)' : ''}`}
                </option>
              ))}
            </SmallSelect>
          </Field>
          {path.length > 1 && <IndirectNote>An indirect conversion: {pathLabel(source.file.format, path)}.</IndirectNote>}
          <ConvertOptions fields={fields} values={values} onChange={setValues} disabled={busy} />
        </>
      )}
      {busy && (
        <Muted as="p" role="status">
          Converting…
        </Muted>
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <ModalFooter>
        {fields.length > 0 && (
          <Button $variant="secondary" disabled={busy} onClick={() => setValues({})}>
            Defaults
          </Button>
        )}
        <Spacer />
        <Button $variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !path} onClick={() => void convert()}>
          Convert
        </Button>
      </ModalFooter>
    </Modal>
  );
}
