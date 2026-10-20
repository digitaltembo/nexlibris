import { describe, expect, it } from 'vitest';
import { bucketStore, EMPTY_SHA256, providerDefaults, signRequest } from './s3';

const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('signRequest', () => {
  it('signs as AWS’s own example does (GET Object, in the SigV4 header-signing docs)', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      ...credentials,
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('signs a query as AWS’s example does (GET Bucket lifecycle)', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      ...credentials,
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toContain('Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
});

describe('providerDefaults', () => {
  it('knows each provider’s endpoint', () => {
    expect(providerDefaults('s3', 'eu-west-2').endpoint).toBe('https://s3.eu-west-2.amazonaws.com');
    expect(providerDefaults('gcs', undefined)).toEqual({ endpoint: 'https://storage.googleapis.com', region: 'auto', pathStyle: false });
    expect(providerDefaults('b2', 'us-west-004').endpoint).toBe('https://s3.us-west-004.backblazeb2.com');
    expect(() => providerDefaults('b2', undefined)).toThrow(/region/);
  });
});

describe('bucketStore', () => {
  /** An S3 that keeps objects in memory and checks each request is signed. */
  function fakeS3() {
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const requests: { method: string; url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const method = init.method ?? 'GET';
      requests.push({ method, url: url.href, headers });
      if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/')) return new Response('', { status: 403 });
      const key = decodeURIComponent(url.pathname.slice(1));
      if (method === 'PUT') {
        objects.set(key, new Uint8Array(await (init.body as Blob).arrayBuffer()));
        return new Response('');
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      const object = objects.get(key);
      if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(method === 'HEAD' ? null : new Blob([object]), { headers: { 'content-length': String(object.length) } });
    }) as typeof fetch;
    return { objects, requests, fetchImpl };
  }

  it('stores, reads, lists and deletes objects in a bucket, signing every call', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const s3 = fakeS3();
    const store = bucketStore({ bucket: 'books', region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', pathStyle: false, ...credentials }, s3.fetchImpl);
    const source = join(await mkdtemp(join(tmpdir(), 'nexlibris-s3-')), 'upload');
    await writeFile(source, 'a book');
    const sha256 = createHash('sha256').update('a book').digest('hex');
    await store.put('accounts/a/files/ab/abc', source, { size: 6, sha256 });
    const put = s3.requests[0]!;
    expect(put.url).toBe('https://books.s3.us-west-004.backblazeb2.com/accounts/a/files/ab/abc');
    expect(put.headers.get('x-amz-content-sha256')).toBe(sha256);
    expect(await store.head('accounts/a/files/ab/abc')).toBe(6);
    expect(await store.head('accounts/a/files/ab/none')).toBeUndefined();
    const object = await store.get('accounts/a/files/ab/abc');
    const chunks: Buffer[] = [];
    for await (const chunk of object!.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('a book');
    expect(await store.list('accounts/a/')).toEqual(['accounts/a/files/ab/abc']);
    await store.remove('accounts/a/files/ab/abc');
    expect(await store.list('accounts/a/')).toEqual([]);
    await expect(store.head('accounts/../x')).rejects.toThrow('Bad key');
  });

  it('says why the bucket refused', async () => {
    const store = bucketStore(
      { bucket: 'books', region: 'auto', endpoint: 'https://storage.googleapis.com', pathStyle: true, ...credentials, secretAccessKey: 'x' },
      (async () => new Response('<Error><Code>AccessDenied</Code><Message>Nope &amp; no</Message></Error>', { status: 403 })) as typeof fetch,
    );
    await expect(store.list('')).rejects.toThrow('Listing  failed: HTTP 403 AccessDenied (Nope & no)');
  });
});
