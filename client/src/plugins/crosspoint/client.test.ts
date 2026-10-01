import { describe, expect, it } from 'vitest';
import { CrossPointTarget } from './client';

/** Answers like the CrossPoint web server (as the simulator does), over an in-memory SD card. */
function fakeReader() {
  const files = new Map<string, number>();
  const opds = [{ name: 'Gutenberg', url: 'https://gutenberg.org/opds', username: '' }];
  const folders = new Set(['/']);
  const requests: string[] = [];
  const children = (folder: string) => [
    ...[...folders].filter((f) => f !== '/' && parent(f) === folder).map((f) => ({ name: name(f), size: 0, isDirectory: true })),
    ...[...files].filter(([f]) => parent(f) === folder).map(([f, size]) => ({ name: name(f), size, isDirectory: false })),
  ];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const form = init?.body instanceof URLSearchParams ? init.body : undefined;
    switch (`${init?.method ?? 'GET'} ${url.pathname}`) {
      case 'GET /api/status':
        return Response.json({ version: '1.2.0', ip: '192.168.1.5', mode: 'STA', device: 'X4' });
      case 'GET /api/files':
        return Response.json(children(url.searchParams.get('path') ?? '/'));
      case 'POST /mkdir': {
        const folder = join(form!.get('path')!, form!.get('name')!);
        if (!folders.has(form!.get('path')!)) return new Response('Parent folder not found', { status: 400 });
        folders.add(folder);
        return new Response('Folder created');
      }
      case 'POST /upload': {
        const file = (init!.body as FormData).get('file') as File;
        const folder = url.searchParams.get('path')!;
        if (!folders.has(folder)) return new Response('Failed to create file', { status: 500 });
        files.set(join(folder, file.name), file.size);
        return new Response('Uploaded');
      }
      case 'GET /api/opds':
        return Response.json(opds);
      case 'POST /api/opds':
        opds.push({ username: '', ...(JSON.parse(init!.body as string) as { name: string; url: string }) });
        return Response.json({ ok: true });
      case 'POST /delete':
        return files.delete(form!.get('path')!) ? new Response('Deleted') : new Response('Not found', { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
  return { files, folders, opds, requests, fetchFn };
}

const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join = (folder: string, child: string) => `${folder.replace(/\/$/, '')}/${child}`;

describe('CrossPointTarget', () => {
  it('describes the reader, makes folders, and uploads, lists and deletes files', async () => {
    const reader = fakeReader();
    const target = new CrossPointTarget('192.168.1.5/', reader.fetchFn);
    expect(target.base).toBe('http://192.168.1.5');
    expect(await target.connect()).toEqual({ description: 'X4, firmware 1.2.0' });

    await target.ensureFolder('/Books/Sci-fi');
    await target.ensureFolder('/Books/Sci-fi');
    expect([...reader.folders]).toEqual(['/', '/Books', '/Books/Sci-fi']);
    expect(reader.requests.filter((r) => r === 'POST /mkdir')).toHaveLength(2);

    await target.upload('/Books/Sci-fi/Dune - Frank Herbert.epub', new Blob(['dune']));
    expect(await target.list('/Books/Sci-fi')).toEqual([{ path: '/Books/Sci-fi/Dune - Frank Herbert.epub', size: 4 }]);
    expect(await target.list('/Books')).toEqual([]);

    await target.remove('/Books/Sci-fi/Dune - Frank Herbert.epub');
    expect(reader.files.size).toBe(0);
  });

  it('lists and adds OPDS servers', async () => {
    const reader = fakeReader();
    const target = new CrossPointTarget('crosspoint.local', reader.fetchFn);
    expect(await target.listCatalogs()).toEqual([{ name: 'Gutenberg', url: 'https://gutenberg.org/opds' }]);
    await target.addCatalog({ name: 'X4', url: 'https://books.example/index.xml' });
    expect(reader.opds.at(-1)).toEqual({ name: 'X4', url: 'https://books.example/index.xml', username: '' });
  });

  it('says what went wrong', async () => {
    const reader = fakeReader();
    const target = new CrossPointTarget('http://crosspoint.local', reader.fetchFn);
    await expect(target.upload('/Missing/a.epub', new Blob(['a']))).rejects.toThrow('The reader refused /upload: Failed to create file');

    const offline = new CrossPointTarget('crosspoint.local', (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(offline.connect()).rejects.toThrow('Couldn’t reach http://crosspoint.local'.replace('’', "'"));
  });
});
