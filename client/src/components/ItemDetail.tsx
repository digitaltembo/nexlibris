import { LOCAL_USER, userData, type FileRef, type Item, type MetadataValue } from '@nexlibris/common';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styled from 'styled-components';
import { BOOK_FIELDS, bookSize, fieldLabel, fieldText, isFixedField, type BookField } from '../library/bookFields';
import { coverOperations, type NewCover } from '../library/editCover';
import { diffDraft, draftFromItem, type ItemDraft } from '../library/editDraft';
import { savedPosition } from '../library/useReadingPosition';
import { deleteItems, freeFiles } from '../library/freeFiles';
import { useLibrary } from '../library/LibraryContext';
import { metadataToText } from '../library/metadataText';
import { roleLabel } from '../library/roles';
import { isReadable, preferredReadable } from '../reader/Reader';
import { Cover } from './Cover';
import { CoverPicker } from './CoverPicker';
import { CreatorsEditor } from './CreatorsEditor';
import { ConvertDialog, convertibleFiles } from './ConvertDialog';
import { EditableFiles, formatSize, ItemFiles } from './ItemFiles';
import { KeyValueEditor } from './KeyValueEditor';
import { MenuButton, type MenuAction } from './MenuButton';
import { Prose, RichText } from './RichText';
import { AddTo } from './AddTo';
import { ItemCatalogs } from './ItemCatalogs';
import { SendTo, writableConnections } from './SendTo';
import { StarRating } from './StarRating';
import { TagEditor } from './TagEditor';
import {
  Button,
  Panel,
  PanelFooter,
  PanelSection,
  SectionHeading,
  Badge,
  Tag,
  TagButton,
  TagLabel,
  TagList,
} from '../styles/ui';

/**
 * A book that isn't the library's (on a connection that reads, or in a catalog on a server), shown
 * read-only: no rating, editing, reading or sending, and no catalogs; what it offers instead.
 */
export interface RemoteDetail {
  /** Adding it to the library: shown where a library book's actions are. */
  actions: ReactNode;
  /** The library's copy, if it has one. */
  owned?: Item;
  /** In place of the Files section (a catalog's downloads, each to add). */
  files?: ReactNode;
  /** After the details: a catalog's links on to other pages, how adding went. */
  footer?: ReactNode;
}

interface Props {
  item: Item;
  onClose(): void;
  onSelectTag?(tag: string): void;
  onRead?(file: FileRef): void;
  /** Read-only, for a book that isn't the library's. */
  remote?: RemoteDetail;
  /** In a modal rather than the right-hand pane (a connection's "On it…"). */
  embedded?: boolean;
}

/** The pane, laid out in place rather than fixed at the right, in a modal. */
const EmbeddedPanel = styled.div`
  padding: 0;
`;

const Header = styled.header`
  display: grid;
  grid-template-columns: 96px 1fr auto;
  gap: 12px;
  align-items: start;
`;

const Title = styled.h2`
  margin: 0 0 4px;
  font-family: Georgia, serif;
  font-size: 1.25rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
`;

const TitleInput = styled.input`
  width: 100%;
  margin-bottom: 4px;
  padding: 2px 4px;
  font-family: Georgia, serif;
  font-size: 1.2rem;
  font-weight: 600;
`;

const Line = styled.p`
  margin: 0 0 4px;
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
`;

