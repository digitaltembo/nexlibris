import type { FileLayout, FolderChoice, Item, Library, PlacingProgress } from '@nexlibris/common';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { PLACEHOLDERS, expandPath } from '../devices/pathTemplate';
import { DEFAULT_LAYOUT, layoutProblems } from '../library/fileLayout';
import {
  browserFolderHolds,
  browserStorageHasLibrary,
  libraryPlace,
  moveBrowserLibrary,
  openBrowserFolder,
  openBrowserStorage,
  placesFor,
  type LibraryPlace,
  type Progress,
} from '../library/libraryFolder';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

/** A folder picked to move the library to, or to open the library already in it. */
export interface Target {
  name: string;
  holds: FolderChoice['holds'];
  /** In a browser. */
  folder?: FileSystemDirectoryHandle;
  /** In the desktop app. */
  path?: string;
}

type View =
  | { kind: 'overview' }
  | { kind: 'move'; target: Target }
  | { kind: 'moveBack' }
  | { kind: 'open'; target: Target }
  | { kind: 'moving'; progress?: Progress }
  | { kind: 'arranging'; progress?: PlacingProgress };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** Where the library is now, in words. */
function describePlace(place: LibraryPlace): string {
  if (place.kind === 'folder') return `in ${place.name}`;
  if (place.kind === 'app') return `in the app’s data folder (${place.name})`;
  return 'in this browser’s own storage, which only nexlibris can see';
}

/** Where moving back takes it. */
const homeOf = (place: LibraryPlace) => (place.desktop ? 'the app’s data folder' : 'this browser’s storage');

/** A book with a series and an author shows the most. */
function sampleBook(library: Library): Item | undefined {
  const items = Object.values(library.items);
  return items.find((i) => i.metadata.series && i.creators.length) ?? items.find((i) => i.creators.length) ?? items[0];
}

/** The books' files and their size, which is what moves. */
function filesOf(library: Library) {
  const sizes = new Map<string, number>();
  for (const item of Object.values(library.items)) for (const file of item.files) sizes.set(file.hash, file.size);
  return { count: sizes.size, bytes: [...sizes.values()].reduce((a, b) => a + b, 0) };
}

/**
 * Where the library is kept (`library/libraryFolder.ts`): the browser's storage or the app's data
 * folder, or a folder the user chooses, with the books laid out by templates like a CrossPoint
 * reader's. Moving it there, back, or to another folder; opening a library already in a folder;
 * and changing the layout, which moves the books.
 */
