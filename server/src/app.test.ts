import {
  createLibrary,
  hashBlob,
  httpHubFiles,
  httpSyncClient,
  MemoryStorage,
  pairWithHub,
  previewSync,
  runSync,
  serverClient,
  ServerLibraryBackend,
  isSignedOut,
  StoredLibraryBackend,
  type Item,
} from '@nexlibris/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './app';
import { folderStore } from './objectStore';

let dir: string;
let server: Server;
let base: string;
let app: App;

async function start(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  app = createApp({
    dataDir: join(dir, 'data'),
    files: folderStore(join(dir, 'files')),
    signup: 'open',
    name: 'Test cloud',
    secureCookies: 'auto',
    trustProxy: false,
    ...options,
  });
  server = app.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexlibris-server-'));
  await start();
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

/** A browser's fetch for one person: it keeps the session cookie, and says where calls come from. */
function browser(origin = base): typeof fetch {
  let cookie = '';
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    headers.set('Origin', origin);
    const url = typeof input === 'string' && input.startsWith('/') ? base + input : input;
    const response = await fetch(url, { ...init, headers, ...(init.body instanceof Blob && { duplex: 'half' }) } as RequestInit);
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    return response;
  };
}

const book = (id: string, title: string): Item => ({
  id,
  kind: 'book',
  title,
  creators: [{ name: 'Frank Herbert', role: 'aut' }],
  identifiers: {},
  tags: [],
  metadata: {},
  files: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

async function signedUp(name = 'ada', fetchImpl = browser()) {
  await serverClient(base, fetchImpl).auth.signUp({ name, password: 'correct horse' });
  return { fetchImpl, backend: new ServerLibraryBackend(base, fetchImpl) };
}

describe('accounts', () => {
  it('signs up, in and out, with the session in an HttpOnly cookie', async () => {
    const fetchImpl = browser();
    const auth = serverClient(base, fetchImpl).auth;
    expect(await auth.session(null)).toEqual({ signup: true, name: 'Test cloud' });
    const response = await fetchImpl('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', password: 'correct horse' }),
    });
    expect(response.headers.get('set-cookie')).toMatch(/^nexlibris_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect((await auth.session(null)).account?.name).toBe('Ada');
    expect((await auth.signOut(null)).account).toBeUndefined();
    expect((await auth.session(null)).account).toBeUndefined();
    expect((await auth.signIn({ name: 'ada', password: 'correct horse' })).account?.name).toBe('Ada');
    await expect(auth.signIn({ name: 'Ada', password: 'wrong horse' })).rejects.toThrow('don’t match');
    await expect(auth.signUp({ name: 'ADA', password: 'another one' })).rejects.toThrow('already');
    await expect(auth.signUp({ name: 'Bob', password: 'short' })).rejects.toThrow('at least 8');
  });

  it('answers as estuary-rpc-server does', async () => {
    const { fetchImpl } = await signedUp();
    const session = await fetchImpl('/api/auth/session');
    expect(await session.json()).toEqual({ account: expect.objectContaining({ name: 'ada' }), signup: false, name: 'Test cloud' });
    const unchanged = await fetchImpl('/api/library/get?revision=0');
    expect(unchanged.status).toBe(204);
    const wrong = await fetchImpl('/api/auth/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"ada","password":"nope nope"}' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ status: 'error', message: 'That name and password don’t match an account.' });
    const signedOut = await fetch(`${base}/api/library/status`);
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).status).toBe('error');
    const stale = await fetchImpl('/api/library/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ops":[],"expectRevision":5}' });
    expect(stale.status).toBe(409);
  });

  it('keeps passwords and sessions only as hashes', async () => {
    await signedUp();
    const accounts = await readFile(join(dir, 'data', 'accounts.json'), 'utf8');
    const sessions = await readFile(join(dir, 'data', 'sessions.json'), 'utf8');
    expect(accounts).not.toContain('correct horse');
    expect(accounts).toMatch(/"password": "scrypt\$/);
    expect(sessions).toMatch(/"tokenHash": "[0-9a-f]{64}"/);
  });

  it('takes only the first account when sign-up is “first”', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({ signup: 'first' });
    await signedUp('ada');
    const other = serverClient(base, browser()).auth;
    expect((await other.session(null)).signup).toBe(false);
    await expect(other.signUp({ name: 'bob', password: 'correct horse' })).rejects.toThrow('doesn’t take new accounts');
  });

  it('changes a password, signing out the account’s other sessions', async () => {
    const { fetchImpl } = await signedUp();
    const elsewhere = browser();
    await serverClient(base, elsewhere).auth.signIn({ name: 'ada', password: 'correct horse' });
    await serverClient(base, fetchImpl).auth.changePassword({ password: 'correct horse', newPassword: 'battery staple' });
    expect((await serverClient(base, fetchImpl).auth.session(null)).account?.name).toBe('ada');
    expect((await serverClient(base, elsewhere).auth.session(null)).account).toBeUndefined();
  });

  it('refuses calls from other sites', async () => {
    const signUp = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ada', password: 'correct horse' }),
    });
    // Even with the cookie, which a browser wouldn't send cross-site anyway (SameSite=Strict).
    const cookie = signUp.headers.get('set-cookie')!.split(';')[0]!;
    const evil = async (headers: Record<string, string>) => {
      const response = await fetch(`${base}/api/library/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
        body: JSON.stringify({ ops: [] }),
      });
      return response.status;
    };
    expect(await evil({})).toBe(200);
    expect(await evil({ Origin: 'https://evil.example' })).toBe(403);
    expect(await evil({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await evil({ 'Content-Type': 'text/plain' })).toBe(415);
    // Nor may another site sign a browser in, for a cookie.
    const signIn = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'ada', password: 'correct horse' }),
    });
    expect(signIn.status).toBe(403);
    expect(signIn.headers.get('set-cookie')).toBeNull();
  });
});

describe('the account’s library', () => {
  it('is a library backend, with files kept for the account alone', async () => {
    const { backend } = await signedUp();
    let library = await backend.getLibrary();
    expect(library.revision).toBe(0);
    const data = new Blob(['an epub, honestly']);
    const { hash, size } = await backend.putFile(data);
    expect(hash).toBe(await hashBlob(data));
    library = await backend.apply([{ type: 'addItem', item: book('dune', 'Dune') }, { type: 'attachFile', id: 'dune', file: { hash, size, format: 'epub' } }]);
    expect(library.items.dune?.files).toHaveLength(1);
    expect(await (await backend.getFile(hash))?.text()).toBe('an epub, honestly');
    expect(await backend.hasFile(hash)).toBe(true);
    expect((await backend.getChanges(0)).map((c) => c.op.type)).toEqual(['addItem', 'attachFile']);
    await expect(backend.apply([{ type: 'removeItem', id: 'dune' }], 0)).rejects.toThrow('revision');

    // Someone else signed in can't see it.
    const { backend: other } = await signedUp('bob');
    expect(await other.getFile(hash)).toBeUndefined();
    expect(Object.keys((await other.getLibrary()).items)).toEqual([]);
    // Nor can anyone signed out.
    const signedOut = new ServerLibraryBackend(base, browser());
    expect(isSignedOut(await signedOut.getFile(hash).catch((e: unknown) => e))).toBe(true);
    expect(isSignedOut(await signedOut.getLibrary().catch((e: unknown) => e))).toBe(true);
  });

  it('serves stored files as inert bytes', async () => {
    const { fetchImpl, backend } = await signedUp();
    const { hash } = await backend.putFile(new Blob(['<script>alert(1)</script>']));
    const response = await fetchImpl(`/api/library/files/${hash}`);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses an upload that doesn’t match its hash', async () => {
    const { fetchImpl } = await signedUp();
    const response = await fetchImpl(`/api/library/files/${'0'.repeat(64)}`, { method: 'PUT', body: new Blob(['not that']) });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('don’t match');
  });

  it('keeps local state and files', async () => {
    const { backend } = await signedUp();
    expect(await backend.readLocalState('sync')).toBeUndefined();
    await backend.writeLocalState('sync', { pairings: [] });
    expect(await backend.readLocalState('sync')).toEqual({ pairings: [] });
    await backend.writeLocalFile('thumbs/ab/abcd.jpg', new Blob(['thumb']));
    expect(await (await backend.readLocalFile('thumbs/ab/abcd.jpg'))?.text()).toBe('thumb');
    await backend.deleteLocalFile('thumbs/ab/abcd.jpg');
    expect(await backend.readLocalFile('thumbs/ab/abcd.jpg')).toBeUndefined();
    const { fetchImpl } = await signedUp('bob');
    const sneaky = await fetchImpl(`/api/library/local?path=${encodeURIComponent('"thumbs/../../../accounts.json"')}`);
    expect(sneaky.status).toBe(400);
  });

  it('takes a library moved in, once, and deletes it when it moves out', async () => {
    const { fetchImpl, backend } = await signedUp();
    const api = serverClient(base, fetchImpl).library;
    const local = new StoredLibraryBackend(new MemoryStorage());
    const { hash, size } = await local.putFile(new Blob(['book']));
    await local.apply([{ type: 'addItem', item: book('dune', 'Dune') }, { type: 'attachFile', id: 'dune', file: { hash, size, format: 'epub' } }]);
    expect(await api.missing({ hashes: [hash] })).toEqual([hash]);
    await backend.putFile((await local.getFile(hash))!);
    expect(await api.missing({ hashes: [hash] })).toEqual([]);
    await api.import({ library: await local.getLibrary(), changes: await local.getChanges(0) });

    expect(await api.status(null)).toEqual({ exists: true, items: 1, files: 1, bytes: 4 });
    const library = await backend.getLibrary();
    expect(library.items.dune?.title).toBe('Dune');
    expect(library.origin).toBe((await local.getLibrary()).origin);
    expect(await backend.getChanges(0)).toHaveLength(2);
    await expect(api.import({ library: createLibrary('Another'), changes: [] })).rejects.toThrow('has a library already');

    await api.remove(null);
    expect(await api.status(null)).toEqual({ exists: false, items: 0, files: 0, bytes: 0 });
    expect(await backend.hasFile(hash)).toBe(false);
  });

  it('serves the web app to anyone, as one page', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const client = join(dir, 'client');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(client, 'assets'), { recursive: true });
    await writeFile(join(client, 'index.html'), '<!doctype html><title>nexlibris</title>');
    await writeFile(join(client, 'assets', 'app-1234.js'), 'console.log(1)');
    await start({ clientDir: client });
    const index = await fetch(`${base}/`);
    expect(await index.text()).toContain('<title>nexlibris</title>');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${base}/assets/app-1234.js`);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await (await fetch(`${base}/library/somewhere`)).text()).toContain('<title>nexlibris</title>');
    // Nothing outside the app's folder: that's the app too.
    expect(await (await fetch(`${base}/..%2f..%2fdata/accounts.json`)).text()).toContain('<title>nexlibris</title>');
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  });
});