const Fields = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;

  > div {
    display: contents;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
`;

const MutedLine = styled(Line)`
  color: var(--muted);
`;

/** A cover colour, shown beside its value. */
const Swatch = styled.span<{ $color: string }>`
  display: inline-block;
  width: 0.9em;
  height: 0.9em;
  margin-right: 6px;
  vertical-align: -0.1em;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: ${(p) => p.$color};
`;

/** The fixed fields' inputs, label beside input. */
const FieldInputs = styled.div`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 10px;
  align-items: center;

  label {
    display: contents;
    color: var(--muted);
  }

  span {
    display: flex;
    align-items: center;
  }

  input {
    flex: 1;
    min-width: 0;
  }
`;

const Timestamps = styled.p`
  margin: 24px 0 0;
  color: var(--muted);
  font-size: 0.85em;
`;

/** Fields shown in their own places rather than in the details list. */
const FEATURED_FIELDS = new Set(['series', 'seriesIndex', 'description', 'subtitle']);

/** The details list: the fixed fields in their order, then the custom ones by name. */
function detailFields(item: Item): [key: string, value: MetadataValue][] {
  const fixed = BOOK_FIELDS.map((f): [string, MetadataValue | undefined] => [f.key, item.metadata[f.key]]);
  const custom = Object.entries(item.metadata)
    .filter(([key]) => !isFixedField(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...fixed, ...custom].filter((entry): entry is [string, MetadataValue] => entry[1] !== undefined && !FEATURED_FIELDS.has(entry[0]));
}

export function byline(item: Item): string {
  return item.creators.map((c) => (c.role === 'aut' ? c.name : `${c.name} (${roleLabel(c.role).toLowerCase()})`)).join(', ');
}

export function seriesLabel(item: Item): string | undefined {
  const { series, seriesIndex } = item.metadata;
  if (typeof series !== 'string' || !series) return undefined;
  return seriesIndex !== undefined && seriesIndex !== null ? `${series} #${metadataToText(seriesIndex as MetadataValue)}` : series;
}

/**
 * The right-hand panel: read-only, except rating and file actions, until "Edit" is chosen. With
 * `remote`, a book from a connection or catalog, read-only throughout, with its own actions.
 */
export function ItemDetail({ remote, embedded, ...props }: Props) {
  return remote ? <RemoteItemDetail item={props.item} remote={remote} onClose={props.onClose} embedded={!!embedded} /> : <LibraryItemDetail {...props} />;
}

