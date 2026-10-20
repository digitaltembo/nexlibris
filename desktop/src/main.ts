import {
  createMessageHandler,
  importApiMeta,
  libraryFolderApiMeta,
  remoteApiMeta,
  saveApiMeta,
  storageApiMeta,
  syncHostApiMeta,
  type MoveStatus,
  type RpcMessage,
  type RpcRequest,
  type NativeMenu,
  type RpcResponse,
} from '@nexlibris/common';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ORIGIN, appFile, APP_SCHEME, clientIndex, isAppUrl, isReaderUrl } from './appProtocol';
import { isServerCall, proxyToServer } from './serverProxy';
import { createFileStorage } from './fileStorage';
import { createImportService } from './importService';
import { dataDir, fileToShow, folderHolds, isPlaced, moveLibrary, moveWithin, pruneWithin, readSettings, writeSettings } from './libraryFolder';
import { menuTemplate, parseMenus } from './menu';
import { createRemote } from './remote';
import { createSaveService } from './saveService';
import { createSyncHost } from './syncHost';

const here = dirname(fileURLToPath(import.meta.url));
/** The built web client: `client/dist`, next to this workspace in the repo. */
const clientDir = process.env.NEXLIBRIS_CLIENT_DIR ?? join(here, '..', '..', 'client', 'dist');
/** Made from the repo's icon.png by scripts/make-icons.py. */
const iconPath = join(here, '..', 'assets', 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// One window, one library: a second launch focuses the first instead of opening the same files twice.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  if (!(await stat(clientIndex(clientDir)).catch(() => undefined))) {
    dialog.showErrorBox('nexlibris', `The web client isn't built (no ${clientIndex(clientDir)}). Run \`npm run build\` first.`);
    app.quit();
    return;
  }
  const settingsFile = join(app.getPath('userData'), 'settings.json');
  const defaultDir = join(app.getPath('userData'), 'library');
  /** The library's folder: the environment's, else the one chosen in the app (`libraryFolder.ts`), else the data folder's. */
  const chosenDir = async () => process.env.NEXLIBRIS_LIBRARY_DIR ?? (await readSettings(settingsFile)).libraryDir ?? defaultDir;

  /** What's open: the folder (a real path), whether it's laid out, and its sync host. */
  let library!: { dir: string; placed: boolean; syncHost: ReturnType<typeof createSyncHost> };
  async function openLibrary(dir: string) {
    await library?.syncHost.stop();
    mkdirSync(dir, { recursive: true });
    const real = realpathSync(dir);
    const data = dataDir(real);
    const syncHost = createSyncHost({
      // Alongside the page's own instance state (`readLocalState`), as pairings belong to this copy of the library.
      file: join(data, 'local', 'sync-host.json'),
      libraryDir: data,
      ...(isPlaced(real) && { placedRoot: real }),
      name: () => hostname().replace(/\.local$/, ''),
      relay: relayToPage,
    });
    library = { dir: real, placed: isPlaced(real), syncHost };
    await syncHost.start();
  }
  await openLibrary(await chosenDir());
  app.on('will-quit', () => void library.syncHost.stop());

  /** Opens another library and shows it: book windows close, and the library's window loads again. */
  async function switchTo(dir: string | undefined) {
    await writeSettings(settingsFile, dir ? { libraryDir: dir } : {});
    await openLibrary(dir ?? defaultDir);
    for (const window of BrowserWindow.getAllWindows()) if (window !== libraryWindow) window.close();
    libraryWindow?.webContents.reload();
  }
  let moving: MoveStatus = { state: 'idle', done: 0, total: 0 };

  protocol.handle(APP_SCHEME, async (request) => {
    // The page's calls to its nexlibris server (M4), which it can't make from app:// itself.
    if (isServerCall(request.url)) return proxyToServer(request, (input, init) => net.fetch(String(input), init));
    const target = appFile(request.url, { client: clientDir, library: library.dir, placed: library.placed });
    if (!target) return new Response('Not found', { status: 404 });
    const isFile = (await stat(target.file).catch(() => undefined))?.isFile();
    if (!isFile) {
      if (target.kind === 'library') return new Response('Not found', { status: 404 });
      // A client route rather than a file: the single page handles it.
      return net.fetch(pathToFileURL(clientIndex(clientDir)).toString());
    }
    return net.fetch(pathToFileURL(target.file).toString());
  });

  const focused = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  // Each call goes to whichever library is open (the services are made per call, which costs nothing).
  const storage = (): ReturnType<typeof createFileStorage> => createFileStorage(library.dir);
  const handle = createMessageHandler(
    { ...storageApiMeta, ...saveApiMeta, ...importApiMeta, ...syncHostApiMeta, ...libraryFolderApiMeta, ...remoteApiMeta },
    {
      syncHost: {
        status: () => library.syncHost.status(),
        setEnabled: ({ enabled }) => library.syncHost.setEnabled(enabled),
        newCode: (request) => library.syncHost.newCode(request),
        unpair: ({ origin }) => library.syncHost.unpair(origin),
      },
      storage: {
        readText: (r) => storage().readText(r),
        writeText: (r) => storage().writeText(r),
        appendText: (r) => storage().appendText(r),
        exists: (r) => storage().exists(r),
        size: (r) => storage().size(r),
        readChunk: (r) => storage().readChunk(r),
        writeChunk: (r) => storage().writeChunk(r),
        remove: (r) => storage().remove(r),
      },
      libraryFolder: {
        location: async () => {
          const isDefault = existsSync(defaultDir) && library.dir === realpathSync(defaultDir);
          return { path: library.dir, isDefault, placed: library.placed, defaultHasLibrary: !isDefault && (await folderHolds(defaultDir)) === 'library' };
        },
        async choose() {
          const window = focused();
          const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose' };
          const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
          const path = result.canceled ? undefined : result.filePaths[0];
          return path ? { path, holds: await folderHolds(path) } : null;
        },
        async move({ to, layout, placed }) {
          if (moving.state === 'moving') throw new Error('The library is moving already.');
          if (process.env.NEXLIBRIS_LIBRARY_DIR) throw new Error('NEXLIBRIS_LIBRARY_DIR sets where the library is; unset it to move the library.');
          moving = { state: 'moving', done: 0, total: 0 };
          // Nothing syncs with a library that's moving.
          await library.syncHost.stop();
          const from = library.dir;
          void moveLibrary({
            from,
            to: to ?? defaultDir,
            ...(layout && { layout }),
            ...(placed && { placed }),
            onProgress: (done, total) => (moving = { state: 'moving', done, total }),
          })
            .then(async () => {
              moving = { ...moving, state: 'done' };
              await switchTo(to);
            })
            .catch(async (e: unknown) => {
              moving = { ...moving, state: 'failed', message: e instanceof Error ? e.message : String(e) };
              await library.syncHost.start();
            });
          return null;
        },
        status: async () => moving,
        async open({ path }) {
          if (process.env.NEXLIBRIS_LIBRARY_DIR) throw new Error('NEXLIBRIS_LIBRARY_DIR sets where the library is; unset it to open another.');
          await switchTo(path);
          return null;
        },
        async moveFile({ from, to }) {
          await moveWithin(library.dir, from, to);
          return null;
        },
        async prune({ path }) {
          await pruneWithin(library.dir, path);
          return null;
        },
        async showFile({ path }) {
          shell.showItemInFolder(await fileToShow(library.dir, path));
          return null;
        },
      },
      remote: createRemote(() => realpathSync(dataDir(library.dir))),
      import: createImportService(() => dataDir(library.dir), async ({ extensions, folder }) => {
        const window = focused();
        // A dialog filter matches the last part of a name, so `x4.epub` is offered as `epub`.
        const filters = [{ name: 'Books', extensions: [...new Set(extensions.map((e) => e.split('.').pop()!))] }];
        const options: OpenDialogOptions = folder
          ? { properties: ['openDirectory'], buttonLabel: 'Import' }
          : { properties: ['openFile', 'multiSelections'], filters };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      }),
      save: createSaveService(join(app.getPath('temp'), 'nexlibris-save'), async (name) => {
        const window = focused();
        const options = { defaultPath: join(app.getPath('downloads'), name) };
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        return result.canceled ? undefined : result.filePath;
      }),
    },
  );
  // Calls run one at a time, in order, as on Android: an append must not overtake the write before it.
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  ipcMain.handle('nexlibris:rpc', (event, request: RpcRequest) => {
    if (!fromAppPage(event)) return { ok: false, message: 'Not allowed' };
    const message: RpcMessage = { id: nextId++, method: request.method, url: request.url, body: request.body };
    const result = queue.then(() => handle(message));
    queue = result.catch(() => undefined);
    return result;
  });

  // A packaged app takes its icon from the bundle; running from the repo, the dock would show Electron's.
  if (process.platform === 'darwin') app.dock?.setIcon(iconPath);
  setMenu([]);
  createWindow();
  app.on('activate', () => {
    if (!libraryWindow) createWindow();
  });
  app.on('second-instance', () => {
    if (!libraryWindow) return createWindow();
    if (libraryWindow.isMinimized()) libraryWindow.restore();
    libraryWindow.focus();
  });
});

