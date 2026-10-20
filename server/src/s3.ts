import { createHash, createHmac } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { checkKey, type ObjectStore } from './objectStore';

/**
 * Objects in a bucket, over the S3 API with AWS Signature Version 4: Amazon S3, and the services
 * that speak it: Google Cloud Storage (its XML API, with HMAC keys), Backblaze B2, Cloudflare R2,
 * MinIO and so on. Written over `fetch` rather than an SDK, as it needs only five calls.
 * The bucket should be private; every read goes through the server, which checks the account.
 */

export interface BucketOptions {
  bucket: string;
  /** e.g. `us-east-1`, or B2's `us-west-004`; GCS takes `auto`. */
  region: string;
  /** The service's address, e.g. `https://s3.us-east-1.amazonaws.com`. */
  endpoint: string;
  /** Addresses objects as `<endpoint>/<bucket>/<key>` rather than `<bucket>.<endpoint host>/<key>`. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials. */
  sessionToken?: string;
}

export type Provider = 's3' | 'gcs' | 'b2';

/** A provider's endpoint, region and addressing, when they aren't given. */
export function providerDefaults(provider: Provider, region: string | undefined): { endpoint: string; region: string; pathStyle: boolean } {
  switch (provider) {
    case 'gcs':
      return { endpoint: 'https://storage.googleapis.com', region: region ?? 'auto', pathStyle: false };
    case 'b2':
      if (!region) throw new Error('Backblaze B2 needs --region, the bucket’s region as its endpoint names it (e.g. us-west-004).');
      return { endpoint: `https://s3.${region}.backblazeb2.com`, region, pathStyle: false };
    default:
      return { endpoint: `https://s3.${region ?? 'us-east-1'}.amazonaws.com`, region: region ?? 'us-east-1', pathStyle: false };
  }
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256Hex('');

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigningRequest {
  method: string;
  url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`, which are added. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body. */
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
}

/** The request's headers with AWS Signature Version 4's `Authorization`, for S3. */
export function signRequest(request: SigningRequest): Record<string, string> {
  const amzDate = request.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: request.url.host,
    'x-amz-content-sha256': request.payloadHash,
    'x-amz-date': amzDate,
    ...(request.sessionToken && { 'x-amz-security-token': request.sessionToken }),
  };
  const names = Object.keys(headers).sort();
  const query = [...request.url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = request.url.pathname.split('/').map((s) => encode(decodeURIComponent(s))).join('/') || '/';
  const canonical = [
    request.method,
    path,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    request.payloadHash,
  ].join('\n');
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, day), request.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const xmlText = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function bucketStore(options: BucketOptions, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ObjectStore {
  const endpoint = new URL(options.endpoint);
  const base = options.pathStyle
    ? `${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/${options.bucket}`
    : `${endpoint.protocol}//${options.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/$/, '')}`;
  const objectUrl = (key: string) => new URL(`${base}/${checkKey(key).map(encode).join('/')}`);

  const call = async (method: string, url: URL, init: { body?: Blob; payloadHash?: string; headers?: Record<string, string> } = {}) => {
    const headers = signRequest({
      method,
      url,
      payloadHash: init.payloadHash ?? EMPTY_SHA256,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken && { sessionToken: options.sessionToken }),
      ...(init.headers && { headers: init.headers }),
      date: now(),
    });
    try {
      return await fetchImpl(url, { method, headers, ...(init.body && { body: init.body }) });
    } catch (e) {
      throw new Error(`Couldn’t reach the bucket ${options.bucket}: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
  };
  const fail = async (response: Response, what: string): Promise<never> => {
    const text = await response.text().catch(() => '');
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
    throw new Error(`${what} failed: HTTP ${response.status}${code ? ` ${code}` : ''}${message ? ` (${xmlText(message)})` : ''}`);
  };

  return {
    description: `the bucket ${options.bucket} at ${endpoint.host}`,
    async head(key) {
      const response = await call('HEAD', objectUrl(key));
      if (response.status === 404) return undefined;
      if (!response.ok) return fail(response, `Checking ${key}`);
      return Number(response.headers.get('content-length') ?? 0);
    },
    async get(key) {
      const response = await call('GET', objectUrl(key));
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok || !response.body) return fail(response, `Reading ${key}`);
      return { size: Number(response.headers.get('content-length') ?? 0), body: Readable.fromWeb(response.body as never) };
    },
    async put(key, source, { sha256 }) {
      // A file-backed blob streams from disk, with its length known, as S3 needs.
      const body = await openAsBlob(source);
      const response = await call('PUT', objectUrl(key), { body, payloadHash: sha256, headers: { 'content-type': 'application/octet-stream' } });
      if (!response.ok) return fail(response, `Storing ${key}`);
      await response.body?.cancel();
    },
    async remove(key) {
      const response = await call('DELETE', objectUrl(key));
      if (!response.ok && response.status !== 404) return fail(response, `Deleting ${key}`);
      await response.body?.cancel();
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const url = new URL(`${base}/`);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        if (token) url.searchParams.set('continuation-token', token);
        const response = await call('GET', url);
        if (!response.ok) return fail(response, `Listing ${prefix}`);
        const text = await response.text();
        for (const match of text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlText(match[1]!));
        token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? /<NextContinuationToken>([^<]*)</.exec(text)?.[1] : undefined;
        if (token) token = xmlText(token);
      } while (token);
      return keys.sort();
    },
  };
}
