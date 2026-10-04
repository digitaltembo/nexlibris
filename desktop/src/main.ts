import {
  createMessageHandler,
  importApiMeta,
  saveApiMeta,
  storageApiMeta,
  syncHostApiMeta,
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
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ORIGIN, appFile, APP_SCHEME, clientIndex, isAppUrl } from './appProtocol';
import { createFileStorage } from './fileStorage';
import { createImportService } from './importService';
import { menuTemplate, parseMenus } from './menu';
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
  const libraryDir = process.env.NEXLIBRIS_LIBRARY_DIR ?? join(app.getPath('userData'), 'library');
  if (!(await stat(clientIndex(clientDir)).catch(() => undefined))) {
    dialog.showErrorBox('nexlibris', `The web client isn't built (no ${clientIndex(clientDir)}). Run \`npm run build\` first.`);
    app.quit();
    return;
  }

  protocol.handle(APP_SCHEME, async (request) => {
    const target = appFile(request.url, { client: clientDir, library: libraryDir });
    if (!target) return new Response('Not found', { status: 404 });
    const isFile = (await stat(target.file).catch(() => undefined))?.isFile();
    if (!isFile) {
      if (target.kind === 'library') return new Response('Not found', { status: 404 });
      // A client route rather than a file: the single page handles it.
      return net.fetch(pathToFileURL(clientIndex(clientDir)).toString());
    }
    return net.fetch(pathToFileURL(target.file).toString());
  });

  const syncHost = createSyncHost({
    // Alongside the page's own instance state (`readLocalState`), as pairings belong to this copy of the library.
    file: join(libraryDir, 'local', 'sync-host.json'),
    libraryDir,
    name: () => hostname().replace(/\.local$/, ''),
    relay: relayToPage,
  });
  await syncHost.start();
  app.on('will-quit', () => void syncHost.stop());

  const handle = createMessageHandler(
    { ...storageApiMeta, ...saveApiMeta, ...importApiMeta, ...syncHostApiMeta },
    {
      syncHost: {
        status: () => syncHost.status(),
        setEnabled: ({ enabled }) => syncHost.setEnabled(enabled),
        newCode: () => syncHost.newCode(),
        unpair: ({ origin }) => syncHost.unpair(origin),
      },
      storage: createFileStorage(libraryDir),
      import: createImportService(libraryDir, async ({ extensions, folder }) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        // A dialog filter matches the last part of a name, so `x4.epub` is offered as `epub`.
        const filters = [{ name: 'Books', extensions: [...new Set(extensions.map((e) => e.split('.').pop()!))] }];
        const options: OpenDialogOptions = folder
          ? { properties: ['openDirectory'], buttonLabel: 'Import' }
          : { properties: ['openFile', 'multiSelections'], filters };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      }),
      save: createSaveService(join(app.getPath('temp'), 'nexlibris-save'), async (name) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window?.isMinimized()) window.restore();
    window?.focus();
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
    const [window] = BrowserWindow.getAllWindows();
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
  const send = (id: string) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    window?.webContents.send('nexlibris:menu-command', id);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(menus, { platform: process.platform, appName: app.name, send })));
}

ipcMain.on('nexlibris:menu', (event, menus: unknown) => {
  if (fromAppPage(event)) setMenu(parseMenus(menus));
});

ipcMain.on('nexlibris:peer-response', (event, { id, response }: { id: number; response: RpcResponse }) => {
  if (fromAppPage(event)) peerCalls.get(id)?.(response);
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
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
  });
  chooseBluetoothDevices(window);
  // In full screen the window buttons are hidden, so the page needn't leave room for them.
  window.on('enter-full-screen', () => window.webContents.send('nexlibris:full-screen', true));
  window.on('leave-full-screen', () => window.webContents.send('nexlibris:full-screen', false));
  // Links out of the app (a book's website, say) open in the browser; the window only ever shows the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
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