function LibraryItemDetail({ item, onClose, onSelectTag, onRead = () => undefined }: Omit<Props, 'remote' | 'embedded'>) {
  const { library, apply, backend } = useLibrary();
  const { ratings, reviews } = userData(library);
  const [draft, setDraft] = useState<ItemDraft>();
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [converting, setConverting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A new cover chosen while editing, shown in the header and saved with the rest.
  const [cover, setCover] = useState<NewCover>();
  const position = savedPosition(library, item.id);
  // Carry on in the file last read, if it can still be read; otherwise start the best one.
  const resume = position && isReadable(position.file) ? position : undefined;
  const readable = resume?.file ?? preferredReadable(item);
  const progress = resume?.progress !== undefined ? ` · ${Math.round(resume.progress * 100)}%` : '';
  const review = reviews[item.id]?.text;
  const writable = writableConnections(library).length > 0;
  const actions: MenuAction[] = [
    { label: 'Edit', onSelect: () => setDraft(draftFromItem(item, review)) },
    ...(convertibleFiles(item).length ? [{ label: 'Convert…', onSelect: () => setConverting(true) }] : []),
    ...(writable
      ? [
          { label: 'Send to…', onSelect: () => setSending(true) },
          { label: 'Add to…', onSelect: () => setAdding(true) },
        ]
      : []),
    { label: 'Delete…', danger: true, onSelect: () => setConfirming(true) },
  ];

  return (
    <Panel aria-label={`Details for ${item.title}`}>
      <Header>
        {draft ? <CoverPicker item={item} cover={cover} onChange={setCover} /> : <Cover item={item} />}
        <div>
          {draft ? (
            <TitleInput
              aria-label="Title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          ) : (
            <>
              <Title>{item.title}</Title>
              {item.metadata.subtitle && <MutedLine>{item.metadata.subtitle}</MutedLine>}
              {item.creators.length > 0 && <Line>{byline(item)}</Line>}
              {seriesLabel(item) && <MutedLine>{seriesLabel(item)}</MutedLine>}
            </>
          )}
          <StarRating
            value={ratings[item.id]}
            onChange={(r) => void apply([{ type: 'setRating', userId: LOCAL_USER, itemId: item.id, rating: r }])}
          />
          {!draft && (
            <Actions>
              {confirming ? (
                <>
                  <Button
                    $variant="danger"
                    autoFocus
                    onClick={() => {
                      setConfirming(false);
                      void deleteItems(backend, apply, [item]);
                    }}
                  >
                    Delete
                  </Button>
                  <Button $variant="secondary" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {readable && <Button onClick={() => onRead(readable)}>{resume ? `Continue${progress}` : 'Read'}</Button>}
                  <MenuButton label={`Actions for ${item.title}`} actions={actions} />
                </>
              )}
            </Actions>
          )}
        </div>
        <Button $variant="icon" aria-label="Close" onClick={onClose}>
          ×
        </Button>
      </Header>

      {draft ? (
        <ItemEditor
          item={item}
          review={review}
          draft={draft}
          cover={cover}
          onChange={setDraft}
          onDone={() => {
            setDraft(undefined);
            setCover(undefined);
          }}
        />
      ) : (
        <ItemView item={item} review={review} {...(onSelectTag && { onSelectTag })} onRead={onRead} />
      )}
      {sending && <SendTo items={[item]} onClose={() => setSending(false)} />}
      {adding && <AddTo items={[item]} onClose={() => setAdding(false)} />}
      {converting && <ConvertDialog item={item} onClose={() => setConverting(false)} />}
    </Panel>
  );
}

/** A book from a connection or catalog: what's known of it, read-only, with adding it to the library. */
function RemoteItemDetail({ item, remote, onClose, embedded }: { item: Item; remote: RemoteDetail; onClose(): void; embedded: boolean }) {
  const Box = embedded ? EmbeddedPanel : Panel;
  const pane = (
    <Box aria-label={`Details for ${item.title}`}>
      <Header>
        <Cover item={item} />
        <div>
          <Title>{item.title}</Title>
          {item.metadata.subtitle && <MutedLine>{item.metadata.subtitle}</MutedLine>}
          {item.creators.length > 0 && <Line>{byline(item)}</Line>}
          {seriesLabel(item) && <MutedLine>{seriesLabel(item)}</MutedLine>}
          {remote.owned && <Badge>In library{remote.owned.title !== item.title ? ` as “${remote.owned.title}”` : ''}</Badge>}
          <Actions>{remote.actions}</Actions>
        </div>
        {!embedded && (
          <Button $variant="icon" aria-label="Close" onClick={onClose}>
            ×
          </Button>
        )}
      </Header>
      <ItemDetails item={item} />
      {remote.files && (
        <PanelSection>
          <SectionHeading>Files</SectionHeading>
          {remote.files}
        </PanelSection>
      )}
      {remote.footer}
    </Box>
  );
  // Over the page as the library's pane is: its browser is inside the books' stacking, below the top bar.
  return embedded ? pane : createPortal(pane, document.body);
}

/** Tags (each a search, where `onSelectTag` is given), the description and the details' fields. */
function ItemDetails({ item, review, onSelectTag }: { item: Item; review?: string | undefined; onSelectTag?(tag: string): void }) {
  const description = typeof item.metadata.description === 'string' ? item.metadata.description : undefined;
  const fields = detailFields(item);
  const identifiers = Object.entries(item.identifiers);

  return (
    <>
      {item.tags.length > 0 && (
        <PanelSection>
          <TagList>
            {item.tags.map((tag) =>
              onSelectTag ? (
                <TagButton key={tag} onClick={() => onSelectTag(tag)} title={`Search for “${tag}”`}>
                  {tag}
                </TagButton>
              ) : (
                <Tag key={tag}>
                  <TagLabel>{tag}</TagLabel>
                </Tag>
              ),
            )}
          </TagList>
        </PanelSection>
      )}

      {description && (
        <PanelSection>
          <SectionHeading>About</SectionHeading>
          <RichText text={description} />
        </PanelSection>
      )}

      {review && (
        <PanelSection>
          <SectionHeading>Your review</SectionHeading>
          <Prose>{review}</Prose>
        </PanelSection>
      )}

      {(fields.length > 0 || identifiers.length > 0) && (
        <PanelSection>
          <SectionHeading>Details</SectionHeading>
          <Fields>
            {fields.map(([key, value]) => (
              <div key={key}>
                <dt>{fieldLabel(key)}</dt>
                <dd>
                  {key === 'coverColor' && typeof value === 'string' && <Swatch $color={value} />}
                  {fieldText(key, value)}
                </dd>
              </div>
            ))}
            {identifiers.map(([scheme, value]) => (
              <div key={`id:${scheme}`}>
                <dt>{scheme}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </Fields>
        </PanelSection>
      )}
    </>
  );
}

function ItemView({ item, review, onSelectTag, onRead }: { item: Item; review: string | undefined; onSelectTag?(tag: string): void; onRead(file: FileRef): void }) {
  return (
    <>
      <ItemDetails item={item} review={review} {...(onSelectTag && { onSelectTag })} />
      <PanelSection>
        <SectionHeading>Files</SectionHeading>
        <ItemFiles item={item} onRead={onRead} />
      </PanelSection>

      <ItemCatalogs item={item} />

      <Timestamps>
        {item.files.length > 0 && `Size ${formatSize(bookSize(item))} · `}
        Added {new Date(item.addedAt).toLocaleDateString()}
        {item.updatedAt !== item.addedAt && ` · updated ${new Date(item.updatedAt).toLocaleDateString()}`}
      </Timestamps>
    </>
  );
}

interface EditorProps {
  item: Item;
  review: string | undefined;
  draft: ItemDraft;
  /** A new cover, chosen in the header. */
  cover: NewCover | undefined;
  onChange(draft: ItemDraft): void;
  onDone(): void;
}

function ItemEditor({ item, review, draft, cover, onChange, onDone }: EditorProps) {
  const { apply, backend } = useLibrary();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) => onChange({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      const ops = [...diffDraft(item, review, draft), ...(cover ? await coverOperations(backend, item, cover) : [])];
      if (ops.length) await apply(ops);
      // Files detached here, and a replaced cover, are deleted from storage too, unless another item has them.
      if (ops.some((op) => op.type === 'detachFile' || (op.type === 'updateItem' && op.patch.cover))) await freeFiles(backend, [item]);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
      }}
    >
      <PanelSection>
        <SectionHeading>Creators</SectionHeading>
        <CreatorsEditor creators={draft.creators} onChange={(creators) => set('creators', creators)} />
      </PanelSection>

      <PanelSection>
        <SectionHeading>Tags</SectionHeading>
        <TagEditor
          tags={draft.tags}
          onAdd={(tags) =>
            set('tags', [...draft.tags, ...tags.filter((t) => !draft.tags.some((d) => d.toLowerCase() === t.toLowerCase()))])
          }
          onRemove={(tag) => set('tags', draft.tags.filter((t) => t !== tag))}
        />
      </PanelSection>

      <PanelSection>
        <SectionHeading>About</SectionHeading>
        <textarea rows={4} placeholder="Description" value={draft.description} onChange={(e) => set('description', e.target.value)} />
      </PanelSection>

      <PanelSection>
        <SectionHeading>Your review</SectionHeading>
        <textarea rows={4} placeholder="What did you think?" value={draft.review} onChange={(e) => set('review', e.target.value)} />
      </PanelSection>

      <PanelSection>
        <SectionHeading>Details</SectionHeading>
        <FieldInputs>
          {BOOK_FIELDS.map((field) => (
            <FieldInput key={field.key} field={field} value={draft.fields[field.key] ?? ''} onChange={(text) => set('fields', { ...draft.fields, [field.key]: text })} />
          ))}
        </FieldInputs>
      </PanelSection>

      <PanelSection>
        <SectionHeading>Other fields</SectionHeading>
        <KeyValueEditor keyPlaceholder="field" entries={draft.metadata} onChange={(metadata) => set('metadata', metadata)} />
      </PanelSection>

      <PanelSection>
        <SectionHeading>Identifiers</SectionHeading>
        <KeyValueEditor
          keyPlaceholder="scheme (isbn, …)"
          entries={draft.identifiers}
          onChange={(identifiers) => set('identifiers', identifiers)}
        />
      </PanelSection>

      <PanelSection>
        <SectionHeading>Files</SectionHeading>
        <EditableFiles item={item} files={draft.files} onChange={(files) => set('files', files)} />
      </PanelSection>

      <PanelFooter $sticky>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button $variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </PanelFooter>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: BookField; value: string; onChange(text: string): void }) {
  return (
    <label>
      {field.label}
      <span>
        {field.kind === 'color' && /^#[0-9a-f]{6}$/i.test(value) && <Swatch $color={value} />}
        <input
          value={value}
          placeholder={field.hint}
          {...(field.kind === 'number' && { inputMode: 'decimal' as const })}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}
