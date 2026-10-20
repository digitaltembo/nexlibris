import {
  type CloudLibraryStatus,
  type FileLayout,
  type FolderChoice,
  type Item,
  type Library,
  type PlacingProgress,
  type SessionInfo,
} from "@nexlibris/common";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import styled from "styled-components";
import { PLACEHOLDERS, expandPath } from "../devices/pathTemplate";
import { DEFAULT_LAYOUT, layoutProblems } from "../library/fileLayout";
import { choosesServer, serverApi, useServerSession } from "../library/account";
import {
  browserFolderHolds,
  browserStorageHasLibrary,
  libraryPlace,
  moveBrowserLibrary,
  moveFromCloud,
  copyAppLibraryToCloud,
  moveToCloud,
  openDeviceLibrary,
  openBrowserFolder,
  openBrowserStorage,
  openCloud,
  placesFor,
  type LibraryPlace,
  type Progress,
} from "../library/libraryFolder";
import { useLibrary } from "../library/LibraryContext";
import { canUseFolders } from "../library/savedFolders";
import { Button, Muted, NoticeBox } from "../styles/ui";
import { Modal, ModalFooter } from "./Modal";

/** A folder picked to move the library to, or to open the library already in it. */
export interface Target {
  name: string;
  holds: FolderChoice["holds"];
  /** In a browser. */
  folder?: FileSystemDirectoryHandle;
  /** In the apps: what names it to the app (a path, or Android's tree URI). */
  path?: string;
}

type View =
  | { kind: "overview" }
  | { kind: "move"; target: Target }
  | { kind: "moveBack" }
  | { kind: "open"; target: Target }
  | { kind: "toCloud" }
  | { kind: "fromCloud" }
  | { kind: "moving"; progress?: Progress }
  | { kind: "arranging"; progress?: PlacingProgress };

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** Where the library is now, in words. */
function describePlace(place: LibraryPlace): string {
  if (place.kind === "cloud")
    return `in your account (${place.name}) on this server`;
  if (place.kind === "folder") return `in ${place.name}`;
  if (place.app === "desktop")
    return `in the app’s data folder (${place.name})`;
  if (place.app === "android")
    return "in the app’s own storage, which only nexlibris can see";
  return "in this browser’s own storage, which only nexlibris can see";
}

/** Where moving back takes it. */
const homeOf = (place: LibraryPlace) =>
  place.app === "desktop"
    ? "the app’s data folder"
    : place.app === "android"
      ? "the app’s own storage"
      : "this browser’s storage";

/**
 * What keeping the library in a folder costs here, against the app's or browser's own storage.
 * Nothing in the desktop app, where both are plain files.
 */
function folderTradeoffs(place: LibraryPlace): string | undefined {
  if (place.app === "desktop") return undefined;
  if (place.app === "android") {
    return (
      "In a folder, every file goes through Android’s storage provider, which is slower than the app’s own storage: books and covers " +
      "open a little more slowly, and importing, converting and moving books takes noticeably longer. In return, file managers, " +
      "other apps and a computer plugged in by USB can see the books, and they stay if nexlibris is uninstalled, which deletes " +
      "its own storage. No permission is needed beyond the folder you pick."
    );
  }
  return (
    "In a folder, saving is slower: the browser writes each file to a temporary copy and checks it before putting it in place, so " +
    "importing, converting and moving books takes longer than in its own storage, though reading is about as quick. The browser " +
    "also asks again to let nexlibris use the folder after it restarts (one click; Chrome remembers if you choose “Allow on every " +
    "visit”). In return, other apps and backups can see the books, and clearing the browser’s data for this site doesn’t delete them."
  );
}

/** A book with a series and an author shows the most. */
function sampleBook(library: Library): Item | undefined {
  const items = Object.values(library.items);
  return (
    items.find((i) => i.metadata.series && i.creators.length) ??
    items.find((i) => i.creators.length) ??
    items[0]
  );
}

/** The books' files and their size, which is what moves. */
function filesOf(library: Library) {
  const sizes = new Map<string, number>();
  for (const item of Object.values(library.items))
    for (const file of item.files) sizes.set(file.hash, file.size);
  return {
    count: sizes.size,
    bytes: [...sizes.values()].reduce((a, b) => a + b, 0),
  };
}

