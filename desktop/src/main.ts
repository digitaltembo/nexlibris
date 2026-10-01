import {
  createMessageHandler,
  importApiMeta,
  saveApiMeta,
  storageApiMeta,
  type RpcMessage,
  type RpcRequest,
} from '@nexlibris/common';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ORIGIN, appFile, APP_SCHEME, clientIndex, isAppUrl } from './appProtocol';
import { createFileStorage } from './fileStorage';
import { createImportService } from './importService';
import { createSaveService } from './saveService';

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

  const handle = createMessageHandler(
    { ...storageApiMeta, ...saveApiMeta, ...importApiMeta },
    {
      storage: createFileStorage(libraryDir),
      import: createImportService(libraryDir, async (extensions) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        // A dialog filter matches the last part of a name, so `x4.epub` is offered as `epub`.
        const filters = [{ name: 'Books', extensions: [...new Set(extensions.map((e) => e.split('.').pop()!))] }];
        const options = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters };
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
    // Only the app's own page, never a book's content or anything it navigated to.
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
      return { ok: false, message: 'Not allowed' };
    }
    const message: RpcMessage = { id: nextId++, method: request.method, url: request.url, body: request.body };
    const result = queue.then(() => handle(message));
    queue = result.catch(() => undefined);
    return result;
  });

  // A packaged app takes its icon from the bundle; running from the repo, the dock would show Electron's.
  if (process.platform === 'darwin') app.dock?.setIcon(iconPath);
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'nexlibris',
    icon: iconPath,
    // The web app's background (--bg), so there's no flash of white before it paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#071f37' : '#fdf8e5',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
