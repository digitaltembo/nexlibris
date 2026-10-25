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
import { t, tn } from "../i18n";

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
const fileCount = (count: number) =>
  t("libraryFolderDialog.files", { count, n: count.toLocaleString() });
const size = (bytes: number) =>
  bytes >= 1e9
    ? t("size.gigabytes", { count: (bytes / 1e9).toFixed(1) })
    : bytes >= 1e6
      ? t("size.megabytes", { count: Math.round(bytes / 1e6) })
      : t("size.kilobytes", { count: Math.max(1, Math.round(bytes / 1e3)) });

/** Where the library is now, in words. */
function describePlace(place: LibraryPlace): string {
  if (place.kind === "cloud")
    return t("libraryFolderDialog.place.cloud", { name: place.name });
  if (place.kind === "folder") return t("libraryFolderDialog.place.folder", { name: place.name });
  if (place.app === "desktop")
    return t("libraryFolderDialog.place.desktop", { name: place.name });
  if (place.app === "android" || place.app === "ios")
    return t("libraryFolderDialog.place.app");
  return t("libraryFolderDialog.place.browser");
}

/** Where moving back takes it. */
const homeOf = (place: LibraryPlace) =>
  place.app === "desktop"
    ? t("libraryFolderDialog.home.desktop")
    : place.app === "android" || place.app === "ios"
      ? t("libraryFolderDialog.home.app")
      : t("libraryFolderDialog.home.browser");

/**
 * What keeping the library in a folder costs here, against the app's or browser's own storage.
 * Nothing in the desktop app, where both are plain files.
 */
