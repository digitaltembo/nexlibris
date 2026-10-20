import type { FileRef, Item } from '@nexlibris/common';
import styled from 'styled-components';
import { connectionType } from '../connections';
import { addFileToDevice, addToDevice, inCatalog, takeOutOfDevice } from '../devices/selection';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Spacer } from '../styles/ui';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';
import { writableConnections } from './SendTo';

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
`;

/**
 * Add to…: puts books (or one file of a book) in a connection's catalog, without sending anything.
 * They go there with its next sync. A book already in a catalog can be taken out of it here too.
 */
export function AddTo({ items, file, onClose }: { items: Item[]; /** Just this file of the one item. */ file?: FileRef; onClose(): void }) {
  const { library, apply } = useLibrary();
  const connections = writableConnections(library);
  const ids = items.map((item) => item.id);
  const what = file ? `${formatLabel(file.format)} of “${items[0]!.title}”` : items.length === 1 ? `“${items[0]!.title}”` : `${items.length} books`;
  return (
    <Modal title={`Add ${what}`} onClose={onClose}>
      {connections.length === 0 && <Muted as="p">There are no connections with catalogs yet. Add one under Connections.</Muted>}
      {connections.map((device) => {
        const type = connectionType(device.type)!;
        const held = items.filter((item) => inCatalog(library, device, item.id));
        const hasFile = !!file && !!device.files?.[items[0]!.id]?.includes(file.hash);
        const added = file ? hasFile : held.length === items.length;
        return (
          <Row key={device.id}>
            <span>
              {device.name} <Muted>({type.label})</Muted>
            </span>
            <Spacer />
            {held.length > 0 && !file && (
              <Button $variant="secondary" $size="small" onClick={() => void apply(takeOutOfDevice(library, device, held.map((i) => i.id)))}>
                Remove
              </Button>
            )}
            {added ? (
              <Muted>In its catalog</Muted>
            ) : (
              <Button
                $size="small"
                onClick={() => void apply(file ? addFileToDevice(library, device, type, items[0]!, file.hash) : addToDevice(device, ids))}
              >
                Add
              </Button>
            )}
          </Row>
        );
      })}
      <Muted as="p">Books in a catalog go there with the connection’s next sync; use Send to… to send them now.</Muted>
      <ModalFooter>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
