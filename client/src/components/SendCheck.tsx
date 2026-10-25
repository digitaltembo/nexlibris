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
import { t } from '../i18n';

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

const SHOWN = 8;

/** A few titles, then how many more. */
function Titles({ items }: { items: Item[] }) {
  return (
    <List>
      {items.slice(0, SHOWN).map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
      {items.length > SHOWN && <li>{t('common.andMore', { count: items.length - SHOWN })}</li>}
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
  const formats = [...new Set(check.convertible.map((c) => c.path.at(-1)!.to))].map(formatLabel).join(t('common.or'));

  const run = async () => {
    setError(undefined);
    try {
      if (update && check.behind.length) {
        setWorking(t('sendCheck.updating'));
        const result = await updateFiles(backend, check.behind, apply, { carryText: (from, to) => textIndex.carry(from, to) });
        if (result.failed.length) throw new Error(result.failed.map((f) => t('sendCheck.failure', f)).join(t('sendCheck.failureSeparator')));
      }
      if (convert) {
        for (const [i, { item }] of check.convertible.entries()) {
          setWorking(t('sendCheck.converting', { title: item.title, n: i + 1, total: check.convertible.length }));
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
              {t('sendCheck.convert', { count: check.convertible.length, formats, device: device.name })}
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
              {t('sendCheck.behind', { count: check.behind.length })}
            </span>
          </Choice>
          <Titles items={[...new Map(check.behind.map((b) => [b.item.id, b.item])).values()]} />
        </>
      )}
      {check.unsendable.length > 0 && (
        <Muted as="p">
          {t('sendCheck.unsendable', { device: device.name, titles: check.unsendable.slice(0, SHOWN).map((i) => i.title).join(t('common.listJoin')) })}
          {check.unsendable.length > SHOWN && t('sendCheck.unsendableMore', { count: check.unsendable.length - SHOWN })}
          {t('sendCheck.end')}
        </Muted>
      )}
      {working && <p role="status">{working}</p>}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <ModalFooter>
        <Button $variant="secondary" disabled={!!working} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Spacer />
        <Button $variant="secondary" disabled={!!working} onClick={onContinue}>
          {t('sendCheck.asTheyAre')}
        </Button>
        <Button disabled={!!working || (!convert && !update)} onClick={() => void run()}>
          {convert && update ? t('sendCheck.convertUpdateSend') : convert ? t('sendCheck.convertSend') : t('sendCheck.updateSend')}
        </Button>
      </ModalFooter>
    </>
  );
}
