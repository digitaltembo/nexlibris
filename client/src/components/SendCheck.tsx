import type { Device, Item } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { checkSend, type SendCheck } from '../devices/send';
import type { ConnectionType } from '../devices/types';
import { pathOptions, pathWithOptions } from '@nexlibris/tools/formats/convert/converters';
import { useTextIndex } from '../fulltext/TextIndexContext';
import { convertItemFile } from '../library/convert';
import { useLibrary } from '../library/LibraryContext';
import { updateFiles } from '../library/updateFiles';
import { Button, Muted, Spacer } from '../styles/ui';
import { ConvertOptions, useOptionValues } from './ConvertOptions';
import { formatLabel } from './ItemFiles';
import { ModalFooter } from './Modal';

const Choice = styled.label`
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 12px;
`;

const List = styled.ul`
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: 0.9rem;
`;

const ErrorText = styled.p`
  margin: 12px 0 0;
  color: var(--danger);
`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const SHOWN = 8;

/** A few titles, then how many more. */
function Titles({ items }: { items: Item[] }) {
  return (
    <List>
      {items.slice(0, SHOWN).map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
      {items.length > SHOWN && <li>and {items.length - SHOWN} more</li>}
    </List>
  );
}

/**
 * Asked before books go to a connection (`devices/send.ts`): whether to first make the format it
 * prefers for those without it, and bring files whose details are behind the library's up to date.
 * Both happen in the library, before anything is sent; or the books are sent as they are.
 * `onContinue` is called once that's done, or straight away if there's nothing to ask.
 */
export function SendCheckStep({
  device,
  type,
  check,
  onContinue,
  onCancel,
}: {
  device: Device;
  type: ConnectionType;
  check: SendCheck;
  onContinue(): void;
  onCancel(): void;
}) {
  const { backend, apply } = useLibrary();
  const { index: textIndex } = useTextIndex();
  const [convert, setConvert] = useState(check.convertible.length > 0);
  const [update, setUpdate] = useState(check.behind.length > 0);
  const fields = pathOptions(check.convertible.flatMap((c) => c.path));
  const [values, setValues] = useOptionValues(fields);
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
  const formats = [...new Set(check.convertible.map((c) => c.path.at(-1)!.to))].map(formatLabel).join(' or ');

  const run = async () => {
    setError(undefined);
    try {
      if (update && check.behind.length) {
        setWorking('Updating files…');
        const result = await updateFiles(backend, check.behind, apply, { carryText: (from, to) => textIndex.carry(from, to) });
        if (result.failed.length) throw new Error(result.failed.map((f) => `${f.title}: ${f.message}`).join('; '));
      }
      if (convert) {
        for (const [i, { item }] of check.convertible.entries()) {
          setWorking(`Converting ${item.title} (${i + 1} of ${check.convertible.length})…`);
          // The item as it is now: updating may have replaced the file it's made from.
          const current = (await backend.getLibrary()).items[item.id];
          const source = current && checkSend(await backend.getLibrary(), device, type, [current]).convertible[0];
          if (!current || !source) continue;
          await apply([await convertItemFile(backend, current, source.file, pathWithOptions(source.path, values))]);
        }
      }
      onContinue();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking(undefined);
    }
  };

  return (
    <>
      {check.convertible.length > 0 && (
        <>
          <Choice>
            <input type="checkbox" checked={convert} disabled={!!working} onChange={(e) => setConvert(e.target.checked)} />
            <span>
              {plural(check.convertible.length, 'book')} {check.convertible.length === 1 ? 'has' : 'have'} no {formats}, which{' '}
              {device.name} prefers. Convert {check.convertible.length === 1 ? 'it' : 'them'} first (kept in the library)?
            </span>
          </Choice>
          <Titles items={check.convertible.map((c) => c.item)} />
          {convert && fields.length > 0 && <ConvertOptions fields={fields} values={values} onChange={setValues} disabled={!!working} />}
        </>
      )}
      {check.behind.length > 0 && (
        <>
          <Choice>
            <input type="checkbox" checked={update} disabled={!!working} onChange={(e) => setUpdate(e.target.checked)} />
            <span>
              {plural(check.behind.length, 'file')} to send {check.behind.length === 1 ? 'has' : 'have'} older details than the
              library’s. Write the library’s into {check.behind.length === 1 ? 'it' : 'them'} first?
            </span>
          </Choice>
          <Titles items={[...new Map(check.behind.map((b) => [b.item.id, b.item])).values()]} />
        </>
      )}
      {check.unsendable.length > 0 && (
        <Muted as="p">
          Not sent, with no file {device.name} takes: {check.unsendable.slice(0, SHOWN).map((i) => i.title).join(', ')}
          {check.unsendable.length > SHOWN && ` and ${check.unsendable.length - SHOWN} more`}.
        </Muted>
      )}
      {working && <p role="status">{working}</p>}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <ModalFooter>
        <Button $variant="secondary" disabled={!!working} onClick={onCancel}>
          Cancel
        </Button>
        <Spacer />
        <Button $variant="secondary" disabled={!!working} onClick={onContinue}>
          Send as they are
        </Button>
        <Button disabled={!!working || (!convert && !update)} onClick={() => void run()}>
          {convert && update ? 'Convert, update and send' : convert ? 'Convert and send' : 'Update and send'}
        </Button>
      </ModalFooter>
    </>
  );
}
