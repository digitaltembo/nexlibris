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
import { t } from '../i18n';

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
      setProgress(t('bulkConvert.converting', { n: n + 1, total: sources.length, format: formatLabel(to) }));
      try {
        await apply([await convertItemFile(backend, item, file, pathWithOptions(path, values))]);
      } catch (e) {
        failed.push(t('bulkConvert.failure', { title: item.title, message: e instanceof Error ? e.message : String(e) }));
      }
    }
    setRunning(false);
    setFailures(failed);
    setProgress(t('bulkConvert.converted', { count: sources.length - failed.length, format: formatLabel(to) }));
  };

  const paths = new Set(indirect.map((s) => pathLabel(s.file.format, s.path)));
  const books = (n: number) => t('common.books', { count: n });

  return (
    <Modal title={t('bulkConvert.title', { books: books(count) })} onClose={() => !running && onClose()}>
      {!to ? (
        <Muted as="p">{t('bulkConvert.nothing')}</Muted>
      ) : (
        <>
          <Field>
            {t('convertDialog.from')}
            <SmallSelect value={input} disabled={running} onChange={(e) => setFrom(e.target.value)}>
              <option value={BEST}>{t('bulkConvert.pickBest')}</option>
              {inputs.map((format) => (
                <option key={format} value={format}>
                  {formatLabel(format)}
                </option>
              ))}
            </SmallSelect>
          </Field>
          <Field>
            {t('convertDialog.to')}
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
              ? input
                ? t('bulkConvert.noneFrom', { format: formatLabel(to), from: formatLabel(input) })
                : t('bulkConvert.none', { format: formatLabel(to) })
              : sources.length === count
                ? t('bulkConvert.all', { books: books(count), format: formatLabel(to) })
                : t('bulkConvert.some', { count: sources.length, books: books(count), format: formatLabel(to) })}
          </Muted>
          {indirect.length > 0 && (
            <IndirectNote>
              {indirect.length === sources.length ? t('bulkConvert.indirectAll') : t('bulkConvert.indirectSome', { count: indirect.length })}
              {paths.size === 1 ? t('bulkConvert.indirectPath', { path: [...paths][0] }) : t('bulkConvert.indirectOther')}
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
          {t('bulkConvert.failed', { count: failures.length, failures: failures.join(t('bulkConvert.failureSeparator')) })}
        </ErrorText>
      )}
      <ModalFooter>
        {fields.length > 0 && (
          <Button $variant="secondary" disabled={running} onClick={() => setValues({})}>
            {t('convertDialog.defaults')}
          </Button>
        )}
        <Spacer />
        <Button $variant="secondary" disabled={running} onClick={onClose}>
          {t('common.done')}
        </Button>
        <Button disabled={running || sources.length === 0} onClick={() => void convertAll()}>
          {sources.length > 0 ? t('bulkConvert.convertBooks', { books: books(sources.length) }) : t('bulkConvert.convert')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
