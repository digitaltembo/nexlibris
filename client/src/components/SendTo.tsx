import type { Device, Item } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { addToDevice, deviceItems } from '../devices/selection';
import { isSourceConnection } from '../catalogs/sources';
import { isDevice } from '../devices/types';
import { useLibrary } from '../library/LibraryContext';
import { connectionType } from '../plugins';
import { Button, Muted, Spacer } from '../styles/ui';
import { SyncDevice } from './ConnectionsDialog';
import { Modal, ModalFooter } from './Modal';

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
`;

/** The connections books can go to: everything but catalogs browsed on servers. */
export const sendableConnections = (devices: Record<string, Device> | undefined) =>
  Object.values(devices ?? {}).filter((device) => connectionType(device.type) && !isSourceConnection(device));

/**
 * Sending books to one connection, without syncing the rest of it. A reader is connected to and gets just
 * these books (`SyncDevice`'s `only`), which are chosen for it from then on. A catalog or another instance
 * can't take some books alone, so they're chosen for it and go with its next sync.
 */
export function SendTo({ items, onClose }: { items: Item[]; onClose(): void }) {
  const { library, apply } = useLibrary();
  const connections = sendableConnections(library.devices);
  const [sending, setSending] = useState<Device | undefined>(
    connections.length === 1 && isDevice(connectionType(connections[0]!.type)!) ? connections[0] : undefined,
  );
  const what = items.length === 1 ? `“${items[0]!.title}”` : `${items.length} books`;

  if (sending) {
    const type = connectionType(sending.type);
    if (type && isDevice(type)) {
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
      {connections.length === 0 && <Muted as="p">There are no connections yet. Add one under Connections.</Muted>}
      {connections.map((device) => {
        const type = connectionType(device.type)!;
        const chosen = new Set(deviceItems(library, device).map((item) => item.id));
        const missing = items.filter((item) => !chosen.has(item.id));
        return (
          <Row key={device.id}>
            <span>
              {device.name} <Muted>({type.label})</Muted>
            </span>
            <Spacer />
            {isDevice(type) ? (
              <Button $size="small" onClick={() => setSending(device)}>
                Send
              </Button>
            ) : missing.length ? (
              <Button
                $variant="secondary"
                $size="small"
                title="It goes with the connection’s next sync."
                onClick={() => void apply(addToDevice(device, missing.map((item) => item.id)))}
              >
                Add
              </Button>
            ) : (
              <Muted>Chosen</Muted>
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
