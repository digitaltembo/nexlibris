import type { RpcRequest } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { pickNativeFiles, type CopyProgress } from './nativeImport';

/** A native app that offers these files and stores them two at a time. */
function fakeApp(chosen: { name: string; path?: string; size: number }[], skipped: { name: string; reason: string }[] = []) {
  const requests: RpcRequest[] = [];
  const transport = async (request: RpcRequest) => {
    requests.push(request);
    if (request.url === 'api/import/pick') return { token: 't1', files: chosen, skipped };
    const { token, start } = request.body as { token: string; start: number };
    if (token !== 't1') throw new Error('wrong token');
    const batch = chosen.slice(start, start + 2);
    return { files: batch.map((f, i) => ({ ...f, hash: `ab${start + i}` })), skipped: [], next: start + batch.length };
  };
  return { requests, transport };
}

const fetchFile = (async (url: string) => new Response(`read ${url}`)) as typeof fetch;

describe('pickNativeFiles', () => {
  it('asks for a folder with Calibre’s sidecars, keeping paths and leaving out files not worth a mention', async () => {
    const { requests, transport } = fakeApp(
      [
        { name: 'Dune.epub', path: 'Lib/Herbert/Dune.epub', size: 4 },
        { name: 'loose.pdf', size: 2 },
      ],
      [
        { name: 'Lib/metadata.db', reason: 'unsupported file type' },
        { name: 'Lib/notes.doc', reason: 'unsupported file type' },
      ],
    );
    const picked = (await pickNativeFiles({ folder: true }, transport, fetchFile))!;

    const body = requests[0]!.body as { folder: boolean; names: string[] };
    expect(body.folder).toBe(true);
    expect(body.names).toContain('metadata.opf');
    expect(picked.files.map((f) => [f.name, f.webkitRelativePath, f.stored])).toEqual([
      ['Dune.epub', 'Lib/Herbert/Dune.epub', { hash: 'ab0', size: 4 }],
      ['loose.pdf', undefined, { hash: 'ab1', size: 2 }],
    ]);
    expect(picked.skipped.map((s) => s.name)).toEqual(['Lib/notes.doc']);
    expect(new TextDecoder().decode(await picked.files[0]!.arrayBuffer())).toBe('read /library/files/ab/ab0');
  });

  it('copies in batches, reporting progress by files and bytes', async () => {
    const chosen = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({ name: `${name}.epub`, size: 10 * (i + 1) }));
    const { requests, transport } = fakeApp(chosen);
    const progress: CopyProgress[] = [];
    const picked = (await pickNativeFiles({ onCopy: (p) => progress.push(p) }, transport, fetchFile))!;

    expect(picked.files).toHaveLength(5);
    expect(requests.map((r) => r.url)).toEqual(['api/import/pick', 'api/import/store', 'api/import/store', 'api/import/store']);
    expect(progress.map((p) => [p.files, p.bytes, p.current])).toEqual([
      [0, 0, 'a.epub'],
      [2, 30, 'c.epub'],
      [4, 100, 'e.epub'],
      [5, 150, undefined],
    ]);
    expect(progress[0]).toMatchObject({ totalFiles: 5, totalBytes: 150 });
  });

  it('stops copying when asked, returning nothing to import', async () => {
    const { requests, transport } = fakeApp(['a', 'b', 'c'].map((name) => ({ name: `${name}.epub`, size: 1 })));
    const stop = new AbortController();
    const picked = await pickNativeFiles({ signal: stop.signal, onCopy: (p) => p.files === 2 && stop.abort() }, transport, fetchFile);
    expect(picked).toBeUndefined();
    expect(requests.filter((r) => r.url === 'api/import/store')).toHaveLength(1);
  });

  it('does nothing outside the native apps', async () => {
    expect(await pickNativeFiles({}, undefined)).toBeUndefined();
  });
});
