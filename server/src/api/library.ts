import type { MessageImpl, ServerApi } from '@nexlibris/common';
import { ApiError } from 'estuary-rpc';
import { checkLocalPath } from '../libraries';
import { own, type Caller, type Services } from './context';
import { fileHash, lacking, receive, sendObject } from './files';

/** The server API's library: the signed-in account's library, its books' files and its local files, served only to it. */
export function libraryEndpoints({ libraries, pairings, resetSync }: Services): MessageImpl<ServerApi, Caller>['library'] {
  const backend = (caller: Caller) => libraries.backend(own(caller).id);
  const localPath = (path: unknown) => checkLocalPath(String(path));

  return {
    status: (_, caller) => libraries.status(own(caller).id),
    async get(request, caller) {
      const library = await backend(caller).getLibrary();
      return request?.revision === library.revision ? null : library;
    },
    async apply(request, caller) {
      if (!Array.isArray(request?.ops)) throw new ApiError(400, 'Bad request.');
      return backend(caller).apply(request.ops, typeof request.expectRevision === 'number' ? request.expectRevision : undefined);
    },
    changes: (request, caller) => backend(caller).getChanges(Number(request?.since) || 0),
    hasFile: (request, caller) => libraries.hasFile(own(caller).id, fileHash(request?.hash)),
    async deleteFile(request, caller) {
      await backend(caller).deleteFile(fileHash(request?.hash));
      return null;
    },
    missing: (request, caller) => lacking(libraries, own(caller).id, request?.hashes),
    async readLocalState(request, caller) {
      return (await backend(caller).readLocalState(String(request?.key))) ?? null;
    },
    async writeLocalState(request, caller) {
      await backend(caller).writeLocalState(String(request?.key), request?.value);
      return null;
    },
    async deleteLocalFile(request, caller) {
      await backend(caller).deleteLocalFile(localPath(request?.path));
      return null;
    },
    async import(request, caller) {
      await libraries.import(own(caller).id, request);
      resetSync(own(caller).id);
      return null;
    },
    async remove(_, caller) {
      const { id } = own(caller);
      await libraries.remove(id);
      resetSync(id);
      await pairings.forget(id);
      return null;
    },
    file: async (request, caller) => sendObject(caller.res, await libraries.readFile(own(caller).id, fileHash(request?.hash))),
    putFile: (request, caller) => receive(libraries, own(caller).id, caller.req, fileHash(request?.hash)),
    localFile: async (request, caller) => sendObject(caller.res, await libraries.readLocalFile(own(caller).id, localPath(request?.path))),
    putLocalFile: (request, caller) => libraries.writeLocalFile(own(caller).id, localPath(request?.path), caller.req),
  };
}