/**
 * Where the library is kept (`library/libraryFolder.ts`): the browser's or the app's own storage,
 * or a folder the user chooses (with what that costs, outside the desktop app), with the books laid out by templates like a CrossPoint
 * reader's. Moving it there, back, or to another folder; opening a library already in a folder;
 * and changing the layout, which moves the books. On a page from a nexlibris server, the account
 * too: moving the library there and back, or keeping a copy there that it syncs with.
 */
export function LibraryFolderDialog({
  onClose,
  place = libraryPlace(),
  session: givenSession,
  cloud: givenCloud,
  onAccount,
  onSyncWithAccount,
  app = choosesServer(),
}: {
  onClose(): void;
  place?: LibraryPlace;
  /** For stories: the server's session, and what the account holds, rather than asking. */
  session?: SessionInfo;
  cloud?: CloudLibraryStatus;
  /** Opens the Account dialog, to sign in. */
  onAccount?(): void;
  /** Pairs this library with the account's, to keep a copy there (Connections). */
  onSyncWithAccount?(): void;
  /** Whether this is an app (desktop or Android), which chooses its server; for stories. */
  app?: boolean;
}) {
  const { library, backend } = useLibrary();
  const askedSession = useServerSession();
  const session = givenSession ?? askedSession;
  const [askedCloud, setCloud] = useState<CloudLibraryStatus>();
  const cloud = givenCloud ?? askedCloud;
  const [view, setView] = useState<View>({ kind: "overview" });
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<FileLayout>(
    place.placed?.fileLayout ?? DEFAULT_LAYOUT,
  );
  /** A library left in the default place, which can be opened instead. */
  const [homeHasLibrary, setHomeHasLibrary] = useState(false);
  const problems = layoutProblems(layout);
  const changed =
    !!place.placed &&
    JSON.stringify(layout) !== JSON.stringify(place.placed.fileLayout);
  const busy = view.kind === "moving" || view.kind === "arranging";

  useEffect(() => {
    if (givenCloud || !session?.account || place.kind === "cloud") return;
    void Promise.resolve()
      .then(() => serverApi().library.status(null))
      .then(setCloud, () => undefined);
  }, [session, place, givenCloud]);

  useEffect(() => {
    if (place.kind === "cloud")
      void browserStorageHasLibrary().then(setHomeHasLibrary, () => undefined);
    if (place.kind !== "folder") return;
    if (place.native)
      void place.native.location(null).then(
        (l) => setHomeHasLibrary(l.defaultHasLibrary),
        () => undefined,
      );
    else
      void browserStorageHasLibrary().then(setHomeHasLibrary, () => undefined);
  }, [place]);

  const run = async (task: () => Promise<void>) => {
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
      setView({ kind: "overview" });
    }
  };

  const choose = () =>
    run(async () => {
      let target: Target;
      if (place.native) {
        const choice = await place.native.choose(null);
        if (!choice) return;
        target = {
          name: choice.name ?? choice.path,
          path: choice.path,
          holds: choice.holds,
        };
      } else {
        let folder: FileSystemDirectoryHandle;
        try {
          folder = await window.showDirectoryPicker!({
            id: "nexlibris-library",
            mode: "readwrite",
          });
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          throw e;
        }
        target = {
          name: folder.name,
          folder,
          holds: await browserFolderHolds(folder),
        };
      }
      setView(
        target.holds === "library"
          ? { kind: "open", target }
          : { kind: "move", target },
      );
    });

  /** Moves the library to `target` (back home if none); the page then opens it there. */
  const move = (target: Target | undefined) =>
    run(async () => {
      setView({ kind: "moving" });
      if (place.native) {
        await place.native.move(
          target?.path
            ? {
                to: target.path,
                layout,
                placed: Object.fromEntries(placesFor(library, layout)),
              }
            : {},
        );
        // The app reloads the page once it's moved; until then, how it's going.
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const status = await place.native.status(null);
          if (status.state === "failed")
            throw new Error(status.message ?? "The library couldn’t be moved.");
          if (status.state === "done") return;
          setView({ kind: "moving", progress: status });
        }
      }
      await moveBrowserLibrary(
        library,
        target?.folder && { folder: target.folder, layout },
        (progress) => setView({ kind: "moving", progress }),
      );
      location.reload();
    });

  const open = (target: Target | undefined) =>
    run(async () => {
      if (place.native)
        return void (await place.native.open(
          target?.path ? { path: target.path } : {},
        ));
      if (target?.folder) await openBrowserFolder(target.folder);
      else await openBrowserStorage();
      location.reload();
    });

  const arrange = () =>
    run(async () => {
      const placed = place.placed!;
      setView({ kind: "arranging" });
      const stop = placed.onPlacing(
        (progress) => progress && setView({ kind: "arranging", progress }),
      );
      try {
        await placed.setLayout(layout);
      } finally {
        stop();
      }
      setView({ kind: "overview" });
    });

  const toCloud = () =>
    run(async () => {
      setView({ kind: "moving" });
      const onProgress = (progress: Progress) =>
        setView({ kind: "moving", progress });
      await (app
        ? copyAppLibraryToCloud(backend, onProgress)
        : moveToCloud(backend, onProgress));
      location.reload();
    });

  const fromCloud = () =>
    run(async () => {
      setView({ kind: "moving" });
      await moveFromCloud((progress) => setView({ kind: "moving", progress }));
      location.reload();
    });

  const { count, bytes } = filesOf(library);
  const canPick = place.kind !== "cloud" && (!!place.native || canUseFolders());
  const tradeoffs = canPick ? folderTradeoffs(place) : undefined;
  const footer = (children: ReactNode) => (
    <Footer>
      {children}
      {error && <ErrorText>{error}</ErrorText>}
    </Footer>
  );

  return (
    <Modal title="Library folder" onClose={busy ? () => undefined : onClose}>
      {view.kind === "overview" && (
        <>
          <p>
            Your library is {describePlace(place)}.{" "}
            {count
              ? `It has ${plural(count, "file")}, for a total size of ${size(bytes)}, not counting metadata`
              : "It is empty."}
          </p>
          {(session || app) && (
            <AccountSection
              session={session}
              app={app}
              place={place}
              cloud={cloud}
              homeHasLibrary={homeHasLibrary}
              onAccount={onAccount}
              onMoveThere={() => setView({ kind: "toCloud" })}
              onMoveBack={() => setView({ kind: "fromCloud" })}
              onOpenThere={() =>
                void run(async () => (openCloud(), location.reload()))
              }
              onOpenHere={() =>
                void (app
                  ? run(async () => (openDeviceLibrary(), location.reload()))
                  : open(undefined))
              }
              onSync={onSyncWithAccount}
            />
          )}
          {place.lost && (
            <Notice role="status">
              nexlibris can no longer use the folder {place.lost}, where the
              library was: the folder was deleted or moved, or its permission
              was taken back. Choose it again to open the library there.
            </Notice>
          )}
          {canPick ? (
            <p>
              <Muted>
                {place.kind === "folder"
                  ? "Its books are laid out as below; nexlibris’s own files are in the hidden .nexlibris folder there."
                  : "It can be kept in a folder of yours instead, with the books laid out as below, where other apps and backups can see them. nexlibris’s own files go in a hidden .nexlibris folder there."}{" "}
                Change books in nexlibris rather than moving or renaming their
                files yourself: it keeps track of where it put them.
              </Muted>
            </p>
          ) : (
            place.kind !== "cloud" && (
              <p>
                <Muted>
                  This browser can’t keep the library in a folder of yours: that
                  needs the File System Access API, which Chrome and Edge have,
                  as do nexlibris’s desktop and Android apps.
                </Muted>
              </p>
            )
          )}
          {tradeoffs && (
            <p>
              <Muted>{tradeoffs}</Muted>
            </p>
          )}
          {canPick && (
            <LayoutFields
              layout={layout}
              onChange={setLayout}
              library={library}
              disabled={busy}
            />
          )}
          {footer(
            <>
              {changed && (
                <Button
                  $variant="primary"
                  disabled={problems.length > 0}
                  onClick={() => void arrange()}
                >
                  Move books to match
                </Button>
              )}
              {canPick && (
                <Button
                  $variant={
                    changed || place.kind === "folder" ? "secondary" : "primary"
                  }
                  disabled={problems.length > 0}
                  onClick={() => void choose()}
                >
                  {place.kind === "folder"
                    ? "Move to another folder…"
                    : "Choose a folder…"}
                </Button>
              )}
              {place.kind === "folder" &&
                (homeHasLibrary ? (
                  <Button
                    $variant="secondary"
                    onClick={() => void open(undefined)}
                  >
                    Open the library in {homeOf(place)}
                  </Button>
                ) : (
                  <Button
                    $variant="secondary"
                    onClick={() => setView({ kind: "moveBack" })}
                  >
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

      {view.kind === "move" && (
        <ConfirmMove
          target={view.target}
          from={describePlace(place)}
          count={count}
          bytes={bytes}
          example={exampleOf(layout, library)}
          error={error}
          onMove={() => void move(view.target)}
          onBack={() => setView({ kind: "overview" })}
        />
      )}

      {view.kind === "toCloud" && app && (
        <>
          <p>
            Copy the library to your account
            {session?.account && <> ({session.account.name})</>}, and use it
            from there? Its {plural(count, "file")} ({size(bytes)}) go there,
            checked as they arrive; afterwards this app opens your account’s
            library, here or on any device you sign in on.
          </p>
          <p>
            <Muted>
              This device’s own library stays where it is, as it is, and can be
              opened again from here. Its connections to other devices stay with
              it.
            </Muted>
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void toCloud()}>
                Copy it and use it there
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "toCloud" && !app && (
        <>
          <p>
            Move the library to your account
            {session?.account && <> ({session.account.name})</>}? Its{" "}
            {plural(count, "file")} ({size(bytes)}) go there, checked as they
            arrive, then it’s deleted from this browser. Afterwards you open it
            by signing in, here or anywhere else.
          </p>
          <p>
            <Muted>
              This browser’s own records stay behind: its connections to other
              devices need pairing again from the account, and the text index
              and covers’ thumbnails are made again.
            </Muted>
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void toCloud()}>
                Move it
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "fromCloud" && (
        <>
          <p>
            Move the library from your account into this browser? Its{" "}
            {plural(count, "file")} ({size(bytes)}) come here, then it’s deleted
            from your account, and your other devices can’t open it there any
            more.
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void fromCloud()}>
                Move it here
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "moveBack" && (
        <>
          <p>
            Move the library from {place.name} back to {homeOf(place)}? Its{" "}
            {plural(count, "file")} ({size(bytes)}) go there, and the books and
            .nexlibris folder leave {place.name}; anything else in it stays.
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void move(undefined)}>
                Move it back
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                Back
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "open" && (
        <>
          <p>
            {view.target.name} has a nexlibris library already. Open that one?
            This library stays where it is ({describePlace(place)}), and can be
            opened again from here.
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void open(view.target)}>
                Open it
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
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

/** The account on this instance's server: where the library can go besides this browser, or this device. */
export function AccountSection({
  session,
  app = false,
  place,
  cloud,
  homeHasLibrary,
  onAccount,
  onMoveThere,
  onMoveBack,
  onOpenThere,
  onOpenHere,
  onSync,
}: {
  /** None in an app that hasn't chosen a server, or can't reach it. */
  session: SessionInfo | undefined;
  /** In the desktop and Android apps, which keep their own library beside the account's, rather than moving it. */
  app?: boolean;
  place: LibraryPlace;
  /** What the account holds, once known. */
  cloud: CloudLibraryStatus | undefined;
  /** When the library is in the account: whether this browser has one of its own too. */
  homeHasLibrary: boolean;
  onAccount?: () => void;
  onMoveThere(): void;
  onMoveBack(): void;
  onOpenThere(): void;
  onOpenHere(): void;
  onSync?: () => void;
}) {
  if (!session?.account) {
    return (
      <AccountBox>
        <h3>Your account</h3>
        <Muted as="p">
          {session
            ? `Sign in to ${session.name} to keep your library in your account, where your other devices can open it, or to keep a copy there that this one syncs with.`
            : "Sign in to a nexlibris server, one you run yourself or one run for you, to keep your library in your account there, where your other devices can open it, or to keep a copy there that this device syncs with."}
        </Muted>
        {onAccount && (
          <Button $variant="secondary" onClick={onAccount}>
            {session ? "Sign in…" : "Choose a server…"}
          </Button>
        )}
      </AccountBox>
    );
  }
  if (place.kind === "cloud") {
    return (
      <AccountBox>
        <Muted as="p">
          It’s the same wherever you sign in. To keep a copy on a device too,
          open the library in that device’s own storage and connect it to your
          account from Connections.
        </Muted>
        <Choices>
          {app ? (
            <Button $variant="secondary" onClick={onOpenHere}>
              Open this device’s library
            </Button>
          ) : homeHasLibrary ? (
            <Button $variant="secondary" onClick={onOpenHere}>
              Open this browser’s library
            </Button>
          ) : (
            <Button $variant="secondary" onClick={onMoveBack}>
              Move it to this browser…
            </Button>
          )}
        </Choices>
      </AccountBox>
    );
  }
  return (
    <AccountBox>
      <h3>Your account</h3>
      {!cloud ? (
        <Muted as="p">Looking in your account…</Muted>
      ) : cloud.exists ? (
        <>
          <Muted as="p">
            Your account ({session.account.name}) has a library already, of{" "}
            {cloud.items.toLocaleString()}{" "}
            {cloud.items === 1 ? "book" : "books"}. Open that one instead (this
            one stays {app ? "on this device" : "here"}), or keep the two in
            sync, as two devices are.
          </Muted>
          <Choices>
            <Button $variant="secondary" onClick={onOpenThere}>
              Open your account’s library
            </Button>
            {onSync && (
              <Button $variant="secondary" onClick={onSync}>
                Sync this one with it…
              </Button>
            )}
          </Choices>
        </>
      ) : (
        <>
          <Muted as="p">
            {app ? "Copy" : "Move"} the library to your account (
            {session.account.name}) and open it from anywhere you sign in, or
            keep it here and keep a copy there, which it syncs with like another
            device.
          </Muted>
          <Choices>
            <Button
              $variant="secondary"
              disabled={!app && place.kind !== "browser"}
              onClick={onMoveThere}
            >
              {app ? "Use it from your account…" : "Move to your account…"}
            </Button>
            {onSync && (
              <Button $variant="secondary" onClick={onSync}>
                Keep a copy there too…
              </Button>
            )}
          </Choices>
          {!app && place.kind !== "browser" && (
            <Muted as="p">
              To move it to your account, move it back into this browser’s
              storage first.
            </Muted>
          )}
        </>
      )}
    </AccountBox>
  );
}

/** Moving or arranging, with how far it's got. Nothing else can happen meanwhile. */
function Working({ view }: { view: View }) {
  const progress =
    view.kind === "moving" || view.kind === "arranging"
      ? view.progress
      : undefined;
  const what =
    view.kind === "moving"
      ? "Moving the library"
      : "Moving books to match the layout";
  return (
    <>
      <p>
        {what}
        {progress?.total
          ? `: ${progress.done.toLocaleString()} of ${plural(progress.total, "file")}…`
          : "…"}
      </p>
      <Bar
        value={progress?.done ?? 0}
        max={Math.max(progress?.total ?? 1, 1)}
      />
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
  return expandPath(
    layout.folder,
    layout.fileName || DEFAULT_LAYOUT.fileName,
    sample,
    "epub",
  ).slice(1);
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
        Move the library to <strong>{target.name}</strong>? Its{" "}
        {plural(count, "file")} ({size(bytes)}) go there
        {example && (
          <>
            , books like <Path>{example}</Path>
          </>
        )}
        . It won’t be {from} any more.
      </p>
      {target.holds === "files" && (
        <p>
          <Muted>
            The folder has other files in it, which stay as they are. A book
            whose place one of them has waits in .nexlibris.
          </Muted>
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
        <input
          value={layout.folder}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange({ ...layout, folder: e.target.value })}
        />
        <small>
          Each book’s folder in the library folder, from its details:{" "}
          {PLACEHOLDERS.map((p) => `<${p.key}>`).join(", ")};
          &lt;authorSort:1&gt; for its first letter; [ … ] for a part kept only
          when everything in it has a value, as in [&lt;series&gt;/].
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
        <small>
          Without the extension, which is the format (Dune.epub, Dune.x4.epub).
          A clash gets “(2)”.
        </small>
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

const AccountBox = styled.section`
  margin: 12px 0;

  h3 {
    margin: 0 0 4px;
    font-size: 1rem;
  }

  p {
    margin: 0 0 8px;
  }
`;

const Choices = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;

const Notice = styled(NoticeBox)`
  margin: 8px 0;
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
