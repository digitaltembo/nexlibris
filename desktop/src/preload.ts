import { contextBridge, ipcRenderer } from 'electron';
import type { NativeMenu, RpcRequest, RpcResponse } from '@nexlibris/common';

type PeerHandler = (request: RpcRequest) => Promise<RpcResponse>;
let peerHandler: PeerHandler | undefined;
let menuHandler: ((id: string) => void) | undefined;
let fullScreenHandler: ((on: boolean) => void) | undefined;

ipcRenderer.on('nexlibris:full-screen', (_event, on: boolean) => fullScreenHandler?.(on));

// A menu item chosen in the menu bar the page described (see `setMenu`).
ipcRenderer.on('nexlibris:menu-command', (_event, id: string) => menuHandler?.(id));

// Sync calls from paired devices, passed on by the main process (see `relayToPage`), answered by the page.
ipcRenderer.on('nexlibris:peer-request', async (_event, { id, ...request }: RpcRequest & { id: number }) => {
  const response: RpcResponse = peerHandler
    ? await peerHandler(request).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    : { ok: false, message: 'The library on that computer is still opening. Try again in a moment.' };
  ipcRenderer.send('nexlibris:peer-response', { id, response });
});

/**
 * Gives the page three things: an estuary-rpc call to the main process (the Storage, Save, Import
 * and SyncHost APIs), which answers it from native files, a way to answer the sync calls paired
 * devices make, the menu bar (its menus, and the items chosen), and whether the window buttons sit
 * over the page (macOS, outside full screen), and putting its window in or out of full screen. The page gets nothing else
 * from Electron or Node.
 */
contextBridge.exposeInMainWorld('NexlibrisDesktop', {
  rpc: (request: RpcRequest): Promise<RpcResponse> => ipcRenderer.invoke('nexlibris:rpc', request),
  servePeers: (handler: PeerHandler | undefined) => {
    peerHandler = handler;
  },
  setMenu: (menus: NativeMenu[]) => ipcRenderer.send('nexlibris:menu', menus),
  onMenuCommand: (handler: ((id: string) => void) | undefined) => {
    menuHandler = handler;
  },
  // macOS windows have no title bar (see main.ts): the page's top bar holds the window buttons.
  titleBarInset: process.platform === 'darwin',
  onFullScreen: (handler: ((on: boolean) => void) | undefined) => {
    fullScreenHandler = handler;
  },
  setFullScreen: (on: boolean) => ipcRenderer.send('nexlibris:set-full-screen', on),
});
