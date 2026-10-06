import type { FileHash, Item, ItemId } from '@nexlibris/common';
import { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { findDuplicates, mergeItems, type DuplicateGroup } from '../library/dedupe';
import { useLibrary } from '../library/LibraryContext';
import { rereadMetadata, type RereadProgress, type RereadResult } from '../library/reread';
import { findStaleFiles, updateFiles, type FindResult, type Progress as FileProgress, type UpdateResult } from '../library/updateFiles';
import { Badge, Button, Muted, Spacer } from '../styles/ui';
import { Cover, PlaceholderTitle } from './Cover';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';

/** The cleanups, each a description and its button. */
const Cleanups = styled.ul`
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  div {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }
`;

const Progress = styled.progress`
  width: 100%;
`;

/** The book being read, on one line. */
const Current = styled(Muted).attrs({ as: 'p' })`
  margin: 6px 0 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const Intro = styled(Muted).attrs({ as: 'p' })`
  margin: 8px 0 12px;
`;

/** The groups scroll, so the footer stays in view however many there are. */
const Groups = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(60vh, 560px);
  overflow-y: auto;
`;

const Group = styled.fieldset`
  margin: 0;
  padding: 8px 10px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);

  legend {
    padding: 0 4px;
    font-weight: 600;
  }
`;

const Entry = styled.div`
  display: grid;
  grid-template-columns: auto 28px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 4px 0;

  label {
    display: contents;
    cursor: pointer;
  }
`;

const Thumb = styled(Cover)`
  width: 28px;
  box-shadow: none;

  ${PlaceholderTitle} {
    display: none;
  }
`;

const Details = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 0.9em;
  line-height: 1.3;
`;

const GroupActions = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
`;

/** What tells copies of a book apart. */
function describe(item: Item): { formats: string; detail: string } {
  const formats = [...new Set(item.files.map((f) => formatLabel(f.format)))].join(', ') || 'No files';
  const series = typeof item.metadata.series === 'string' ? item.metadata.series : undefined;
  const isbn = Object.entries(item.identifiers).find(([key]) => key.startsWith('isbn'))?.[1];
  const added = `Added ${new Date(item.addedAt).toLocaleDateString()}`;
  return { formats, detail: [added, series, isbn && `ISBN ${isbn}`].filter(Boolean).join(' · ') };
}

/** Which of a group is kept, and which aren't merged into it (not the same book after all). */
interface Choice {
  keep: ItemId;
  skipped: Set<ItemId>;
}

const defaultChoice = (group: DuplicateGroup): Choice => ({ keep: group.items[0]!.id, skipped: new Set() });

/** The items a group's choice merges into the one kept. */
const mergedOf = (group: DuplicateGroup, choice: Choice) =>
  group.items.filter((i) => i.id !== choice.keep && !choice.skipped.has(i.id)).map((i) => i.id);

function DuplicateEntries({
  group,
  choice,
  onChoice,
  onMerge,
  busy,
}: {
  group: DuplicateGroup;
  choice: Choice;
  onChoice(choice: Choice): void;
  onMerge(): void;
  busy: boolean;
}) {
  const first = group.items[0]!;
  const authors = first.creators.map((c) => c.name).join(', ');
  const merging = mergedOf(group, choice).length;
  return (
    <Group>
      <legend>
        {first.title} <Muted>· {authors}</Muted>
      </legend>
      {group.items.map((item) => {
        const { formats, detail } = describe(item);
        const kept = item.id === choice.keep;
        return (
          <Entry key={item.id}>
            <label>
              <input
                type="radio"
                name={group.key}
                aria-label={`Keep ${formats}, ${detail}`}
                checked={kept}
                onChange={() => onChoice({ keep: item.id, skipped: new Set([...choice.skipped].filter((id) => id !== item.id)) })}
              />
              <Thumb item={item} />
              <Details>
                <span>{formats}</span>
                <Muted>{detail}</Muted>
              </Details>
            </label>
            {kept ? (
              <Badge>Kept</Badge>
            ) : (
              <label title="Merge into the copy kept">
                <input
                  type="checkbox"
                  aria-label={`Merge ${formats}, ${detail}`}
                  checked={!choice.skipped.has(item.id)}
                  onChange={(e) => {
                    const skipped = new Set(choice.skipped);
                    if (e.target.checked) skipped.delete(item.id);
                    else skipped.add(item.id);
                    onChoice({ ...choice, skipped });
                  }}
                />
              </label>
            )}
          </Entry>
        );
      })}
      <GroupActions>
        <Button $variant="secondary" $size="small" disabled={busy || !merging} onClick={onMerge}>
          Merge {merging + 1} into one
        </Button>
      </GroupActions>
    </Group>
  );
}

type View = 'menu' | 'duplicates' | 'reread' | 'files';

/** Moves a file's full-text index to a new version of it (the text index's `carry`). */
type CarryText = (from: FileHash, to: FileHash) => Promise<void>;

/**
 * Tidying the library: a list of cleanups, each opened by its button. Finding items with the same
 * title and authors, to merge into one (files, tags, fields and ratings gathered together), and
 * re-reading metadata from the books' files to fill in what items lack. Further cleanups go in the
 * list beside them, as is writing the library's metadata into the books' files. `pauseIndexing`
 * (the text index's) keeps indexing out of the way of a re-read or an update, and `carryText` keeps
 * an updated file's text indexed.
 */
export function CleanupDialog({
  onClose,
  pauseIndexing,
  carryText,
}: {
  onClose(): void;
  pauseIndexing?: () => () => void;
  carryText?: CarryText;
}) {
  const [view, setView] = useState<View>('menu');
  const back = () => setView('menu');
  const indexing = { ...(pauseIndexing && { pauseIndexing }), ...(carryText && { carryText }) };
  if (view === 'duplicates') return <Duplicates onBack={back} onClose={onClose} />;
  if (view === 'reread') return <Reread onBack={back} onClose={onClose} {...(pauseIndexing && { pauseIndexing })} />;
  if (view === 'files') return <UpdateFiles onBack={back} onClose={onClose} {...indexing} />;
  return (
    <Modal title="Clean up library" onClose={onClose}>
      <Cleanups>
        <li>
          <div>
            <strong>Same title and author</strong>
            <Muted>Find items that are the same book, and merge each into one.</Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('duplicates')}>
            Find duplicates…
          </Button>
        </li>
        <li>
          <div>
            <strong>Re-read metadata</strong>
            <Muted>
              Read each book’s files again to fill in what its details lack: sort names, dates, cover colours and the
              like. Nothing already there is changed, and nothing is looked up online.
            </Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('reread')}>
            Re-read…
          </Button>
        </li>
        <li>
          <div>
            <strong>Update book files</strong>
            <Muted>
              Write the library’s details (title, authors, tags, series, description and the like) into EPUBs that say
              otherwise, so the files match wherever they go. Details the library lacks are left as the file has them.
            </Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('files')}>
            Check files…
          </Button>
        </li>
      </Cleanups>
      <ModalFooter>
        <Spacer />
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}