function folderTradeoffs(place: LibraryPlace): string | undefined {
  if (place.app === "desktop") return undefined;
  if (place.app === "android") {
    return t("libraryFolderDialog.tradeoffs.android");
  }
  if (place.app === "ios") {
    return t("libraryFolderDialog.tradeoffs.ios");
  }
  return t("libraryFolderDialog.tradeoffs.browser");
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
  /** Whether this is an app (desktop, Android or iOS), which chooses its server; for stories. */
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
            throw new Error(status.message ?? t("libraryFolderDialog.moveFailed"));
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
    <Modal title={t("libraryFolderDialog.title")} onClose={busy ? () => undefined : onClose}>
      {view.kind === "overview" && (
        <>
          <p>
            {t("libraryFolderDialog.where", { place: describePlace(place) })}{" "}
            {count
              ? t("libraryFolderDialog.has", { files: fileCount(count), size: size(bytes) })
              : t("libraryFolderDialog.empty")}
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
              {t("libraryFolderDialog.lost", { folder: place.lost })}
            </Notice>
          )}
          {canPick ? (
            <p>
              <Muted>
                {place.kind === "folder"
                  ? t("libraryFolderDialog.laidOut")
                  : t("libraryFolderDialog.canFolder")}{" "}
                {t("libraryFolderDialog.dontMove")}
              </Muted>
            </p>
          ) : (
            place.kind !== "cloud" && (
              <p>
                <Muted>
                  {t("libraryFolderDialog.noFolders")}
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
                  {t("libraryFolderDialog.arrange")}
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
                    ? t("libraryFolderDialog.another")
                    : t("libraryFolderDialog.choose")}
                </Button>
              )}
              {place.kind === "folder" &&
                (homeHasLibrary ? (
                  <Button
                    $variant="secondary"
                    onClick={() => void open(undefined)}
                  >
                    {t("libraryFolderDialog.openIn", { home: homeOf(place) })}
                  </Button>
                ) : (
                  <Button
                    $variant="secondary"
                    onClick={() => setView({ kind: "moveBack" })}
                  >
                    {t("libraryFolderDialog.moveBackTo", { home: homeOf(place) })}
                  </Button>
                ))}
              <Button $variant="secondary" onClick={onClose}>
                {t("common.close")}
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
            {t("libraryFolderDialog.copyToAccount", {
              account: session?.account
                ? t("libraryFolderDialog.account", { name: session.account.name })
                : "",
              files: fileCount(count),
              size: size(bytes),
            })}
          </p>
          <p>
            <Muted>
              {t("libraryFolderDialog.copyStays")}
            </Muted>
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void toCloud()}>
                {t("libraryFolderDialog.copyIt")}
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                {t("common.back")}
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "toCloud" && !app && (
        <>
          <p>
            {t("libraryFolderDialog.moveToAccount", {
              account: session?.account
                ? t("libraryFolderDialog.account", { name: session.account.name })
                : "",
              files: fileCount(count),
              size: size(bytes),
            })}
          </p>
          <p>
            <Muted>
              {t("libraryFolderDialog.moveLeaves")}
            </Muted>
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void toCloud()}>
                {t("libraryFolderDialog.moveIt")}
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                {t("common.back")}
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "fromCloud" && (
        <>
          <p>
            {t("libraryFolderDialog.fromAccount", { files: fileCount(count), size: size(bytes) })}
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void fromCloud()}>
                {t("libraryFolderDialog.moveHere")}
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                {t("common.back")}
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "moveBack" && (
        <>
          <p>
            {t("libraryFolderDialog.moveBack", {
              name: place.name,
              home: homeOf(place),
              files: fileCount(count),
              size: size(bytes),
            })}
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void move(undefined)}>
                {t("libraryFolderDialog.moveItBack")}
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                {t("common.back")}
              </Button>
            </>,
          )}
        </>
      )}

      {view.kind === "open" && (
        <>
          <p>
            {t("libraryFolderDialog.hasLibrary", {
              name: view.target.name,
              place: describePlace(place),
            })}
          </p>
          {footer(
            <>
              <Button $variant="primary" onClick={() => void open(view.target)}>
                {t("libraryFolderDialog.openIt")}
              </Button>
              <Button
                $variant="secondary"
                onClick={() => setView({ kind: "overview" })}
              >
                {t("common.back")}
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
  /** In the desktop and phone apps, which keep their own library beside the account's, rather than moving it. */
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
        <h3>{t("libraryFolderDialog.yourAccount")}</h3>
        <Muted as="p">
          {session
            ? t("libraryFolderDialog.signInTo", { name: session.name })
            : t("libraryFolderDialog.signInServer")}
        </Muted>
        {onAccount && (
          <Button $variant="secondary" onClick={onAccount}>
            {session ? t("libraryFolderDialog.signIn") : t("libraryFolderDialog.chooseServer")}
          </Button>
        )}
      </AccountBox>
    );
  }
  if (place.kind === "cloud") {
    return (
      <AccountBox>
        <Muted as="p">
          {t("libraryFolderDialog.inCloud")}
        </Muted>
        <Choices>
          {app ? (
            <Button $variant="secondary" onClick={onOpenHere}>
              {t("libraryFolderDialog.openDevice")}
            </Button>
          ) : homeHasLibrary ? (
            <Button $variant="secondary" onClick={onOpenHere}>
              {t("libraryFolderDialog.openBrowser")}
            </Button>
          ) : (
            <Button $variant="secondary" onClick={onMoveBack}>
              {t("libraryFolderDialog.moveToBrowser")}
            </Button>
          )}
        </Choices>
      </AccountBox>
    );
  }
  return (
    <AccountBox>
      <h3>{t("libraryFolderDialog.yourAccount")}</h3>
      {!cloud ? (
        <Muted as="p">{t("libraryFolderDialog.looking")}</Muted>
      ) : cloud.exists ? (
        <>
          <Muted as="p">
            {t("libraryFolderDialog.accountHas", {
              name: session.account.name,
              count: cloud.items,
              n: cloud.items.toLocaleString(),
              here: app ? t("libraryFolderDialog.onDevice") : t("libraryFolderDialog.here"),
            })}
          </Muted>
          <Choices>
            <Button $variant="secondary" onClick={onOpenThere}>
              {t("libraryFolderDialog.openAccount")}
            </Button>
            {onSync && (
              <Button $variant="secondary" onClick={onSync}>
                {t("libraryFolderDialog.syncWith")}
              </Button>
            )}
          </Choices>
        </>
      ) : (
        <>
          <Muted as="p">
            {t(app ? "libraryFolderDialog.copyOffer" : "libraryFolderDialog.moveOffer", {
              name: session.account.name,
            })}
          </Muted>
          <Choices>
            <Button
              $variant="secondary"
              disabled={!app && place.kind !== "browser"}
              onClick={onMoveThere}
            >
              {app ? t("libraryFolderDialog.useFromAccount") : t("libraryFolderDialog.moveToAccountButton")}
            </Button>
            {onSync && (
              <Button $variant="secondary" onClick={onSync}>
                {t("libraryFolderDialog.keepCopy")}
              </Button>
            )}
          </Choices>
          {!app && place.kind !== "browser" && (
            <Muted as="p">
              {t("libraryFolderDialog.backFirst")}
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
      ? t("libraryFolderDialog.moving")
      : t("libraryFolderDialog.arranging");
  return (
    <>
      <p>
        {what}
        {progress?.total
          ? t("libraryFolderDialog.progress", {
              done: progress.done.toLocaleString(),
              files: fileCount(progress.total),
            })
          : t("libraryFolderDialog.ellipsis")}
      </p>
      <Bar
        value={progress?.done ?? 0}
        max={Math.max(progress?.total ?? 1, 1)}
      />
      <p>
        <Muted>{t("libraryFolderDialog.keepOpen")}</Muted>
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
        {tn("libraryFolderDialog.confirmMove", {
          name: <strong>{target.name}</strong>,
          files: fileCount(count),
          size: size(bytes),
          example: example
            ? tn("libraryFolderDialog.booksLike", { path: <Path>{example}</Path> })
            : "",
          from,
        })}
      </p>
      {target.holds === "files" && (
        <p>
          <Muted>
            {t("libraryFolderDialog.otherFiles")}
          </Muted>
        </p>
      )}
      <Footer>
        <Button $variant="primary" onClick={onMove}>
          {t("libraryFolderDialog.moveIt")}
        </Button>
        <Button $variant="secondary" onClick={onBack}>
          {t("common.back")}
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
        {t("libraryFolderDialog.bookFolders")}
        <input
          value={layout.folder}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange({ ...layout, folder: e.target.value })}
        />
        <small>
          {t("libraryFolderDialog.bookFoldersHelp", {
            placeholders: PLACEHOLDERS.map((p) => `<${p.key}>`).join(", "),
          })}
        </small>
      </Field>
      <Field>
        {t("libraryFolderDialog.fileNames")}
        <input
          value={layout.fileName}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange({ ...layout, fileName: e.target.value })}
        />
        <small>
          {t("libraryFolderDialog.fileNamesHelp")}
        </small>
      </Field>
      {problems.map((p) => (
        <ErrorText key={p}>{p}</ErrorText>
      ))}
      {example && (
        <p>
          <small>
            {tn("libraryFolderDialog.example", { path: <Path>{example}</Path> })}
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
