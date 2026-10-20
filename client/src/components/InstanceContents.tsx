import { peerOffer, requestFromPeer, type Device, type Item, type ItemId, type Pairing } from '@nexlibris/common';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Spacer, Stack } from '../styles/ui';
import { connectHub } from '../sync/connect';
import { Modal, ModalFooter } from './Modal';

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
        setState({ kind: 'ready', items: Object.values(shown.items), note: `The books ${device.name} shows this device.` });
      } else {
        const offer = await peerOffer(backend, device.id);
        setRequested(new Set(offer.requested));
        const note = offer.at
          ? `The books ${device.name} offered this device when it last synced (${new Date(offer.at).toLocaleString()}). Ask for one, and it comes with its next sync.`
          : `${device.name} hasn’t offered this device any books yet: it does when it syncs with it.`;
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
    <Modal title={`On ${device.name}`} onClose={onClose}>
      {state.kind === 'loading' && <Muted as="p">{pairing ? `Connecting to ${device.name}…` : 'Reading…'}</Muted>}
      {state.kind === 'failed' && <ErrorText role="alert">{state.message}</ErrorText>}
      {state.kind === 'ready' && (
        <>
          <Muted as="p">
            {state.note} {plural(items.length, 'book')}, {plural(items.filter((item) => !library.items[item.id]).length, 'book')} not in this
            library.
          </Muted>
          {items.length > 10 && <Filter type="search" placeholder="Filter by title or author" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {pairing && lacking.length > 1 && (
            <p>
              <Button $variant="secondary" $size="small" onClick={() => onDownload(lacking.map((item) => item.id))}>
                Download all {lacking.length}
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
                    <small>{[item.creators[0]?.name, here && 'in your library'].filter(Boolean).join(' · ')}</small>
                  </div>
                  <Spacer />
                  {!here &&
                    (pairing ? (
                      <Button $variant="secondary" $size="small" onClick={() => onDownload([item.id])}>
                        Download
                      </Button>
                    ) : requested.has(item.id) ? (
                      <Button $variant="secondary" $size="small" title="Comes with its next sync." onClick={() => void ask(item.id, false)}>
                        Asked for
                      </Button>
                    ) : (
                      <Button $variant="secondary" $size="small" onClick={() => void ask(item.id, true)}>
                        Ask for it
                      </Button>
                    ))}
                </BookRow>
              );
            })}
          </Stack>
          {matching.length > SHOWN && <Muted as="p">And {matching.length - SHOWN} more: filter to find them.</Muted>}
        </>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={onDone}>
          Back
        </Button>
        <Spacer />
        {state.kind !== 'loading' && (
          <Button $variant="secondary" onClick={() => void load()}>
            {state.kind === 'failed' ? 'Try again' : 'Refresh'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
