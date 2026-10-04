import { LOCAL_USER, userData, type FileRef, type Item, type MetadataValue } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { BOOK_FIELDS, fieldLabel, isFixedField, type BookField } from '../library/bookFields';
import { diffDraft, draftFromItem, type ItemDraft } from '../library/editDraft';
import { savedPosition } from '../library/useReadingPosition';
import { useLibrary } from '../library/LibraryContext';
import { metadataToText } from '../library/metadataText';
import { roleLabel } from '../library/roles';
import { isReadable, preferredReadable } from '../reader/Reader';
import { Cover } from './Cover';
import { CreatorsEditor } from './CreatorsEditor';
import { DeleteButton } from './DeleteButton';
import { EditableFiles, ItemFiles } from './ItemFiles';
import { KeyValueEditor } from './KeyValueEditor';
import { Prose, RichText } from './RichText';
import { StarRating } from './StarRating';
import { TagEditor } from './TagEditor';
import {
  Button,
  Panel,
  PanelFooter,
  PanelSection,
  SectionHeading,
  TagButton,
  TagList,
} from '../styles/ui';

interface Props {
  item: Item;
  onClose(): void;
  onSelectTag(tag: string): void;
  onRead(file: FileRef): void;
}

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

/** The right-hand panel: read-only, except rating and file actions, until "Edit" is chosen. */
export function ItemDetail({ item, onClose, onSelectTag, onRead }: Props) {
  const { library, apply } = useLibrary();
  const { ratings, reviews } = userData(library);
  const [draft, setDraft] = useState<ItemDraft>();
  const position = savedPosition(library, item.id);
  // Carry on in the file last read, if it can still be read; otherwise start the best one.
  const resume = position && isReadable(position.file) ? position : undefined;
  const readable = resume?.file ?? preferredReadable(item);
  const progress = resume?.progress !== undefined ? ` · ${Math.round(resume.progress * 100)}%` : '';
  const review = reviews[item.id]?.text;

  return (
    <Panel aria-label={`Details for ${item.title}`}>
      <Header>
        <Cover item={item} />
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
              {readable && <Button onClick={() => onRead(readable)}>{resume ? `Continue${progress}` : 'Read'}</Button>}
              <Button $variant="secondary" onClick={() => setDraft(draftFromItem(item, review))}>
                Edit
              </Button>
              <DeleteButton onDelete={() => void apply([{ type: 'removeItem', id: item.id }])} />
            </Actions>
          )}
        </div>
        <Button $variant="icon" aria-label="Close" onClick={onClose}>
          ×
        </Button>
      </Header>

      {draft ? (
        <ItemEditor item={item} review={review} draft={draft} onChange={setDraft} onDone={() => setDraft(undefined)} />
      ) : (
        <ItemView item={item} review={review} onSelectTag={onSelectTag} onRead={onRead} />
      )}
    </Panel>
  );
}

function ItemView({ item, review, onSelectTag, onRead }: Omit<Props, 'onClose'> & { review: string | undefined }) {
  const description = typeof item.metadata.description === 'string' ? item.metadata.description : undefined;
  const fields = detailFields(item);
  const identifiers = Object.entries(item.identifiers);

  return (
    <>
      {item.tags.length > 0 && (
        <PanelSection>
          <TagList>
            {item.tags.map((tag) => (
              <TagButton key={tag} onClick={() => onSelectTag(tag)} title={`Search for “${tag}”`}>
                {tag}
              </TagButton>
            ))}
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
                  {metadataToText(value)}
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

      <PanelSection>
        <SectionHeading>Files</SectionHeading>
        <ItemFiles item={item} onRead={onRead} />
      </PanelSection>

      <Timestamps>
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
  onChange(draft: ItemDraft): void;
  onDone(): void;
}

function ItemEditor({ item, review, draft, onChange, onDone }: EditorProps) {
  const { apply } = useLibrary();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) => onChange({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      const ops = diffDraft(item, review, draft);
      if (ops.length) await apply(ops);
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