/** Items with the same title and authors, to merge. */
export function Duplicates({ onBack, onClose }: { onBack(): void; onClose(): void }) {
  const { library, apply } = useLibrary();
  const groups = useMemo(() => findDuplicates(library), [library]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choiceOf = (group: DuplicateGroup) => {
    const choice = choices[group.key];
    // A choice made before the group changed (an item merged or removed elsewhere) no longer applies.
    return choice && group.items.some((i) => i.id === choice.keep) ? choice : defaultChoice(group);
  };

  const merge = async (merging: DuplicateGroup[]) => {
    setBusy(true);
    setError(undefined);
    try {
      // One apply, so merging many groups is one save.
      await apply(merging.flatMap((group) => {
        const choice = choiceOf(group);
        return mergeItems(library, choice.keep, mergedOf(group, choice));
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mergeable = groups.filter((group) => mergedOf(group, choiceOf(group)).length);
  return (
    <Modal title="Same title and author" onClose={onClose}>
      {groups.length ? (
        <>
          <Intro>
            {groups.length === 1 ? 'One book has' : `${groups.length.toLocaleString()} books have`} more than one item.
            Merging keeps the one chosen and adds the others’ files, tags and fields it lacks, then removes them.
          </Intro>
          <Groups>
            {groups.map((group) => (
              <DuplicateEntries
                key={group.key}
                group={group}
                choice={choiceOf(group)}
                onChoice={(choice) => setChoices({ ...choices, [group.key]: choice })}
                onMerge={() => void merge([group])}
                busy={busy}
              />
            ))}
          </Groups>
        </>
      ) : (
        <Intro>No two items share a title and author.</Intro>
      )}
      {error && <Muted as="p" role="alert">Couldn’t merge: {error}</Muted>}
      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onBack}>
          Back
        </Button>
        {mergeable.length > 1 && (
          <Button $variant="secondary" disabled={busy} onClick={() => void merge(mergeable)}>
            Merge all {mergeable.length.toLocaleString()}
          </Button>
        )}
        <Spacer />
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}

type RereadState =
  | { kind: 'running'; progress: RereadProgress }
  | { kind: 'done'; result: RereadResult }
  | { kind: 'failed'; message: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Re-reading metadata from the books' files, from when it's opened, with progress and a way to stop. */
function Reread({ onBack, onClose, pauseIndexing }: { onBack(): void; onClose(): void; pauseIndexing?: () => () => void }) {
  const { backend, apply } = useLibrary();
  const [state, setState] = useState<RereadState>({ kind: 'running', progress: { done: 0, total: 0 } });
  const stop = useRef<AbortController>(undefined);
  // Read when it starts: `apply` changes as the library does, which mustn't start it again.
  const latest = useRef({ apply, pauseIndexing });
  latest.current = { apply, pauseIndexing };

  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    const resume = latest.current.pauseIndexing?.();
    void (async () => {
      try {
        const result = await rereadMetadata(backend, await backend.getLibrary(), (ops) => latest.current.apply(ops), {
          signal: controller.signal,
          onProgress: (progress) => !controller.signal.aborted && setState({ kind: 'running', progress }),
        });
        setState({ kind: 'done', result });
      } catch (e) {
        setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      } finally {
        resume?.();
      }
    })();
    // Closing the dialog stops it; what's been read is kept.
    return () => controller.abort();
  }, [backend]);

  const running = state.kind === 'running';
  return (
    <Modal title="Re-read metadata" onClose={onClose}>
      {state.kind === 'running' && (
        <>
          <Intro>
            {state.progress.total
              ? `${state.progress.done.toLocaleString()} of ${plural(state.progress.total, 'book')} read…`
              : 'Starting…'}
          </Intro>
          <Progress value={state.progress.done} max={Math.max(state.progress.total, 1)} />
          {state.progress.current && <Current title={state.progress.current}>{state.progress.current}</Current>}
        </>
      )}
      {state.kind === 'done' && <RereadSummary result={state.result} />}
      {state.kind === 'failed' && <Muted as="p" role="alert">It stopped: {state.message}</Muted>}
      <ModalFooter>
        {running ? (
          <Button $variant="secondary" onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button $variant="secondary" onClick={onBack}>
            Back
          </Button>
        )}
        <Spacer />
        <Button disabled={running} onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export function RereadSummary({ result }: { result: RereadResult }) {
  return (
    <>
      <Intro>
        {result.stopped ? 'Stopped. ' : ''}
        {result.updated
          ? `Filled in ${plural(result.filled, 'detail')} on ${plural(result.updated, 'book')}.`
          : 'Nothing to fill in: every book has what its files say.'}
      </Intro>
      {result.notHere > 0 && (
        <Muted as="p">{plural(result.notHere, 'book')} weren’t read, as their files are on another device. Re-read there to fill them in.</Muted>
      )}
      {result.failed.length > 0 && (
        <Muted as="p">
          {plural(result.failed.length, 'book')} couldn’t be read: {result.failed.slice(0, 3).map((f) => `${f.title} (${f.message})`).join('; ')}
          {result.failed.length > 3 && '…'}
        </Muted>
      )}
    </>
  );
}

type FilesState =
  | { kind: 'finding'; progress: FileProgress }
  | { kind: 'found'; found: FindResult }
  | { kind: 'updating'; found: FindResult; progress: FileProgress }
  | { kind: 'done'; found: FindResult; result: UpdateResult }
  | { kind: 'failed'; message: string };

const FileList = styled.ul`
  max-height: min(50vh, 420px);
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;

  li {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9em;
    line-height: 1.3;
  }
`;

/**
 * Updating the books' files from the library: reads them all from when it's opened, lists those
 * that differ and what differs, and writes them when asked, with progress and a way to stop.
 */
export function UpdateFiles({
  onBack,
  onClose,
  pauseIndexing,
  carryText,
}: {
  onBack(): void;
  onClose(): void;
  pauseIndexing?: () => () => void;
  carryText?: CarryText;
}) {
  const { backend, apply } = useLibrary();
  const [state, setState] = useState<FilesState>({ kind: 'finding', progress: { done: 0, total: 0 } });
  const stop = useRef<AbortController>(undefined);
  // Read when each step starts: `apply` changes as the library does.
  const latest = useRef({ apply, pauseIndexing, carryText });
  latest.current = { apply, pauseIndexing, carryText };

  /** Runs a step with indexing paused, stoppable, and stopped if the dialog closes. */
  const run = (step: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    stop.current = controller;
    const resume = latest.current.pauseIndexing?.();
    void step(controller.signal)
      .catch((e: unknown) => setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => resume?.());
    return () => controller.abort();
  };

  useEffect(
    () =>
      run(async (signal) => {
        const onProgress = (progress: FileProgress) => !signal.aborted && setState({ kind: 'finding', progress });
        const found = await findStaleFiles(backend, await backend.getLibrary(), { signal, onProgress });
        if (!signal.aborted) setState({ kind: 'found', found });
      }),
    [backend],
  );
  // Closing the dialog stops an update; what's been written is kept.
  useEffect(() => () => stop.current?.abort(), []);

  const update = (found: FindResult) =>
    run(async (signal) => {
      setState({ kind: 'updating', found, progress: { done: 0, total: 0 } });
      const result = await updateFiles(backend, found.stale, (ops) => latest.current.apply(ops), {
        signal,
        onProgress: (progress) => setState({ kind: 'updating', found, progress }),
        ...(latest.current.carryText && { carryText: latest.current.carryText }),
      });
      setState({ kind: 'done', found, result });
    });

  const running = state.kind === 'finding' || state.kind === 'updating';
  return (
    <Modal title="Update book files" onClose={onClose}>
      {running && (
        <>
          <Intro>
            {!state.progress.total
              ? 'Starting…'
              : state.kind === 'finding'
                ? `${state.progress.done.toLocaleString()} of ${plural(state.progress.total, 'book')} checked…`
                : `${state.progress.done.toLocaleString()} of ${plural(state.progress.total, 'book')} updated…`}
          </Intro>
          <Progress value={state.progress.done} max={Math.max(state.progress.total, 1)} />
          {state.progress.current && <Current title={state.progress.current}>{state.progress.current}</Current>}
        </>
      )}
      {state.kind === 'found' && <StaleFiles found={state.found} />}
      {state.kind === 'done' && <FilesUpdated result={state.result} />}
      {state.kind === 'failed' && <Muted as="p" role="alert">It stopped: {state.message}</Muted>}
      <ModalFooter>
        {running ? (
          <Button $variant="secondary" onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button $variant="secondary" onClick={onBack}>
            Back
          </Button>
        )}
        <Spacer />
        {state.kind === 'found' && state.found.stale.length > 0 ? (
          <Button onClick={() => update(state.found)}>Update {plural(state.found.stale.length, 'file')}</Button>
        ) : (
          <Button disabled={running} onClick={onClose}>
            Done
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

/** What checking found: the files that differ from the library, and what differs in each. */
export function StaleFiles({ found }: { found: FindResult }) {
  const { stale } = found;
  return (
    <>
      <Intro>
        {found.stopped ? 'Stopped. ' : ''}
        {stale.length
          ? `${plural(stale.length, 'file')} on ${plural(new Set(stale.map((s) => s.item.id)).size, 'book')} ${stale.length === 1 ? 'differs' : 'differ'} from the library. Updating writes the library’s details into them; their text, cover and identifiers stay as they are.`
          : `Every file matches the library${found.current ? ` (${plural(found.current, 'EPUB')} checked)` : ''}.`}
      </Intro>
      {stale.length > 0 && (
        <FileList aria-label="Files to update">
          {stale.map(({ item, file, changes }) => (
            <li key={`${item.id}:${file.hash}`}>
              <span>
                {item.title} <Muted>· {formatLabel(file.format)}</Muted>
              </span>
              <Muted>{changes.join(', ')}</Muted>
            </li>
          ))}
        </FileList>
      )}
      {found.drm.length > 0 && (
        <Muted as="p">
          {plural(found.drm.length, 'file')} {found.drm.length === 1 ? 'is' : 'are'} DRM-protected, so left alone:{' '}
          {found.drm.slice(0, 3).map((f) => f.title).join('; ')}
          {found.drm.length > 3 && '…'}
        </Muted>
      )}
      <NotRead notHere={found.notHere} failed={found.failed} verb="checked" />
    </>
  );
}

export function FilesUpdated({ result }: { result: UpdateResult }) {
  return (
    <>
      <Intro>
        {result.stopped ? 'Stopped. ' : ''}
        {result.updated ? `Updated ${plural(result.updated, 'file')}.` : 'No files were updated.'}
        {result.freed > 0 && ` The old ${result.freed === 1 ? 'version was' : 'versions were'} deleted.`}
      </Intro>
      <NotRead notHere={0} failed={result.failed} verb="updated" />
    </>
  );
}

function NotRead({ notHere, failed, verb }: { notHere: number; failed: FindResult['failed']; verb: string }) {
  return (
    <>
      {notHere > 0 && (
        <Muted as="p">{plural(notHere, 'book')} weren’t {verb}, as their files are on another device. Update them there.</Muted>
      )}
      {failed.length > 0 && (
        <Muted as="p">
          {plural(failed.length, 'file')} couldn’t be {verb}: {failed.slice(0, 3).map((f) => `${f.title} (${f.message})`).join('; ')}
          {failed.length > 3 && '…'}
        </Muted>
      )}
    </>
  );
}
