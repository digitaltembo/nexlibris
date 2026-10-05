import {
  fromPeer,
  isFileHash,
  storedFilePath,
  type NewCodeRequest,
  type PairedPeer,
  type PairingCode,
  type PairRequest,
  type PairResult,
  type PeerInfo,
  type RpcRequest,
  type RpcResponse,
  type SyncHostStatus,
} from '@nexlibris/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { resolveLibraryPath } from './fileStorage';
import { storeStream } from './importService';

/**
 * The desktop app as a sync hub (M6): serves the sync API over HTTP on the local network, while
 * the user has it turned on. Pairing is handled here: the page shows a one-time code (in a QR
 * code too), and a device that sends it back gets a key, kept here as a hash. Calls with a valid
 * key are passed on to `relay` (the page, where the library and its backend are), except `done`,
 * which only updates the peer's last sync time, and files, which are served from and stored in
 * the library folder here (`GET`/`PUT api/sync/files/<hash>`, and `missing`).
 *
 * Every response allows any origin (CORS), since a call is authorized by its key alone and never
 * by cookies: a browser instance of nexlibris on another computer can sync with the hub too.
 */

export interface SyncHostOptions {
  /** The JSON file pairings and the on/off setting are kept in. */
  file: string;
  /** The library's folder, whose stored files paired devices fetch and add to. */
  libraryDir: string;
  name: () => string;
  /** Passes an authorized sync call (`hello`, `state`, `apply`) on to the library. */
  relay: (request: RpcRequest) => Promise<RpcResponse>;
  /** The port to try first; another is used if it's taken. */
  port?: number;
  /** Where to listen; all interfaces by default. */
  host?: string;
  now?: () => Date;
}

interface StoredPeer extends PairedPeer {
  /** SHA-256 of the key, hex. */
  keyHash: string;
}