export function LibraryFolderDialog({ onClose, place = libraryPlace() }: { onClose(): void; place?: LibraryPlace }) {
  const { library } = useLibrary();
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<FileLayout>(place.placed?.fileLayout ?? DEFAULT_LAYOUT);
  /** A library left in the default place, which can be opened instead. */
  const [homeHasLibrary, setHomeHasLibrary] = useState(false);
  const problems = layoutProblems(layout);
  const changed = !!place.placed && JSON.stringify(layout) !== JSON.stringify(place.placed.fileLayout);
  const busy = view.kind === 'moving' || view.kind === 'arranging';

  useEffect(() => {
    if (place.kind !== 'folder') return;
    if (place.desktop) void place.desktop.location(null).then((l) => setHomeHasLibrary(l.defaultHasLibrary), () => undefined);
    else void browserStorageHasLibrary().then(setHomeHasLibrary, () => undefined);
  }, [place]);

  const run = async (task: () => Promise<void>) => {
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
      setView({ kind: 'overview' });
    }
  };

  const choose = () =>
    run(async () => {
      let target: Target;
      if (place.desktop) {
        const choice = await place.desktop.choose(null);
        if (!choice) return;
        target = { name: choice.path, path: choice.path, holds: choice.holds };
      } else {
        let folder: FileSystemDirectoryHandle;
        try {
          folder = await window.showDirectoryPicker!({ id: 'nexlibris-library', mode: 'readwrite' });
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          throw e;
        }
        target = { name: folder.name, folder, holds: await browserFolderHolds(folder) };
      }
      setView(target.holds === 'library' ? { kind: 'open', target } : { kind: 'move', target });
    });

  /** Moves the library to `target` (back home if none); the page then opens it there. */
  const move = (target: Target | undefined) =>
    run(async () => {
      setView({ kind: 'moving' });
      if (place.desktop) {
        await place.desktop.move(target?.path ? { to: target.path, layout, placed: Object.fromEntries(placesFor(library, layout)) } : {});
        // The app reloads the page once it's moved; until then, how it's going.
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const status = await place.desktop.status(null);
          if (status.state === 'failed') throw new Error(status.message ?? 'The library couldn’t be moved.');
          if (status.state === 'done') return;
          setView({ kind: 'moving', progress: status });
        }
      }
      await moveBrowserLibrary(library, target?.folder && { folder: target.folder, layout }, (progress) => setView({ kind: 'moving', progress }));
      location.reload();
    });

  const open = (target: Target | undefined) =>
    run(async () => {
      if (place.desktop) return void (await place.desktop.open(target?.path ? { path: target.path } : {}));
      if (target?.folder) await openBrowserFolder(target.folder);
      else await openBrowserStorage();
      location.reload();
    });

  const arrange = () =>
    run(async () => {
      const placed = place.placed!;
      setView({ kind: 'arranging' });
      const stop = placed.onPlacing((progress) => progress && setView({ kind: 'arranging', progress }));
      try {
        await placed.setLayout(layout);
      } finally {
        stop();
      }
      setView({ kind: 'overview' });
    });

  const { count, bytes } = filesOf(library);
  const footer = (children: ReactNode) => (
    <Footer>
      {children}
      {error && <ErrorText>{error}</ErrorText>}
    </Footer>
  );

  return (
    <Modal title="Library folder" onClose={busy ? () => undefined : onClose}>
      {view.kind === 'overview' && (
        <>
          <p>Your library is {describePlace(place)}.</p>
          <p>
            <Muted>
              {place.kind === 'folder'
                ? 'Its books are laid out as below; nexlibris’s own files are in the hidden .nexlibris folder there.'
                : 'It can be kept in a folder of yours instead, with the books laid out as below, where other apps and backups can see them. nexlibris’s own files go in a hidden .nexlibris folder there.'}{' '}
              Change books in nexlibris rather than moving or renaming their files yourself: it keeps track of where it put them.
            </Muted>
          </p>
          <LayoutFields layout={layout} onChange={setLayout} library={library} disabled={busy} />
          {footer(
            <>
              {changed && (
                <Button $variant="primary" disabled={problems.length > 0} onClick={() => void arrange()}>
                  Move books to match
                </Button>
              )}
              <Button $variant={changed || place.kind === 'folder' ? 'secondary' : 'primary'} disabled={problems.length > 0} onClick={() => void choose()}>
                {place.kind === 'folder' ? 'Move to another folder…' : 'Choose a folder…'}
              </Button>
              {place.kind === 'folder' &&
                (homeHasLibrary ? (
                  <Button $variant="secondary" onClick={() => void open(undefined)}>
                    Open the library in {homeOf(place)}
                  </Button>
                ) : (
                  <Button $variant="secondary" onClick={() => setView({ kind: 'moveBack' })}>
                    Move back to {homeOf(place)}
                  </Button>
                ))}
              <Button $variant="secondary" onClick={onClose}>
                Close
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === 'move' && (
        <ConfirmMove
          target={view.target}
          from={describePlace(place)}
          count={count}
          bytes={bytes}
          example={exampleOf(layout, library)}
          error={error}
          onMove={() => void move(view.target)}
          onBack={() => setView({ kind: 'overview' })}
        />
      )}

      {view.kind === 'moveBack' && (
        <>
          <p>
            Move the library from {place.name} back to {homeOf(place)}? Its {plural(count, 'file')} ({size(bytes)}) go there, and
            the books and .nexlibris folder leave {place.name}; anything else in it stays.
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void move(undefined)}>
                Move it back
              </Button>
              <Button $variant="secondary" onClick={() => setView({ kind: 'overview' })}>
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === 'open' && (
        <>
          <p>
            {view.target.name} has a nexlibris library already. Open that one? This library stays where it is ({describePlace(place)}),
            and can be opened again from here.
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void open(view.target)}>
                Open it
              </Button>
              <Button $variant="secondary" onClick={() => setView({ kind: 'overview' })}>
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {busy && <Working view={view} />}
    </Modal>
  );
}

/** Moving or arranging, with how far it's got. Nothing else can happen meanwhile. */
function Working({ view }: { view: View }) {
  const progress = view.kind === 'moving' || view.kind === 'arranging' ? view.progress : undefined;
  const what = view.kind === 'moving' ? 'Moving the library' : 'Moving books to match the layout';
  return (
    <>
      <p>
        {what}
        {progress?.total ? `: ${progress.done.toLocaleString()} of ${plural(progress.total, 'file')}…` : '…'}
      </p>
      <Bar value={progress?.done ?? 0} max={Math.max(progress?.total ?? 1, 1)} />
      <p>
        <Muted>Keep nexlibris open until it’s done.</Muted>
      </p>
    </>
  );
}

/** Where the sample book would go by the layout. */
function exampleOf(layout: FileLayout, library: Library): string | undefined {
  const sample = sampleBook(library);
  if (!sample || layoutProblems(layout).length) return undefined;
  return expandPath(layout.folder, layout.fileName || DEFAULT_LAYOUT.fileName, sample, 'epub').slice(1);
}

/** Confirming a move to a folder: what moves, and where books go there. */
export function ConfirmMove({
  target,
  from,
  count,
  bytes,
  example,
  error,
  onMove,
  onBack,
}: {
  target: Target;
  from: string;
  count: number;
  bytes: number;
  example: string | undefined;
  error?: string;
  onMove(): void;
  onBack(): void;
}) {
  return (
    <>
      <p>
        Move the library to <strong>{target.name}</strong>? Its {plural(count, 'file')} ({size(bytes)}) go there
        {example && (
          <>
            , books like <Path>{example}</Path>
          </>
        )}
        . It won’t be {from} any more.
      </p>
      {target.holds === 'files' && (
        <p>
          <Muted>The folder has other files in it, which stay as they are. A book whose place one of them has waits in .nexlibris.</Muted>
        </p>
      )}
      <Footer>
        <Button $variant="primary" onClick={onMove}>
          Move it
        </Button>
        <Button $variant="secondary" onClick={onBack}>
          Back
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Footer>
    </>
  );
}

/** The folder and file name templates, with what's wrong and an example. */
function LayoutFields({
  layout,
  onChange,
  library,
  disabled,
}: {
  layout: FileLayout;
  onChange(layout: FileLayout): void;
  library: Library;
  disabled: boolean;
}) {
  const example = useMemo(() => exampleOf(layout, library), [layout, library]);
  const problems = layoutProblems(layout);
  return (
    <>
      <Field>
        Book folders
        <input value={layout.folder} disabled={disabled} spellCheck={false} onChange={(e) => onChange({ ...layout, folder: e.target.value })} />
        <small>
          Each book’s folder in the library folder, from its details: {PLACEHOLDERS.map((p) => `<${p.key}>`).join(', ')}; &lt;authorSort:1&gt; for
          its first letter; [ … ] for a part kept only when everything in it has a value, as in [&lt;series&gt;/].
        </small>
      </Field>
      <Field>
        File names
        <input
          value={layout.fileName}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange({ ...layout, fileName: e.target.value })}
        />
        <small>Without the extension, which is the format (Dune.epub, Dune.x4.epub). A clash gets “(2)”.</small>
      </Field>
      {problems.map((p) => (
        <ErrorText key={p}>{p}</ErrorText>
      ))}
      {example && (
        <p>
          <small>
            For example: <Path>{example}</Path>
          </small>
        </p>
      )}
    </>
  );
}

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;

  small {
    color: var(--muted);
  }
`;

const Footer = styled(ModalFooter)`
  flex-wrap: wrap;
`;

const Path = styled.code`
  overflow-wrap: anywhere;
`;

const Bar = styled.progress`
  width: 100%;
`;

const ErrorText = styled.p`
  margin: 8px 0 0;
  color: var(--danger);
  flex-basis: 100%;
`;