/** Only the app's own page, never a book's content or anything it navigated to. */
function fromAppPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame && isAppUrl(frame.url);
}

/** Sync calls from paired devices wait here for the page's answer. */
const peerCalls = new Map<number, (response: RpcResponse) => void>();
let nextPeerCall = 1;

/** Passes a sync call on to the page, which has the library (see the preload's `servePeers`). */
function relayToPage(request: RpcRequest): Promise<RpcResponse> {
  return new Promise((resolve) => {
    // The library's window answers; a book's own window doesn't sync.
    const window = libraryWindow;
    if (!window) return resolve({ ok: false, message: 'nexlibris has no window open on that computer. Open it, then sync.' });
    const id = nextPeerCall++;
    const timer = setTimeout(() => {
      peerCalls.delete(id);
      resolve({ ok: false, message: 'The library on that computer didn’t answer.' });
    }, 120_000);
    peerCalls.set(id, (response) => {
      clearTimeout(timer);
      peerCalls.delete(id);
      resolve(response);
    });
    window.webContents.send('nexlibris:peer-request', { id, ...request });
  });
}

/** The menu bar: the page's menus (none until it sends them) and the app's own. */
function setMenu(menus: NativeMenu[]) {
  // The menus are the library window's commands, so they go to it, even from a book's own window.
  const send = (id: string) => {
    if (!libraryWindow) return;
    if (BrowserWindow.getFocusedWindow() !== libraryWindow) libraryWindow.focus();
    libraryWindow.webContents.send('nexlibris:menu-command', id);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(menus, { platform: process.platform, appName: app.name, send })));
}