interface StoredState {
  enabled: boolean;
  peers: StoredPeer[];
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LIFETIME_MS = 10 * 60_000;
/** Wrong codes allowed before the current one is withdrawn, so it can't be guessed. */
const MAX_CODE_ATTEMPTS = 5;
const MAX_BODY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SYNC_PORT = 47811;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

export function createSyncHost(options: SyncHostOptions) {
  const now = options.now ?? (() => new Date());
  mkdirSync(options.libraryDir, { recursive: true });
  /** The library folder as a real path, as `resolveLibraryPath` needs. */
  const libraryRoot = realpathSync(options.libraryDir);
  let state: StoredState | undefined;
  let server: Server | undefined;
  let port: number | undefined;
  let error: string | undefined;
  let code: { value: string; expiresAt: number; attempts: number; keepFiles?: string } | undefined;

  async function load(): Promise<StoredState> {
    if (state) return state;
    try {
      state = JSON.parse(await readFile(options.file, 'utf8')) as StoredState;
    } catch {
      state = { enabled: false, peers: [] };
    }
    return state;
  }

  async function save() {
    await mkdir(dirname(options.file), { recursive: true });
    const temp = `${options.file}.tmp`;
    await writeFile(temp, JSON.stringify(state));
    await rename(temp, options.file);
  }

  async function status(): Promise<SyncHostStatus> {
    const { enabled, peers } = await load();
    return {
      enabled,
      name: options.name(),
      addresses: server && port ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
      peers: peers.map(({ origin, name, pairedAt, lastSyncedAt }) => ({ origin, name, pairedAt, ...(lastSyncedAt && { lastSyncedAt }) })),
      ...(error && { error }),
    };
  }

  async function listen() {
    if (server) return;
    const s = createServer((req, res) => void handle(req, res));
    const tryPort = (p: number) =>
      new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(p, options.host ?? '0.0.0.0', () => {
          s.off('error', reject);
          resolve();
        });
      });
    try {
      await tryPort(options.port ?? DEFAULT_SYNC_PORT).catch(() => tryPort(0));
      server = s;
      port = (s.address() as AddressInfo).port;
      error = undefined;
    } catch (e) {
      error = `Couldn't listen for sync: ${e instanceof Error ? e.message : e}`;
    }
  }

  async function close() {
    const s = server;
    server = undefined;
    port = undefined;
    code = undefined;
    if (!s) return;
    const closed = new Promise((resolve) => s.close(resolve));
    s.closeAllConnections();
    await closed;
  }

  /** The peer a request's key belongs to. */
  async function authorize(req: IncomingMessage): Promise<StoredPeer | undefined> {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!key) return undefined;
    const hash = Buffer.from(sha256(key), 'hex');
    return (await load()).peers.find((peer) => timingSafeEqual(Buffer.from(peer.keyHash, 'hex'), hash));
  }

  async function pair(request: PairRequest): Promise<PairResult> {
    const current = code;
    if (!current || current.expiresAt < now().getTime()) throw new Error('That pairing code has expired. Show a new one.');
    if (normalizeCode(request.code ?? '') !== current.value) {
      if (++current.attempts >= MAX_CODE_ATTEMPTS) code = undefined;
      throw new Error('That pairing code is wrong.');
    }
    if (typeof request.peer?.origin !== 'string' || typeof request.peer.name !== 'string') throw new Error('Bad pairing request.');
    // Who the hub is: asked of the library, so the reply can't say yes to a pairing the page can't serve.
    const hello = await options.relay({ method: 'POST', url: 'api/sync/hello', body: null });
    if (!hello.ok) throw new Error(hello.message);
    code = undefined;
    const key = randomBytes(32).toString('base64url');
    const s = await load();
    s.peers = s.peers.filter((peer) => peer.origin !== request.peer.origin);
    s.peers.push({ origin: request.peer.origin, name: request.peer.name.slice(0, 100), pairedAt: now().toISOString(), keyHash: sha256(key) });
    await save();
    return { key, hub: hello.value as PeerInfo, ...(current.keepFiles && { keepFiles: current.keepFiles }) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    // Chrome's Private Network Access: a page elsewhere may call this LAN address once it says so.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    const reply = (status: number, body: RpcResponse) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const fileHash = /^\/api\/sync\/files\/([0-9a-f]{64})$/.exec(req.url ?? '')?.[1];
    if (fileHash && (req.method === 'GET' || req.method === 'PUT')) {
      if (!(await authorize(req))) {
        req.resume();
        return reply(401, { ok: false, message: 'This device isn’t paired with this computer. Pair it again.' });
      }
      return req.method === 'GET' ? sendFile(fileHash, res, reply) : receiveFile(fileHash, req, reply);
    }
    const endpoint = /^\/api\/sync\/(pair|hello|state|apply|done|missing)$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'POST' || !endpoint) return reply(404, { ok: false, message: 'Not found' });
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || 'null');
    } catch (e) {
      return reply(400, { ok: false, message: e instanceof Error ? e.message : 'Bad request' });
    }
    try {
      if (endpoint === 'pair') return reply(200, { ok: true, value: await pair(body as PairRequest) });
      const peer = await authorize(req);
      if (!peer) return reply(401, { ok: false, message: 'This device isn’t paired with this computer. Pair it again.' });
      if (endpoint === 'missing') {
        const hashes = (body as { hashes?: unknown })?.hashes;
        if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && isFileHash(h))) throw new Error('Bad request.');
        const lacking: string[] = [];
        for (const hash of hashes as string[]) if (!(await storedFile(hash))) lacking.push(hash);
        return reply(200, { ok: true, value: lacking });
      }
      if (endpoint === 'done') {
        peer.lastSyncedAt = now().toISOString();
        await save();
        return reply(200, { ok: true, value: null });
      }
      reply(200, await options.relay({ method: 'POST', url: `api/sync/${endpoint}`, body: fromPeer(endpoint, body, peer.origin) }));
    } catch (e) {
      reply(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A stored file's path and size, if it's here. */
  async function storedFile(hash: string): Promise<{ path: string; size: number } | undefined> {
    const path = resolveLibraryPath(libraryRoot, storedFilePath(hash));
    const info = await stat(path).catch(() => undefined);
    return info?.isFile() ? { path, size: info.size } : undefined;
  }

  async function sendFile(hash: string, res: ServerResponse, reply: (status: number, body: RpcResponse) => void) {
    const file = await storedFile(hash);
    if (!file) return reply(404, { ok: false, message: 'That file isn’t on this computer.' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size });
    createReadStream(file.path)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function receiveFile(hash: string, req: IncomingMessage, reply: (status: number, body: RpcResponse) => void) {
    try {
      const { size } = await storeStream(libraryRoot, req, hash);
      reply(200, { ok: true, value: { size } });
    } catch (e) {
      reply(400, { ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    status,
    /** Starts listening if sync was left on. */
    async start() {
      if ((await load()).enabled) await listen();
      return status();
    },
    async setEnabled(enabled: boolean) {
      (await load()).enabled = enabled;
      await save();
      if (enabled) await listen();
      else await close();
      return status();
    },
    /** A new one-time code; the device that uses it keeps the files of the books `keepFiles` finds. */
    async newCode(request?: NewCodeRequest | null): Promise<PairingCode> {
      if (!server) throw new Error('Turn on sync first.');
      const value = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const keepFiles = request?.keepFiles?.trim().slice(0, 2000);
      code = { value, expiresAt: now().getTime() + CODE_LIFETIME_MS, attempts: 0, ...(keepFiles && { keepFiles }) };
      return { code: `${value.slice(0, 4)}-${value.slice(4)}`, expiresAt: new Date(code.expiresAt).toISOString() };
    },
    async unpair(origin: string) {
      const s = await load();
      s.peers = s.peers.filter((peer) => peer.origin !== origin);
      await save();
      return status();
    },
    stop: close,
  };
}

export type SyncHost = ReturnType<typeof createSyncHost>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** This computer's IPv4 addresses on its networks, private ones (home or office LANs) first. */
export function lanAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...addresses.filter(isPrivate), ...addresses.filter((ip) => !isPrivate(ip))];
}
