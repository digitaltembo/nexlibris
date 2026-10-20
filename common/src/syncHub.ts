import type { LibraryBackend } from './backend';
import { hashBlob } from './backend';
import { errorBody, restReply } from './rest';
import { createMessageHandler, type MessageImpl, type RpcResponse } from './rpc';
import type { ScopeRule } from './scope';
import { createSyncService } from './sync';
import { fromPeer, syncApiMeta, type PairRequest, type PairResult, type SyncApi } from './syncApi';
import { isFileHash } from './syncFiles';
import type { NewCodeRequest, PairedPeer, PairingCode } from './syncHostApi';
import type { SyncMessageRequest } from './syncMessage';

/**
 * A sync hub (M6) in TypeScript, over a library backend: what the Android app's page runs to be
 * the hub for devices that reach it over Bluetooth. It answers the same API as the desktop app's
 * hub (`desktop/src/syncHost.ts`), as requests and responses (`syncMessage.ts`): pairing with a
 * one-time code, the sync calls for paired devices, and their files.
 *
 * Pairings are kept in the library's local state (`sync-hub`), keys only as hashes.
 */

export interface HubRequest extends SyncMessageRequest {
  body: Uint8Array;
}

export interface HubResponse {
  status: number;
  body: Uint8Array;
}

interface StoredPeer extends PairedPeer {
  /** SHA-256 of the key, hex. */
  keyHash: string;
}

interface HubState {
  peers: StoredPeer[];
}

export const SYNC_HUB_STATE_KEY = 'sync-hub';
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LIFETIME_MS = 10 * 60_000;
/** Wrong codes allowed before the current one is withdrawn, so it can't be guessed. */
const MAX_CODE_ATTEMPTS = 5;
const NOT_PAIRED = 'This device isn’t paired with this one. Pair it again.';

const sha256 = async (text: string) => hashBlob(new Blob([text]));
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

