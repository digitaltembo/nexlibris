import type { MessageImpl, PairResult, SyncApi, SyncFilesApi } from '@nexlibris/common';
import { ApiError } from 'estuary-rpc';
import { pairingOf, SIGNED_OUT, type Caller, type Services } from './context';
import { fileHash, lacking, receive, sendObject } from './files';

/**
 * The sync API on each account's library, as other instances call it: paired by the session, then
 * called with the pairing's key. Not scoped: an account's instances are all its own, and each sees
 * the whole library.
 */
export function syncEndpoints({ libraries, pairings, syncOf }: Services): MessageImpl<SyncApi, Caller>['sync'] {
  const service = (caller: Caller) => syncOf(pairingOf(caller).accountId);
  return {
    // Paired by the session rather than a code: the page doing it is signed in.
    async pair(request, caller) {
      if (!caller.account) throw new ApiError(401, SIGNED_OUT);
      const key = await pairings.pair(caller.account, request?.peer ?? { origin: undefined, name: undefined });
      return { key, hub: await syncOf(caller.account.id).hello(null) } satisfies PairResult;
    },
    hello: (_, caller) => service(caller).hello(null),
    state: (request, caller) => service(caller).state(request),
    apply: (request, caller) => service(caller).apply(request),
    async done(_, caller) {
      await pairings.synced(pairingOf(caller));
      return null;
    },
    missing: (request, caller) => lacking(libraries, pairingOf(caller).accountId, request?.hashes),
  };
}

/** The sync API's files: books' files streamed to and from a paired instance. */
export function syncFileEndpoints({ libraries }: Services): MessageImpl<SyncFilesApi, Caller> {
  return {
    get: async (request, caller) => sendObject(caller.res, await libraries.readFile(pairingOf(caller).accountId, fileHash(request?.hash))),
    put: (request, caller) => receive(libraries, pairingOf(caller).accountId, caller.req, fileHash(request?.hash)),
  };
}
