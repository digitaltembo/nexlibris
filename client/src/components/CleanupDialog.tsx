import type { FileHash, Item, ItemId } from '@nexlibris/common';
import { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { findDuplicates, mergeItems, type DuplicateGroup } from '../library/dedupe';
import { useLibrary } from '../library/LibraryContext';
import { rereadMetadata, type RereadProgress, type RereadResult } from '../library/reread';
import { filesBehind } from '../library/fileMetadata';
import { changeLabel, findStaleFiles, updateFiles, type FindResult, type Progress as FileProgress, type UpdateResult } from '../library/updateFiles';
import { Badge, Button, Muted, Spacer } from '../styles/ui';
import { Cover, PlaceholderTitle } from './Cover';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';
import { t } from '../i18n';

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
  const formats = [...new Set(item.files.map((f) => formatLabel(f.format)))].join(t('common.listJoin')) || t('cleanup.noFiles');
  const series = typeof item.metadata.series === 'string' ? item.metadata.series : undefined;
  const isbn = Object.entries(item.identifiers).find(([key]) => key.startsWith('isbn'))?.[1];
  const added = t('cleanup.added', { date: new Date(item.addedAt).toLocaleDateString() });
  return { formats, detail: [added, series, isbn && t('cleanup.isbn', { isbn })].filter(Boolean).join(t('common.list')) };
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
        {first.title} <Muted>{t('cleanup.authors', { authors })}</Muted>
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
                aria-label={t('cleanup.keep', { formats, detail })}
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
              <Badge>{t('cleanup.kept')}</Badge>
            ) : (
              <label title={t('cleanup.mergeInto')}>
                <input
                  type="checkbox"
                  aria-label={t('cleanup.merge', { formats, detail })}
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
          {t('cleanup.mergeN', { count: merging + 1 })}
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
  const { library } = useLibrary();
  const [view, setView] = useState<View>('menu');
  const back = () => setView('menu');
  // Known without reading any file: those whose book's details changed since they were written.
  const behind = Object.values(library.items).reduce((n, item) => n + filesBehind(item).length, 0);
  const indexing = { ...(pauseIndexing && { pauseIndexing }), ...(carryText && { carryText }) };
  if (view === 'duplicates') return <Duplicates onBack={back} onClose={onClose} />;
  if (view === 'reread') return <Reread onBack={back} onClose={onClose} {...(pauseIndexing && { pauseIndexing })} />;
  if (view === 'files') return <UpdateFiles onBack={back} onClose={onClose} {...indexing} />;
  return (
    <Modal title={t('cleanup.title')} onClose={onClose}>
      <Cleanups>
        <li>
          <div>
            <strong>{t('cleanup.duplicates')}</strong>
            <Muted>{t('cleanup.duplicatesExplain')}</Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('duplicates')}>
            {t('cleanup.findDuplicates')}
          </Button>
        </li>
        <li>
          <div>
            <strong>{t('cleanup.reread')}</strong>
            <Muted>{t('cleanup.rereadExplain')}</Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('reread')}>
            {t('cleanup.rereadButton')}
          </Button>
        </li>
        <li>
          <div>
            <strong>{t('cleanup.updateFiles')}</strong>
            <Muted>
              {t('cleanup.updateFilesExplain')}
              {behind > 0 && t('cleanup.behind', count(behind))}
            </Muted>
          </div>
          <Button $variant="secondary" onClick={() => setView('files')}>
            {t('cleanup.checkFiles')}
          </Button>
        </li>
      </Cleanups>
      <ModalFooter>
        <Spacer />
        <Button onClick={onClose}>{t('common.done')}</Button>
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
    <Modal title={t('cleanup.duplicates')} onClose={onClose}>
      {groups.length ? (
        <>
          <Intro>
            {t('cleanup.groups', count(groups.length))}
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
        <Intro>{t('cleanup.noDuplicates')}</Intro>
      )}
      {error && <Muted as="p" role="alert">{t('cleanup.mergeFailed', { error })}</Muted>}
      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onBack}>
          {t('common.back')}
        </Button>
        {mergeable.length > 1 && (
          <Button $variant="secondary" disabled={busy} onClick={() => void merge(mergeable)}>
            {t('cleanup.mergeAll', { n: mergeable.length.toLocaleString() })}
          </Button>
        )}
        <Spacer />
        <Button onClick={onClose}>{t('common.done')}</Button>
      </ModalFooter>
    </Modal>
  );
}

type RereadState =
  | { kind: 'running'; progress: RereadProgress }
  | { kind: 'done'; result: RereadResult }
  | { kind: 'failed'; message: string };

