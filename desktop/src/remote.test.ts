import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemote, downloadName } from './remote';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/feed') {
      if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
      return res.writeHead(200, { 'Content-Type': 'application/atom+xml', ETag: '"v1"' }).end('<feed/>');
    }
    if (req.url === '/private/cover.jpg') {
      if (req.headers.authorization !== `Basic ${Buffer.from('reader:secret').toString('base64')}`) return res.writeHead(401).end();
      return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end('jpeg');
    }
    if (req.url === '/moved') return res.writeHead(302, { Location: '/files/dune.epub' }).end();
    if (req.url === '/files/dune.epub') return res.writeHead(200, { 'Content-Type': 'application/epub+zip' }).end('spice');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('fetching from the web for the page', () => {
  it('reads a catalog page, with what checks it later', async () => {
    const remote = createRemote(() => tmpdir());
    expect(await remote.fetchText({ url: `${base}/feed` })).toMatchObject({ status: 200, text: '<feed/>', etag: '"v1"' });
    expect((await remote.fetchText({ url: `${base}/feed`, headers: { 'If-None-Match': '"v1"' } })).status).toBe(304);
    await expect(remote.fetchText({ url: 'file:///etc/passwd' })).rejects.toThrow(/Not a web address/);
  });

  it('downloads a book into the library’s stored files, following redirects', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nexlibris-remote-')));
    const got = await createRemote(() => dir).download({ url: `${base}/moved` });
    const hash = createHash('sha256').update('spice').digest('hex');
    expect(got).toEqual({ hash, size: 5, name: 'dune.epub', type: 'application/epub+zip' });
    expect(readFileSync(join(dir, 'files', hash.slice(0, 2), hash), 'utf8')).toBe('spice');
    await expect(createRemote(() => dir).download({ url: `${base}/nothing` })).rejects.toThrow(/404/);
  });

  it('sends the headers given, e.g. a sign-in, and reads small files whole', async () => {
    const remote = createRemote(() => tmpdir());
    const authorization = `Basic ${Buffer.from('reader:secret').toString('base64')}`;
    expect((await remote.fetchBytes({ url: `${base}/private/cover.jpg` })).status).toBe(401);
    const got = await remote.fetchBytes({ url: `${base}/private/cover.jpg`, headers: { Authorization: authorization } });
    expect(got).toEqual({ status: 200, type: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
  });

  it('names downloads by the server’s name, else the address', () => {
    const named = (disposition: string | null, url: string) =>
      downloadName({ url, headers: new Headers(disposition ? { 'content-disposition': disposition } : {}) });
    expect(named('attachment; filename="Dune.epub"', 'https://x/1')).toBe('Dune.epub');
    expect(named("attachment; filename*=UTF-8''Caf%C3%A9.epub", 'https://x/1')).toBe('Café.epub');
    expect(named(null, 'https://x/cache/pg84.epub')).toBe('pg84.epub');
  });
});
