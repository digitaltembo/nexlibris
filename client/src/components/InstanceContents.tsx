import { peerOffer, requestFromPeer, type Device, type Item, type ItemId, type Pairing } from '@nexlibris/common';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Spacer, Stack } from '../styles/ui';
import { connectHub } from '../sync/connect';
import { Modal, ModalFooter } from './Modal';
import { t } from '../i18n';

const BookRow = styled.li`
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 0;
  border-top: 1px solid var(--soft-border);

  div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  small {
    color: var(--muted);
  }
`;

const ErrorText = styled.p`
  margin: 12px 0 0;
  color: var(--danger);
`;

const Filter = styled.input`
  width: 100%;
  margin: 0 0 8px;
`;

const SHOWN = 200;

type State = { kind: 'loading' } | { kind: 'ready'; items: Item[]; note: string } | { kind: 'failed'; message: string };

/**
 * What another instance of nexlibris has for this one: through its pairing, the books it shows this
 * one (its connection's catalog for it), each to Download (`onDownload`, a sync that brings just
 * that one); or, for an instance that syncs with this one as its hub, the books it offered at its
 * last sync, each to ask for, which then come with its next sync.
 */
export function InstanceContents({
  device,
  pairing,
  onDownload,
  onDone,
  onClose,
}: {
  device: Device;
  pairing?: Pairing;
  onDownload(ids: ItemId[]): void;
  onDone(): void;
  onClose(): void;
}) {
  const { library, backend } = useLibrary();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [requested, setRequested] = useState<Set<ItemId>>(new Set());
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      if (pairing) {
        const { client } = await connectHub(pairing, backend, true);
        const current = await backend.getLibrary();
        const { revision } = await client.hello(null);
        // Its library as it shows this one: the books it exposes, and those of this one's it has.
        const { library: shown } = await client.state({ since: revision, have: Object.keys(current.items), peer: current.origin });
        setState({ kind: 'ready', items: Object.values(shown.items), note: t('instanceContents.shows', { name: device.name }) });
      } else {
        const offer = await peerOffer(backend, device.id);
        setRequested(new Set(offer.requested));
        const note = offer.at
          ? t('instanceContents.offered', { name: device.name, date: new Date(offer.at).toLocaleString() })
          : t('instanceContents.notOffered', { name: device.name });
        setState({ kind: 'ready', items: offer.items, note });
      }
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }, [backend, device, pairing]);
  // Once, on opening (it reads only), and again on Refresh.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => void load(), [load]);

  const ask = async (id: ItemId, yes: boolean) => {
    await requestFromPeer(backend, device.id, [id], yes);
    setRequested((before) => {
      const next = new Set(before);
      if (yes) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const words = filter.trim().toLowerCase();
  const items = state.kind === 'ready' ? state.items : [];
  const matching = items
    .filter((item) => !words || `${item.title} ${item.creators.map((c) => c.name).join(' ')}`.toLowerCase().includes(words))
    .sort((a, b) => a.title.localeCompare(b.title));
  const lacking = matching.filter((item) => !library.items[item.id]);

  return (
    <Modal title={t('instanceContents.title', { name: device.name })} onClose={onClose}>
      {state.kind === 'loading' && <Muted as="p">{pairing ? t('instanceContents.connecting', { name: device.name }) : t('instanceContents.reading')}</Muted>}
      {state.kind === 'failed' && <ErrorText role="alert">{state.message}</ErrorText>}
      {state.kind === 'ready' && (
        <>
          <Muted as="p">
            {t('instanceContents.count', {
              note: state.note,
              books: t('common.books', { count: items.length }),
              missing: t('common.books', { count: items.filter((item) => !library.items[item.id]).length }),
            })}
          </Muted>
          {items.length > 10 && <Filter type="search" placeholder={t('instanceContents.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {pairing && lacking.length > 1 && (
            <p>
              <Button $variant="secondary" $size="small" onClick={() => onDownload(lacking.map((item) => item.id))}>
                {t('instanceContents.downloadAll', { count: lacking.length })}
              </Button>
            </p>
          )}
          <Stack as="ul">
            {matching.slice(0, SHOWN).map((item) => {
              const here = !!library.items[item.id];
              return (
                <BookRow key={item.id}>
                  <div>
                    <span>{item.title}</span>
                    <small>{[item.creators[0]?.name, here && t('instanceContents.inLibrary')].filter(Boolean).join(t('common.list'))}</small>
                  </div>
                  <Spacer />
                  {!here &&
                    (pairing ? (
                      <Button $variant="secondary" $size="small" onClick={() => onDownload([item.id])}>
                        {t('instanceContents.download')}
                      </Button>
                    ) : requested.has(item.id) ? (
                      <Button $variant="secondary" $size="small" title={t('instanceContents.askedTitle')} onClick={() => void ask(item.id, false)}>
                        {t('instanceContents.asked')}
                      </Button>
                    ) : (
                      <Button $variant="secondary" $size="small" onClick={() => void ask(item.id, true)}>
                        {t('instanceContents.ask')}
                      </Button>
                    ))}
                </BookRow>
              );
            })}
          </Stack>
          {matching.length > SHOWN && <Muted as="p">{t('instanceContents.more', { count: matching.length - SHOWN })}</Muted>}
        </>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={onDone}>
          {t('common.back')}
        </Button>
        <Spacer />
        {state.kind !== 'loading' && (
          <Button $variant="secondary" onClick={() => void load()}>
            {state.kind === 'failed' ? t('common.tryAgain') : t('common.refresh')}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
