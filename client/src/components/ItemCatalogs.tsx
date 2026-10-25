import type { Item } from '@nexlibris/common';
import styled from 'styled-components';
import { connectionType } from '../connections';
import { inCatalog, takeOutOfDevice } from '../devices/selection';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, PanelSection, SectionHeading, Spacer } from '../styles/ui';
import { formatLabel } from './ItemFiles';
import { t } from '../i18n';

const Row = styled.li`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;

  div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`;

/**
 * The connections' catalogs a book is in, at the bottom of its details, each with Remove from
 * catalog (which takes it out, and keeps it out if the connection's search matches it). Nothing
 * already sent is deleted.
 */
export function ItemCatalogs({ item }: { item: Item }) {
  const { library, apply } = useLibrary();
  const holding = Object.values(library.devices ?? {}).filter((device) => {
    const type = connectionType(device.type);
    return device.id !== library.origin && !!type?.write && inCatalog(library, device, item.id);
  });
  if (!holding.length) return null;
  return (
    <PanelSection>
      <SectionHeading>{t('itemCatalogs.heading')}</SectionHeading>
      <List>
        {holding.map((device) => {
          const type = connectionType(device.type)!;
          const files = device.files?.[item.id];
          const formats = files && item.files.filter((f) => files.includes(f.hash)).map((f) => formatLabel(f.format));
          const sent = Object.values(device.placed).some((p) => p.itemId === item.id);
          return (
            <Row key={device.id}>
              <div>
                <span>{device.name}</span>
                <Muted>
                  {[
                    type.label,
                    formats?.length && t('itemCatalogs.only', { formats: formats.join(t('common.listJoin')) }),
                    !device.items.includes(item.id) && t('itemCatalogs.bySearch'),
                    sent ? t('itemCatalogs.sent') : t('itemCatalogs.notSent'),
                  ]
                    .filter(Boolean)
                    .join(t('common.list'))}
                </Muted>
              </div>
              <Spacer />
              <Button $variant="secondary" $size="small" onClick={() => void apply(takeOutOfDevice(library, device, [item.id]))}>
                {t('itemCatalogs.remove')}
              </Button>
            </Row>
          );
        })}
      </List>
    </PanelSection>
  );
}