describe('the apps', () => {
  /** An app's page: another origin, no cookies, the session's token sent as a bearer token. */
  const app = (token?: string): typeof fetch => async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', 'app://nexlibris');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, ...(init.body instanceof Blob && { duplex: 'half' }) } as RequestInit);
  };

  it('sign in for a token rather than a cookie, and use it in place of the cookie', async () => {
    const preflight = await fetch(`${base}/api/library/apply`, {
      method: 'OPTIONS',
      headers: { Origin: 'app://nexlibris', 'Access-Control-Request-Headers': 'authorization, content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Authorization/);

    const signUp = await fetch(`${base}/api/auth/sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'app://nexlibris' },
      body: JSON.stringify({ name: 'ada', password: 'correct horse', token: true }),
    });
    expect(signUp.headers.get('set-cookie')).toBeNull();
    const { token, account } = (await signUp.json()) as { token: string; account: { name: string } };
    expect(account.name).toBe('ada');
    expect(token).toMatch(/^[\w-]{20,}$/);

    // A change from another origin is fine with the token: there's no cookie a browser added.
    const backend = new ServerLibraryBackend(base, app(token));
    await backend.apply([{ type: 'addItem', item: book('dune', 'Dune') }]);
    const { hash } = await backend.putFile(new Blob(['dune']));
    expect(await (await backend.getFile(hash))?.text()).toBe('dune');
    expect((await serverClient(base, app(token)).auth.session(null)).account?.name).toBe('ada');

    // Pairing by the session, as a browser's page does.
    const pairing = await pairWithHub(new StoredLibraryBackend(new MemoryStorage()), httpSyncClient(base, undefined, app(token)), base, '', 'Pixel 9');
    expect(pairing.key).toBeTruthy();

    await serverClient(base, app(token)).auth.signOut(null);
    expect(isSignedOut(await backend.getLibrary().catch((e: unknown) => e))).toBe(true);
    expect(isSignedOut(await new ServerLibraryBackend(base, app('made-up')).getLibrary().catch((e: unknown) => e))).toBe(true);
  });
});

describe('sync with the account', () => {
  it('pairs a browser’s library by its session, and syncs both ways, files too', async () => {
    const { fetchImpl, backend: cloud } = await signedUp();
    const { hash: cloudHash, size } = await cloud.putFile(new Blob(['cloud book']));
    await cloud.apply([{ type: 'addItem', item: book('dune', 'Dune') }, { type: 'attachFile', id: 'dune', file: { hash: cloudHash, size, format: 'epub' } }]);

    const local = new StoredLibraryBackend(new MemoryStorage());
    await local.apply([{ type: 'addItem', item: book('emma', 'Emma') }]);
    const pairing = await pairWithHub(local, httpSyncClient(base, undefined, fetchImpl), base, '', 'Chrome on a Mac');
    expect(pairing.hub.name).toBe('Test cloud');

    // Later calls carry the key alone, as from another origin.
    const hub = httpSyncClient(base, pairing.key);
    const preview = await previewSync(local, hub, pairing);
    const result = await runSync(local, hub, pairing, preview);
    expect(result.sent).toBeGreaterThan(0);
    expect(Object.keys((await local.getLibrary()).items).sort()).toEqual(['dune', 'emma']);
    expect(Object.keys((await cloud.getLibrary()).items).sort()).toEqual(['dune', 'emma']);

    const files = httpHubFiles(base, pairing.key, local);
    await files.download(cloudHash);
    expect(await (await local.getFile(cloudHash))?.text()).toBe('cloud book');
    const { hash: localHash } = await local.putFile(new Blob(['local book']));
    expect(await files.missing([localHash, cloudHash])).toEqual([localHash]);
    await files.upload(localHash);
    expect(await (await cloud.getFile(localHash))?.text()).toBe('local book');
  });

  it('won’t pair without a session, or sync without a key', async () => {
    const hub = httpSyncClient(base, undefined, browser());
    await expect(hub.pair({ code: '', peer: { origin: 'x', name: 'y' } })).rejects.toThrow('signed out');
    const keyless = httpSyncClient(base, 'made-up');
    await expect(keyless.hello(null)).rejects.toThrow('isn’t paired');
  });
});
