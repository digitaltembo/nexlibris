import type { Item } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { conversionPaths, pathOptions, pathWithOptions } from '@nexlibris/tools/formats/convert/converters';
import { FORMATS, type FormatId } from '@nexlibris/tools/formats/formats';
import { conversionSource, convertItemFile } from '../library/convert';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, SmallSelect, Spacer } from '../styles/ui';
import { ConvertOptions, Field, IndirectNote, pathLabel, useOptionValues } from './ConvertOptions';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';

const ErrorText = styled.p`
  color: var(--danger);
`;

/** Converting from whichever of a book's files is easiest. */
const BEST = '';

interface Props {
  items: Item[];
  onClose(): void;
}

/**
 * Converts the selected books to a format: from one format they have, or, picking the best, from each
 * book's file whose conversion loses least. Books that have the format already, or nothing to make
 * it from, are left as they are. Only the options of the conversions that would run are asked for.
 */
export function BulkConvertDialog({ items, onClose }: Props) {
  const { backend, apply } = useLibrary();
  const [progress, setProgress] = useState<string>();
  const [failures, setFailures] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const count = items.length;

  // Each format the books have that converts to something, with what it reaches.
  const reach = new Map<string, Set<FormatId>>();
  for (const file of items.flatMap((item) => item.files)) {
    if (reach.has(file.format)) continue;
    const targets = new Set(conversionPaths(file.format).keys());
    if (targets.size) reach.set(file.format, targets);
  }
  const ordered = (formats: Set<string>) => (Object.keys(FORMATS) as FormatId[]).filter((f) => formats.has(f));
  const inputs = [...reach.keys()];
  const [from, setFrom] = useState(BEST);
  const input = reach.has(from) ? from : BEST;
  const outputs = ordered(input ? reach.get(input)! : new Set([...reach.values()].flatMap((targets) => [...targets])));
  const [chosen, setChosen] = useState<FormatId>();
  const to = chosen && outputs.includes(chosen) ? chosen : outputs[0];

  const sources = to
    ? items.flatMap((item) => {
        const source = conversionSource(item, to, input || undefined);
        return source ? [{ item, ...source }] : [];
      })
    : [];
  const indirect = sources.filter((s) => s.path.length > 1);
  const fields = pathOptions(sources.flatMap((s) => s.path));
  const [values, setValues] = useOptionValues(fields);

  const convertAll = async () => {
    if (!to) return;
    const failed: string[] = [];
    setRunning(true);
    setFailures([]);
    for (const [n, { item, file, path }] of sources.entries()) {
      setProgress(`Converting ${n + 1} of ${sources.length} to ${formatLabel(to)}…`);
      try {
        await apply([await convertItemFile(backend, item, file, pathWithOptions(path, values))]);
      } catch (e) {
        failed.push(`${item.title}: ${e instanceof Error ? e.message : e}`);
      }
    }
    setRunning(false);
    setFailures(failed);
    setProgress(`Converted ${sources.length - failed.length} to ${formatLabel(to)}.`);
  };

  const paths = new Set(indirect.map((s) => pathLabel(s.file.format, s.path)));
  const books = (n: number) => `${n} book${n === 1 ? '' : 's'}`;

  return (
    <Modal title={`Convert ${books(count)}`} onClose={() => !running && onClose()}>
      {!to ? (
        <Muted as="p">None of these books has a file that can be converted.</Muted>
      ) : (
        <>
          <Field>
            From
            <SmallSelect value={input} disabled={running} onChange={(e) => setFrom(e.target.value)}>
              <option value={BEST}>Pick best (least lost for each book)</option>
              {inputs.map((format) => (
                <option key={format} value={format}>
                  {formatLabel(format)}
                </option>
              ))}
            </SmallSelect>
          </Field>
          <Field>
            To
            <SmallSelect value={to} disabled={running} onChange={(e) => setChosen(e.target.value as FormatId)}>
              {outputs.map((format) => (
                <option key={format} value={format}>
                  {formatLabel(format)}
                </option>
              ))}
            </SmallSelect>
          </Field>
          <Muted as="p">
            {sources.length === 0
              ? `None of these books can be made ${formatLabel(to)}${input ? ` from ${formatLabel(input)}` : ''}, or all have it already.`
              : `${sources.length === count ? `All ${books(count)}` : `${sources.length} of ${books(count)}`} will get a copy in ${formatLabel(to)}; the rest have one already or nothing to make it from.`}
          </Muted>
          {indirect.length > 0 && (
            <IndirectNote>
              {indirect.length === sources.length ? 'Indirect' : `${books(indirect.length)} ${indirect.length === 1 ? 'converts' : 'convert'} indirectly`}
              {paths.size === 1 ? `: ${[...paths][0]}.` : ', by way of other formats.'}
            </IndirectNote>
          )}
          <ConvertOptions fields={fields} values={values} onChange={setValues} disabled={running} />
        </>
      )}
      {progress && (
        <Muted as="p" role="status">
          {progress}
        </Muted>
      )}
      {failures.length > 0 && (
        <ErrorText>
          {failures.length} failed: {failures.join('; ')}
        </ErrorText>
      )}
      <ModalFooter>
        {fields.length > 0 && (
          <Button $variant="secondary" disabled={running} onClick={() => setValues({})}>
            Defaults
          </Button>
        )}
        <Spacer />
        <Button $variant="secondary" disabled={running} onClick={onClose}>
          Done
        </Button>
        <Button disabled={running || sources.length === 0} onClick={() => void convertAll()}>
          Convert {sources.length > 0 && books(sources.length)}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