ipcMain.on('nexlibris:menu', (event, menus: unknown) => {
  if (fromAppPage(event)) setMenu(parseMenus(menus));
});

ipcMain.on('nexlibris:peer-response', (event, { id, response }: { id: number; response: RpcResponse }) => {
  if (fromAppPage(event)) peerCalls.get(id)?.(response);
});

/** The library's window; books opened from it get windows of their own (`readerWindow` in the page). */
let libraryWindow: BrowserWindow | undefined;

/** What every window of the app has. */
function windowOptions(): BrowserWindowConstructorOptions {
  return {
    title: 'nexlibris',
    icon: iconPath,
    // The web app's background (--bg), so there's no flash of white before it paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#071f37' : '#fdf8e5',
    // On macOS, no title bar (it only repeated the app's name): the window buttons sit in the
    // page's top bar, which leaves room for them and moves the window (see the preload's titleBarInset).
    ...(process.platform === 'darwin' && { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 21 } }),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

/**
 * What every window of the app does: tells the page about full screen, opens links out of the app
 * in the browser, never navigates away from the app, and opens books in windows of their own.
 */
function guard(window: BrowserWindow) {
  // In full screen the window buttons are hidden, so the page needn't leave room for them.
  window.on('enter-full-screen', () => window.webContents.send('nexlibris:full-screen', true));
  window.on('leave-full-screen', () => window.webContents.send('nexlibris:full-screen', false));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isReaderUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { ...windowOptions(), width: 960, height: 1100 } };
    }
    // Links out of the app (a book's website, say) open in the browser.
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', (child) => guard(child));
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
}

function createWindow() {
  const window = new BrowserWindow({ ...windowOptions(), width: 1280, height: 860 });
  libraryWindow = window;
  window.on('closed', () => {
    if (libraryWindow === window) libraryWindow = undefined;
  });
  chooseBluetoothDevices(window);
  guard(window);
  void window.loadURL(`${APP_ORIGIN}/`);
}

/**
 * Web Bluetooth's device chooser, which Electron leaves to the app: a sync over Bluetooth asks for
 * phones hosting nexlibris sync (the page's filter), and the first one found is taken. Electron
 * reports devices as it finds them; with none after a while, the request is cancelled.
 */
function chooseBluetoothDevices(window: BrowserWindow) {
  let pending: { choose: (deviceId: string) => void; timer: NodeJS.Timeout } | undefined;
  const finish = (deviceId: string) => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { choose } = pending;
    pending = undefined;
    choose(deviceId);
  };
  window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (pending) pending.choose = callback;
    else pending = { choose: callback, timer: setTimeout(() => finish(''), BLUETOOTH_SEARCH_MS) };
    const [device] = devices;
    if (device) finish(device.deviceId);
  });
}

const BLUETOOTH_SEARCH_MS = 15_000;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