/** `count` for a plural form, and `n` the number as the locale writes it. */
const count = (n: number) => ({ count: n, n: n.toLocaleString() });

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
    <Modal title={t('cleanup.reread')} onClose={onClose}>
      {state.kind === 'running' && (
        <>
          <Intro>
            {state.progress.total
              ? t('cleanup.read', { done: state.progress.done.toLocaleString(), ...count(state.progress.total) })
              : t('cleanup.starting')}
          </Intro>
          <Progress value={state.progress.done} max={Math.max(state.progress.total, 1)} />
          {state.progress.current && <Current title={state.progress.current}>{state.progress.current}</Current>}
        </>
      )}
      {state.kind === 'done' && <RereadSummary result={state.result} />}
      {state.kind === 'failed' && <Muted as="p" role="alert">{t('cleanup.stopped', { message: state.message })}</Muted>}
      <ModalFooter>
        {running ? (
          <Button $variant="secondary" onClick={() => stop.current?.abort()}>
            {t('cleanup.stop')}
          </Button>
        ) : (
          <Button $variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
        )}
        <Spacer />
        <Button disabled={running} onClick={onClose}>
          {t('common.done')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export function RereadSummary({ result }: { result: RereadResult }) {
  return (
    <>
      <Intro>
        {result.stopped ? t('cleanup.stoppedPrefix') : ''}
        {result.updated
          ? t('cleanup.filled', { details: t('cleanup.details', count(result.filled)), books: t('cleanup.books', count(result.updated)) })
          : t('cleanup.nothingToFill')}
      </Intro>
      {result.notHere > 0 && (
        <Muted as="p">{t('cleanup.rereadNotHere', count(result.notHere))}</Muted>
      )}
      {result.failed.length > 0 && (
        <Muted as="p">
          {t('cleanup.rereadFailed', { ...count(result.failed.length), list: result.failed.slice(0, 3).map((f) => t('cleanup.failure', f)).join(t('cleanup.failureSeparator')) })}
          {result.failed.length > 3 && t('cleanup.ellipsis')}
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
        // Files found in step are known to be current from now on, until the book is edited.
        if (found.fingerprints.length) await latest.current.apply(found.fingerprints);
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
    <Modal title={t('cleanup.updateFiles')} onClose={onClose}>
      {running && (
        <>
          <Intro>
            {!state.progress.total
              ? t('cleanup.starting')
              : t(state.kind === 'finding' ? 'cleanup.checked' : 'cleanup.updated', {
                  done: state.progress.done.toLocaleString(),
                  ...count(state.progress.total),
                })}
          </Intro>
          <Progress value={state.progress.done} max={Math.max(state.progress.total, 1)} />
          {state.progress.current && <Current title={state.progress.current}>{state.progress.current}</Current>}
        </>
      )}
      {state.kind === 'found' && <StaleFiles found={state.found} />}
      {state.kind === 'done' && <FilesUpdated result={state.result} />}
      {state.kind === 'failed' && <Muted as="p" role="alert">{t('cleanup.stopped', { message: state.message })}</Muted>}
      <ModalFooter>
        {running ? (
          <Button $variant="secondary" onClick={() => stop.current?.abort()}>
            {t('cleanup.stop')}
          </Button>
        ) : (
          <Button $variant="secondary" onClick={onBack}>
            {t('common.back')}
          </Button>
        )}
        <Spacer />
        {state.kind === 'found' && state.found.stale.length > 0 ? (
          <Button onClick={() => update(state.found)}>{t('cleanup.update', { files: t('cleanup.files', count(state.found.stale.length)) })}</Button>
        ) : (
          <Button disabled={running} onClick={onClose}>
            {t('common.done')}
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
        {found.stopped ? t('cleanup.stoppedPrefix') : ''}
        {stale.length
          ? t('cleanup.stale', {
              count: stale.length,
              files: t('cleanup.files', count(stale.length)),
              books: t('cleanup.books', count(new Set(stale.map((s) => s.item.id)).size)),
            })
          : found.current
            ? t('cleanup.allMatchChecked', { epubs: t('cleanup.epubs', count(found.current)) })
            : t('cleanup.allMatch')}
      </Intro>
      {stale.length > 0 && (
        <FileList aria-label={t('cleanup.filesToUpdate')}>
          {stale.map(({ item, file, changes }) => (
            <li key={`${item.id}:${file.hash}`}>
              <span>
                {item.title} <Muted>{t('cleanup.format', { format: formatLabel(file.format) })}</Muted>
              </span>
              <Muted>{changes.map(changeLabel).join(t('common.listJoin'))}</Muted>
            </li>
          ))}
        </FileList>
      )}
      {found.drm.length > 0 && (
        <Muted as="p">
          {t('cleanup.drm', { ...count(found.drm.length), list: found.drm.slice(0, 3).map((f) => f.title).join(t('cleanup.failureSeparator')) })}
          {found.drm.length > 3 && t('cleanup.ellipsis')}
        </Muted>
      )}
      <NotRead notHere={found.notHere} failed={found.failed} kind="checked" />
    </>
  );
}

export function FilesUpdated({ result }: { result: UpdateResult }) {
  return (
    <>
      <Intro>
        {result.stopped ? t('cleanup.stoppedPrefix') : ''}
        {result.updated ? t('cleanup.updatedFiles', { files: t('cleanup.files', count(result.updated)) }) : t('cleanup.noneUpdated')}
        {result.freed > 0 && t('cleanup.freed', { count: result.freed })}
      </Intro>
      <NotRead notHere={0} failed={result.failed} kind="updated" />
    </>
  );
}

function NotRead({ notHere, failed, kind }: { notHere: number; failed: FindResult['failed']; kind: 'checked' | 'updated' }) {
  return (
    <>
      {notHere > 0 && (
        <Muted as="p">{t(`cleanup.notHere.${kind}`, count(notHere))}</Muted>
      )}
      {failed.length > 0 && (
        <Muted as="p">
          {t(`cleanup.notDone.${kind}`, { ...count(failed.length), list: failed.slice(0, 3).map((f) => t('cleanup.failure', f)).join(t('cleanup.failureSeparator')) })}
          {failed.length > 3 && t('cleanup.ellipsis')}
        </Muted>
      )}
    </>
  );
}