function randomText(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 256 is a multiple of the alphabet's 32 letters, so every letter is as likely.
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** An error, as estuary-rpc-server sends one (`rest.ts`). */
const fail = (status: number, message: string): HubResponse => ({ status, body: new TextEncoder().encode(JSON.stringify(errorBody(message))) });
/** A call's result as estuary-rpc-server sends it: the value as JSON, 204 for none, an error as a bad request. */
const answer = (response: RpcResponse): HubResponse => {
  const { status, body } = restReply(response);
  return { status, body: new TextEncoder().encode(body) };
};

export function createSyncHub(
  backend: LibraryBackend,
  options: { name: () => string; onApplied?: () => void; now?: () => Date; scope?: ScopeRule },
) {
  const now = options.now ?? (() => new Date());
  let code: { value: string; expiresAt: number; attempts: number; keepFiles?: string } | undefined;
  const service = createSyncService(backend, {
    name: options.name,
    ...(options.onApplied && { onApplied: options.onApplied }),
    ...(options.scope && { scope: options.scope }),
  });
  const unused = async (): Promise<never> => {
    throw new Error('Handled by the hub');
  };
  const relay = createMessageHandler(syncApiMeta, { sync: { ...service, pair: unused, done: unused, missing: unused } } satisfies MessageImpl<SyncApi>);

  const load = async (): Promise<HubState> => (await backend.readLocalState<HubState>(SYNC_HUB_STATE_KEY)) ?? { peers: [] };
  const save = (state: HubState) => backend.writeLocalState(SYNC_HUB_STATE_KEY, state);

  async function authorize(key: string | undefined): Promise<StoredPeer | undefined> {
    if (!key) return undefined;
    const hash = await sha256(key);
    return (await load()).peers.find((peer) => peer.keyHash === hash);
  }

  async function pair(request: PairRequest): Promise<PairResult> {
    const current = code;
    if (!current || current.expiresAt < now().getTime()) throw new Error('That pairing code has expired. Show a new one.');
    if (normalizeCode(request?.code ?? '') !== current.value) {
      if (++current.attempts >= MAX_CODE_ATTEMPTS) code = undefined;
      throw new Error('That pairing code is wrong.');
    }
    if (typeof request.peer?.origin !== 'string' || typeof request.peer.name !== 'string') throw new Error('Bad pairing request.');
    code = undefined;
    const key = randomText(43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
    const state = await load();
    const peers = state.peers.filter((peer) => peer.origin !== request.peer.origin);
    peers.push({ origin: request.peer.origin, name: request.peer.name.slice(0, 100), pairedAt: now().toISOString(), keyHash: await sha256(key) });
    await save({ peers });
    return { key, hub: await service.hello(null), ...(current.keepFiles && { keepFiles: current.keepFiles }) };
  }

  async function handle(request: HubRequest): Promise<HubResponse> {
    const fileHash = /^api\/sync\/files\/([0-9a-f]{64})$/.exec(request.path)?.[1];
    if (fileHash && (request.method === 'GET' || request.method === 'PUT')) {
      const peer = await authorize(request.key);
      if (!peer) return fail(401, NOT_PAIRED);
      if (request.method === 'GET') {
        // Only files of books the device is shown, and stored here: the backend may otherwise go and fetch one from a hub of its own.
        const allowed = await service.allows({ hash: fileHash, peer: peer.origin });
        const blob = allowed && (await backend.hasFile(fileHash)) ? await backend.getFile(fileHash) : undefined;
        if (!blob) return fail(404, `That file isn’t on ${options.name()}.`);
        return { status: 200, body: new Uint8Array(await blob.arrayBuffer()) };
      }
      const data = new Blob([request.body as Uint8Array<ArrayBuffer>]);
      if ((await hashBlob(data)) !== fileHash) return fail(400, 'The file’s contents don’t match its hash.');
      const { size } = await backend.putFile(data);
      return answer({ ok: true, value: { size } });
    }
    const endpoint = /^api\/sync\/(pair|hello|state|apply|done|missing|allows)$/.exec(request.path)?.[1];
    if (request.method !== 'POST' || !endpoint) return fail(404, 'Not found');
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(request.body) || 'null');
    } catch {
      return fail(400, 'Bad request');
    }
    try {
      if (endpoint === 'pair') return answer({ ok: true, value: await pair(body as PairRequest) });
      const peer = await authorize(request.key);
      if (!peer) return fail(401, NOT_PAIRED);
      if (endpoint === 'missing') {
        const hashes = (body as { hashes?: unknown })?.hashes;
        if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && isFileHash(h))) throw new Error('Bad request.');
        const lacking: string[] = [];
        for (const hash of hashes as string[]) if (!(await backend.hasFile(hash))) lacking.push(hash);
        return answer({ ok: true, value: lacking });
      }
      if (endpoint === 'done') {
        const state = await load();
        await save({ peers: state.peers.map((p) => (p.origin === peer.origin ? { ...p, lastSyncedAt: now().toISOString() } : p)) });
        return answer({ ok: true, value: null });
      }
      return answer(await relay({ id: 0, method: 'POST', url: `api/sync/${endpoint}`, body: fromPeer(endpoint, body, peer.origin) }));
    } catch (e) {
      return fail(400, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    handle,
    /** A new one-time code, replacing any earlier one; the device that uses it keeps the files `keepFiles` finds. */
    newCode(request?: NewCodeRequest | null): PairingCode {
      const value = randomText(8, CODE_ALPHABET);
      const keepFiles = request?.keepFiles?.trim();
      code = { value, expiresAt: now().getTime() + CODE_LIFETIME_MS, attempts: 0, ...(keepFiles && { keepFiles }) };
      return { code: `${value.slice(0, 4)}-${value.slice(4)}`, expiresAt: new Date(code.expiresAt).toISOString() };
    },
    /** Whether the current code is still waiting to be used. */
    codePending: () => code !== undefined && code.expiresAt >= now().getTime(),
    async peers(): Promise<PairedPeer[]> {
      return (await load()).peers.map(({ origin, name, pairedAt, lastSyncedAt }) => ({ origin, name, pairedAt, ...(lastSyncedAt && { lastSyncedAt }) }));
    },
    async unpair(origin: string) {
      const state = await load();
      await save({ peers: state.peers.filter((peer) => peer.origin !== origin) });
    },
  };
}

export type SyncHub = ReturnType<typeof createSyncHub>;
