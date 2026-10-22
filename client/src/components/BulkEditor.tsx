import { type Device, type Item, LOCAL_USER, type Operation, textToMetadata, userData } from '@nexlibris/common';
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import { addToDevice, deviceItems, takeOutOfDevice } from '../devices/selection';
import { isFiles, takesSingle, type FilesType } from '../devices/types';
import { connectionType } from '../connections';
import { deleteItems, removeFormat } from '../library/freeFiles';
import { useLibrary } from '../library/LibraryContext';
import { addCreatorOps, parseTags, removeCreatorOps, removeTagsOps } from '../library/bulkEdit';
import { creatorsIn, tagsIn } from '../library/completion';
import { DeleteButton } from './DeleteButton';
import { formatLabel } from './ItemFiles';
import { SyncDevice } from './ConnectionsDialog';
import { writableConnections } from './SendTo';
import { useConnectionStatus } from '../connections/active';
import { StarRating } from './StarRating';
import { CompletionInput } from './CompletionInput';
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

const RemoveRow = styled(Row)`
  margin-bottom: 8px;
`;

/** Past this many different tags or creators, the selection's aren't shown as chips but typed to remove. */
const MAX_CHIPS = 15;

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
  const { library, apply, backend } = useLibrary();
  const { ratings } = userData(library);
  const [newTags, setNewTags] = useState('');
  const [oldTags, setOldTags] = useState('');
  const [newCreator, setNewCreator] = useState('');
  const [oldCreator, setOldCreator] = useState('');
  const [field, setField] = useState({ key: '', value: '' });
  /** What the last removal by name did, shown in its section. */
  const [note, setNote] = useState<{ section: 'tags' | 'creators' | 'files'; text: string }>();
  const [format, setFormat] = useState('');
  /** A reader the selected books are being sent to, alone. */
  const [sendingTo, setSendingTo] = useState<{ device: Device; type: FilesType }>();

  const count = items.length;
  // Only connections with catalogs take books.
  const devices = writableConnections(library);
  const { isActive } = useConnectionStatus();
  const tags = tally(items, (i) => i.tags);
  const libraryTags = useMemo(() => tagsIn(Object.values(library.items)), [library.items]);
  const onAll = tags.filter(([, n]) => n === count).map(([tag]) => tag);
  const creators = tally(items, (i) => i.creators.map((c) => c.name));
  const libraryCreators = useMemo(() => creatorsIn(Object.values(library.items)), [library.items]);
  const creatorOfAll = creators.filter(([, n]) => n === count).map(([name]) => name);
  const fields = tally(items, (i) => Object.keys(i.metadata));
  const formats = tally(items, (i) => i.files.map((f) => f.format));
  const chosenFormat = formats.some(([f]) => f === format) ? format : (formats[0]?.[0] ?? '');
  const inFormat = items.flatMap((i) => i.files.filter((f) => f.format === chosenFormat));
  /** Books whose only files are in the chosen format, left with none if they go. */
  const leftBare = items.filter((i) => i.files.length && i.files.every((f) => f.format === chosenFormat)).length;
  const commonRating = items.every((i) => ratings[i.id] === ratings[items[0]!.id]) ? ratings[items[0]!.id] : undefined;
  const of = (n: number) => (n === count ? 'all' : `${n} of ${count}`);

  const run = (ops: Operation[]) => ops.length > 0 && void apply(ops);

  /** Says what an edit did, or that it had nothing to do. */
  const report = (section: 'tags' | 'creators', ops: Operation[], done: string, nothing: string) => {
    run(ops);
    setNote({ section, text: ops.length ? `${done} ${ops.length === count ? 'all' : `${ops.length} of ${count}`}.` : nothing });
  };

  const addTags = () => {
    const added = parseTags(newTags);
    if (added.length) run(items.map((i) => ({ type: 'addTags', id: i.id, tags: added })));
    setNewTags('');
    setNote(undefined);
  };

  const removeTags = () => {
    const removed = parseTags(oldTags);
    if (!removed.length) return;
    report('tags', removeTagsOps(items, removed), `Removed ${removed.join(', ')} from`, `None of the selected items are tagged ${removed.join(' or ')}.`);
    setOldTags('');
  };

  const addCreator = () => {
    const name = newCreator.trim();
    if (!name) return;
    run(addCreatorOps(items, name));
    setNewCreator('');
    setNote(undefined);
  };

  const removeCreator = (name: string) => {
    if (!name.trim()) return;
    report('creators', removeCreatorOps(items, name), `Removed ${name.trim()} from`, `None of the selected items have ${name.trim()} as a creator.`);
    setOldCreator('');
  };

  const removeFiles = async () => {
    const label = formatLabel(chosenFormat);
    try {
      const { removed, files } = await removeFormat(backend, apply, items, chosenFormat);
      setNote({
        section: 'files',
        text: `Removed ${removed} ${label} file${removed === 1 ? '' : 's'}${files < removed ? `; ${removed - files} weren’t deleted, as another book uses them or they aren’t stored on this device` : ''}.`,
      });
    } catch (e) {
      setNote({ section: 'files', text: `Couldn’t remove the ${label} files: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

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
              const held = items.filter((i) => included.has(i.id));
              const on = held.length;
              const type = connectionType(device.type);
              return (
                <Row key={device.id}>
                  <span>
                    {device.name} <Muted>({on === 0 ? 'none' : of(on)} in its catalog)</Muted>
                  </span>
                  <Spacer />
                  {on < count && (
                    <Button
                      $variant="secondary"
                      $size="small"
                      onClick={() => run(addToDevice(device, items.map((i) => i.id)))}
                    >
                      Add
                    </Button>
                  )}
                  {type && isFiles(type) && takesSingle(type) && (
                    <Button
                      $variant="secondary"
                      $size="small"
                      disabled={!isActive(device)}
                      title={
                        isActive(device)
                          ? 'Sends these books now, adding them to its catalog, and leaves the rest of it as it is.'
                          : `${device.name} is inactive. Activate it under Connections.`
                      }
                      onClick={() => setSendingTo({ device, type })}
                    >
                      {isActive(device) ? 'Send' : 'Send (inactive)'}
                    </Button>
                  )}
                  {on > 0 && (
                    <Button
                      $variant="secondary"
                      $size="small"
                      title="Takes them out of its catalog (kept out, if its search matches them). What was sent stays there."
                      onClick={() => run(takeOutOfDevice(library, device, held.map((i) => i.id)))}
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

      {formats.length > 0 && (
        <PanelSection>
          <SectionHeading>Files</SectionHeading>
          <Row>
            <select aria-label="Format to remove" value={chosenFormat} onChange={(e) => setFormat(e.target.value)}>
              {formats.map(([f, n]) => (
                <option key={f} value={f}>
                  {formatLabel(f)} ({of(n)})
                </option>
              ))}
            </select>
            <Spacer />
            <DeleteButton
              small
              verb="Remove"
              what={`${inFormat.length} ${formatLabel(chosenFormat)} file${inFormat.length === 1 ? '' : 's'}`}
              onDelete={() => void removeFiles()}
            />
          </Row>
          <Muted as="p">
            Takes the files off the selected books and deletes them from the library.
            {leftBare > 0 && ` ${leftBare === 1 ? 'One book has' : `${leftBare} books have`} no other file and would be left with none.`}
          </Muted>
          {note?.section === 'files' && (
            <Muted as="p" role="status">
              {note.text}
            </Muted>
          )}
        </PanelSection>
      )}

      <PanelSection>
        <SectionHeading>Tags</SectionHeading>
        {tags.length > MAX_CHIPS ? (
          <>
            <Muted as="p">The selected items have {tags.length} different tags.</Muted>
            <RemoveRow>
              <CompletionInput
                placeholder="Tags to remove, comma-separated…"
                aria-label="Tags to remove"
                value={oldTags}
                candidates={tags.map(([tag]) => tag)}
                onChange={setOldTags}
                onKeyDown={(e) => e.key === 'Enter' && removeTags()}
              />
              <Button $variant="secondary" $size="small" disabled={!oldTags.trim()} onClick={removeTags}>
                Remove
              </Button>
            </RemoveRow>
          </>
        ) : (
          <Chips>
            {tags.map(([tag, n]) => (
              <Tag key={tag}>
                <TagLabel>
                  {tag} <Muted>({of(n)})</Muted>
                </TagLabel>
                <TagRemove
                  aria-label={`Remove tag ${tag} from selected items`}
                  onClick={() => run(removeTagsOps(items, [tag]))}
                >
                  ×
                </TagRemove>
              </Tag>
            ))}
          </Chips>
        )}
        <Row>
          <CompletionInput
            placeholder="Tags to add, comma-separated…"
            aria-label="Tags to add"
            value={newTags}
            candidates={libraryTags}
            exclude={onAll}
            onChange={setNewTags}
            onKeyDown={(e) => e.key === 'Enter' && addTags()}
          />
          <Button $variant="secondary" $size="small" disabled={!newTags.trim()} onClick={addTags}>
            Add
          </Button>
        </Row>
        {note?.section === 'tags' && (
          <Muted as="p" role="status">
            {note.text}
          </Muted>
        )}
      </PanelSection>

      <PanelSection>
        <SectionHeading>Creators</SectionHeading>
        {creators.length > MAX_CHIPS ? (
          <>
            <Muted as="p">The selected items have {creators.length} different creators.</Muted>
            <RemoveRow>
              <CompletionInput
                single
                placeholder="A creator to remove…"
                aria-label="Creator to remove"
                value={oldCreator}
                candidates={creators.map(([name]) => name)}
                onChange={setOldCreator}
                onKeyDown={(e) => e.key === 'Enter' && removeCreator(oldCreator)}
              />
              <Button $variant="secondary" $size="small" disabled={!oldCreator.trim()} onClick={() => removeCreator(oldCreator)}>
                Remove
              </Button>
            </RemoveRow>
          </>
        ) : (
          <Chips>
            {creators.map(([name, n]) => (
              <Tag key={name}>
                <TagLabel>
                  {name} <Muted>({of(n)})</Muted>
                </TagLabel>
                <TagRemove
                  aria-label={`Remove ${name} from selected items`}
                  onClick={() => run(removeCreatorOps(items, name))}
                >
                  ×
                </TagRemove>
              </Tag>
            ))}
          </Chips>
        )}
        <Row>
          <CompletionInput
            single
            placeholder="An author to add…"
            aria-label="Author to add"
            value={newCreator}
            candidates={libraryCreators}
            exclude={creatorOfAll}
            onChange={setNewCreator}
            onKeyDown={(e) => e.key === 'Enter' && addCreator()}
          />
          <Button $variant="secondary" $size="small" disabled={!newCreator.trim()} onClick={addCreator}>
            Add
          </Button>
        </Row>
        {note?.section === 'creators' && (
          <Muted as="p" role="status">
            {note.text}
          </Muted>
        )}
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
            void deleteItems(backend, apply, items);
            onDeleted();
          }}
        />
      </PanelFooter>
      {sendingTo && (
        <SyncDevice
          device={sendingTo.device}
          type={sendingTo.type}
          only={items.map((i) => i.id)}
          onDone={() => setSendingTo(undefined)}
          onClose={() => setSendingTo(undefined)}
        />
      )}
    </Panel>
  );
}
