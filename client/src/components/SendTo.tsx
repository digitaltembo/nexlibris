import { readPairings, type Device, type Item, type Library, type Pairing } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { connectionType } from '../connections';
import { addToDevice, inCatalog } from '../devices/selection';
import { isFiles, isInstance, isServed, takesSingle, writes } from '../devices/types';
import { instanceName } from '../sync/hub';
import { SyncInstance } from './InstanceSync';
import { useConnectionStatus } from '../connections/active';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Spacer } from '../styles/ui';
import { SyncDevice } from './ConnectionsDialog';
import { Modal, ModalFooter } from './Modal';

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
`;

/**
 * The connections books can be added to: those that write (have a catalog), and can be used here.
 * Not this device's own connection: its catalog is what it gets from others, kept by them.
 */
export const writableConnections = (library: Library) =>
  Object.values(library.devices ?? {}).filter((device) => {
    const type = connectionType(device.type);
    return device.id !== library.origin && !!type && writes(type) && !type.unavailable?.();
  });

/**
 * Send to…: adds books to a connection's catalog and sends them there now, without syncing the rest of it.
 * A reader or folder is connected to and gets just these books (`SyncDevice`'s `only`, which asks first
 * about formats it prefers); another instance paired from here gets them by a sync of just them. One
 * that only syncs whole (a static catalog), or an instance not paired from here, gets them in its
 * catalog, for its next sync; a feed the server serves, in its catalog, served at once.
 */
export function SendTo({ items, onClose }: { items: Item[]; onClose(): void }) {
  const { library, backend, apply } = useLibrary();
  const connections = writableConnections(library);
  const [pairings, setPairings] = useState<Pairing[]>();
  useEffect(() => {
    let cancelled = false;
    void readPairings(backend).then((found) => !cancelled && setPairings(found));
    return () => {
      cancelled = true;
    };
  }, [backend]);
  const pairingOf = (device: Device) => pairings?.find((p) => p.hub.origin === device.id);
  const sendsNow = (device: Device) => {
    const type = connectionType(device.type);
    return !!type && ((isFiles(type) && takesSingle(type)) || (isInstance(type) && !!pairingOf(device)));
  };
  const { status } = useConnectionStatus();
  const [chosen, setSending] = useState<Device>();
  // One reader or folder to send to: straight to it. (An instance's catalog must hold the books first, so it's chosen by its button.)
  const lone = connections.length === 1 ? connections[0] : undefined;
  const loneType = lone && connectionType(lone.type);
  const only = lone && loneType && isFiles(loneType) && takesSingle(loneType) && status(lone).active ? lone : undefined;
  const sending = chosen ?? only;
  const what = items.length === 1 ? `“${items[0]!.title}”` : `${items.length} books`;
  const ids = items.map((item) => item.id);

  if (sending) {
    const type = connectionType(sending.type);
    const pairing = pairingOf(sending);
    if (type && isInstance(type) && pairing) {
      return (
        <SyncInstance
          device={sending}
          pairing={pairing}
          direction="to"
          only={{ push: ids }}
          self={instanceName()}
          onBack={() => (connections.length > 1 ? setSending(undefined) : onClose())}
          onClose={onClose}
        />
      );
    }
    if (type && isFiles(type)) {
      return (
        <SyncDevice
          device={sending}
          type={type}
          only={items.map((item) => item.id)}
          onDone={() => (connections.length > 1 ? setSending(undefined) : onClose())}
          onClose={onClose}
        />
      );
    }
  }
  return (
    <Modal title={`Send ${what}`} onClose={onClose}>
      {connections.length === 0 && <Muted as="p">There are no connections to send to yet. Add one under Connections.</Muted>}
      {connections.map((device) => {
        const type = connectionType(device.type)!;
        const missing = items.filter((item) => !inCatalog(library, device, item.id));
        const { active, reason } = status(device);
        return (
          <Row key={device.id}>
            <span>
              {device.name} <Muted>({type.label})</Muted>
              {!active && <Muted title={reason}> (inactive)</Muted>}
            </span>
            <Spacer />
            {!active ? (
              <Button $variant="secondary" $size="small" disabled title={`${reason ?? 'Inactive'}. Activate it under Connections.`}>
                {sendsNow(device) ? 'Send' : 'Add for next sync'}
              </Button>
            ) : sendsNow(device) ? (
              <Button
                $size="small"
                // In its catalog first: an instance is sent only what its catalog holds.
                onClick={() => void apply(missing.length ? addToDevice(device, missing.map((item) => item.id)) : []).then(() => setSending(device))}
              >
                Send
              </Button>
            ) : missing.length ? (
              <Button
                $variant="secondary"
                $size="small"
                title={isServed(type) ? 'Added to its catalog: the server serves it at once.' : 'Added to its catalog: it goes with the connection’s next sync.'}
                onClick={() => void apply(addToDevice(device, missing.map((item) => item.id)))}
              >
                {isServed(type) ? 'Add' : 'Add for next sync'}
              </Button>
            ) : (
              <Muted>In its catalog</Muted>
            )}
          </Row>
        );
      })}
      <ModalFooter>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
