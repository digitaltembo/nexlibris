import { contextBridge, ipcRenderer } from 'electron';
import type { RpcRequest, RpcResponse } from '@nexlibris/common';

/**
 * Gives the page one call: an estuary-rpc request (Storage or Save API) to the
 * main process, which answers it from native files. The page gets nothing else
 * from Electron or Node.
 */
contextBridge.exposeInMainWorld('NexlibrisDesktop', {
  rpc: (request: RpcRequest): Promise<RpcResponse> => ipcRenderer.invoke('nexlibris:rpc', request),
});
