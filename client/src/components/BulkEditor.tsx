import { LOCAL_USER, userData, type Item, type Operation } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { deviceItems } from '../devices/selection';
import { useLibrary } from '../library/LibraryContext';
import { textToMetadata } from '../library/metadataText';
import { DeleteButton } from './DeleteButton';
import { StarRating } from './StarRating';
import {
  Button,
  Muted,
  Panel,
  PanelFooter,
  PanelSection,
  SectionHeading,
  Row,
  Spacer,
  Stack,
  Tag,
  TagLabel,
  TagList,
  TagRemove,
} from '../styles/ui';

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
`;

const Chips = styled(TagList)`
  margin-bottom: 8px;
`;

interface Props {
  items: Item[];
  /** Closes the panel, leaving the selection. */
  onClose(): void;
  /** After the items are deleted. */
  onDeleted(): void;
}

/** How many of `items` have each value, most common first. */
function tally(items: Item[], values: (item: Item) => string[]): [value: string, count: number][] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    for (const value of new Set(values(item).map((v) => v.toLowerCase()))) {
      const label = values(item).find((v) => v.toLowerCase() === value)!;
      const entry = counts.get(value) ?? { label, count: 0 };
      entry.count++;
      counts.set(value, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map((e) => [e.label, e.count]);
}

/** Edits applied to every selected item at once; each action is a single atomic batch. */
export function BulkEditor({ items, onClose, onDeleted }: Props) {
  const { library, apply } = useLibrary();
  const { ratings } = userData(library);
  const [newTags, setNewTags] = useState('');
  const [newCreator, setNewCreator] = useState('');
  const [field, setField] = useState({ key: '', value: '' });

  const count = items.length;
  const devices = Object.values(library.devices ?? {});
  const tags = tally(items, (i) => i.tags);
  const creators = tally(items, (i) => i.creators.map((c) => c.name));
  const fields = tally(items, (i) => Object.keys(i.metadata));
  const commonRating = items.every((i) => ratings[i.id] === ratings[items[0]!.id]) ? ratings[items[0]!.id] : undefined;
  const of = (n: number) => (n === count ? 'all' : `${n} of ${count}`);

  const run = (ops: Operation[]) => ops.length > 0 && void apply(ops);

  const addTags = () => {
    const added = newTags.split(',').map((t) => t.trim()).filter(Boolean);
    if (added.length) run(items.map((i) => ({ type: 'addTags', id: i.id, tags: added })));
    setNewTags('');
  };

  const addCreator = () => {
    const name = newCreator.trim();
    if (!name) return;
    run(
      items
        .filter((i) => !i.creators.some((c) => c.name.toLowerCase() === name.toLowerCase()))
        .map((i) => ({ type: 'updateItem', id: i.id, patch: { creators: [...i.creators, { name, role: 'aut' }] } })),
    );
    setNewCreator('');
  };

  const removeCreator = (name: string) =>
    run(
      items
        .filter((i) => i.creators.some((c) => c.name.toLowerCase() === name.toLowerCase()))
        .map((i) => ({
          type: 'updateItem',
          id: i.id,
          patch: { creators: i.creators.filter((c) => c.name.toLowerCase() !== name.toLowerCase()) },
        })),
    );

  const setFieldOnAll = () => {
    const key = field.key.trim();
    if (!key) return;
    run(items.map((i) => ({ type: 'setMetadata', id: i.id, key, value: textToMetadata(field.value, i.metadata[key]) })));
    setField({ key: '', value: '' });
  };

  return (
    <Panel aria-label="Bulk edit">
      <Header>
        <h2>
          {count} item{count === 1 ? '' : 's'} selected
        </h2>
        <Button $variant="icon" aria-label="Close" onClick={onClose}>
          ×
        </Button>
      </Header>

      <PanelSection>
        <SectionHeading>Rating</SectionHeading>
        <StarRating
          value={commonRating}
          onChange={(rating) => run(items.map((i) => ({ type: 'setRating', userId: LOCAL_USER, itemId: i.id, rating })))}
        />
      </PanelSection>

      {devices.length > 0 && (
        <PanelSection>
          <SectionHeading>Connections</SectionHeading>
          <Stack>
            {devices.map((device) => {
              const included = new Set(deviceItems(library, device).map((i) => i.id));
              const on = items.filter((i) => included.has(i.id)).length;
              // Remove only takes off books added by hand; ones its search matches stay while they match.
              const byHand = items.filter((i) => device.items.includes(i.id)).length;
              return (
                <Row key={device.id}>
                  <span>
                    {device.name} <Muted>({on === 0 ? 'none' : of(on)} on it{on > byHand && `, ${on - byHand} by its search`})</Muted>
                  </span>
                  <Spacer />
                  {on < count && (
                    <Button
                      $variant="secondary"
                      $size="small"
                      onClick={() => run([{ type: 'addDeviceItems', id: device.id, itemIds: items.map((i) => i.id) }])}
                    >
                      Add
                    </Button>
                  )}
                  {byHand > 0 && (
                    <Button
                      $variant="secondary"
                      $size="small"
                      onClick={() => run([{ type: 'removeDeviceItems', id: device.id, itemIds: items.map((i) => i.id) }])}
                    >
                      Remove
                    </Button>
                  )}
                </Row>
              );
            })}
          </Stack>
        </PanelSection>
      )}

      <PanelSection>
        <SectionHeading>Tags</SectionHeading>
        <Chips>
          {tags.map(([tag, n]) => (
            <Tag key={tag}>
              <TagLabel>
                {tag} <Muted>({of(n)})</Muted>
              </TagLabel>
              <TagRemove
                aria-label={`Remove tag ${tag} from selected items`}
                onClick={() => run(items.map((i) => ({ type: 'removeTags', id: i.id, tags: [tag] })))}
              >
                ×
              </TagRemove>
            </Tag>
          ))}
        </Chips>
        <Row>
          <input
            placeholder="Add tags to all, comma-separated…"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTags()}
          />
          <Button $variant="secondary" $size="small" disabled={!newTags.trim()} onClick={addTags}>
            Add
          </Button>
        </Row>
      </PanelSection>

      <PanelSection>
        <SectionHeading>Creators</SectionHeading>
        <Chips>
          {creators.map(([name, n]) => (
            <Tag key={name}>
              <TagLabel>
                {name} <Muted>({of(n)})</Muted>
              </TagLabel>
              <TagRemove
                aria-label={`Remove ${name} from selected items`}
                onClick={() => removeCreator(name)}
              >
                ×
              </TagRemove>
            </Tag>
          ))}
        </Chips>
        <Row>
          <input
            placeholder="Add an author to all…"
            value={newCreator}
            onChange={(e) => setNewCreator(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCreator()}
          />
          <Button $variant="secondary" $size="small" disabled={!newCreator.trim()} onClick={addCreator}>
            Add
          </Button>
        </Row>
      </PanelSection>

      <PanelSection>
        <SectionHeading>Fields</SectionHeading>
        <Chips>
          {fields.map(([key, n]) => (
            <Tag key={key}>
              <TagLabel>
                {key} <Muted>({of(n)})</Muted>
              </TagLabel>
              <TagRemove
                aria-label={`Clear ${key} on selected items`}
                onClick={() => run(items.map((i) => ({ type: 'setMetadata', id: i.id, key, value: undefined })))}
              >
                ×
              </TagRemove>
            </Tag>
          ))}
        </Chips>
        <Row>
          <input
            placeholder="field"
            value={field.key}
            list="bulk-field-keys"
            onChange={(e) => setField({ ...field, key: e.target.value })}
          />
          <input
            placeholder="value"
            value={field.value}
            onChange={(e) => setField({ ...field, value: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && setFieldOnAll()}
          />
          <Button $variant="secondary" $size="small" disabled={!field.key.trim()} onClick={setFieldOnAll}>
            Set on all
          </Button>
          <datalist id="bulk-field-keys">
            {fields.map(([key]) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        </Row>
      </PanelSection>

      <PanelFooter>
        <DeleteButton
          what={`${count} item${count === 1 ? '' : 's'}`}
          onDelete={() => {
            run(items.map((i) => ({ type: 'removeItem', id: i.id })));
            onDeleted();
          }}
        />
      </PanelFooter>
    </Panel>
  );
}
