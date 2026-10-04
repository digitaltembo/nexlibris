import { post, type SimpleMeta } from 'estuary-rpc';
import type { Operation } from './operations';
import type { Library } from './types';

/**
 * M6 sync between two instances of a library, as an estuary-rpc API. One instance (the hub: the
 * desktop app, later the M4 server) serves it, and the other (the phone, say) drives each sync:
 * it fetches the hub's state, works out the merge, shows the preview, then applies its own side
 * and sends the hub its side (see `sync.ts`).
 *
 * Over HTTP, each endpoint is a POST of its request as JSON, answered with an `RpcResponse`, and
 * every call but `pair` carries the pairing's key as `Authorization: Bearer <key>`.
 *
 * Files travel outside this API, as plain HTTP with the same key, so they stream rather than go
 * through JSON: `GET api/sync/files/<hash>` answers with the file's bytes, and `PUT` with the
 * bytes as the body stores them, refused unless they hash to `<hash>`. `missing` says which of
 * some files the hub lacks (see `syncFiles.ts`).
 */

export interface PeerInfo {
  /** The instance's `Library.origin`. */
  origin: string;
  /** What to call it, e.g. the computer's name. */
  name: string;
  libraryId: string;
  libraryName: string;
  schemaVersion: number;
  revision: number;
}

export interface PairRequest {
  /** The one-time code the hub showed (in its QR code, or to type in). */
  code: string;
  /** The instance pairing with the hub. */
  peer: { origin: string; name: string };
}

export interface PairResult {
  /** The long-lived key for this pairing, sent with every later call. */
  key: string;
  hub: PeerInfo;
}

export interface StateRequest {
  /** The hub's revision at the last sync with this peer (0 for none): changes after it are returned. */
  since: number;
}

export interface StateResult {
  library: Library;
  /** The operations applied after `since`, oldest first. */
  changes: Operation[];
}

export interface ApplyRequest {
  ops: Operation[];
  /** The hub's revision when the caller fetched its state; nothing is applied if it has moved on. */
  expectRevision: number;
}

export interface ApplyResult {
  revision: number;
  /** The hub's state hash afterwards (`stateDigest(library).hash`). */
  hash: string;
}

export interface DoneRequest {
  /** The peer that synced. */
  origin: string;
  /** When it finished, as an ISO timestamp. */
  at: string;
}

export const syncApiMeta = {
  sync: {
    /** Trades a one-time pairing code for a key. Handled by the hub's host (the desktop's main process). */
    pair: post<PairRequest, PairResult, SimpleMeta>('api/sync/pair'),
    hello: post<null, PeerInfo, SimpleMeta>('api/sync/hello'),
    state: post<StateRequest, StateResult, SimpleMeta>('api/sync/state'),
    apply: post<ApplyRequest, ApplyResult, SimpleMeta>('api/sync/apply'),
    /** Records a finished sync, for the hub's list of paired instances. */
    done: post<DoneRequest, null, SimpleMeta>('api/sync/done'),
    /** Which of these files (by hash) the hub doesn't have. Handled by the hub's host, which has its files. */
    missing: post<{ hashes: string[] }, string[], SimpleMeta>('api/sync/missing'),
  },
};

export type SyncApi = typeof syncApiMeta;

/** What a pairing QR code holds: `nexlibris-pair:<address>#<code>`, e.g. `nexlibris-pair:http://192.168.0.11:47811#K3Q9-TX2M`. */
export const PAIRING_PREFIX = 'nexlibris-pair:';

export function pairingText(address: string, code: string): string {
  return `${PAIRING_PREFIX}${address}#${code}`;
}

export function parsePairingText(text: string): { address: string; code: string } | undefined {
  if (!text.startsWith(PAIRING_PREFIX)) return undefined;
  const [address, code] = text.slice(PAIRING_PREFIX.length).split('#');
  if (!address || !code || !/^https?:\/\/[^/]+\/?$/.test(address)) return undefined;
  return { address: address.replace(/\/$/, ''), code };
}
