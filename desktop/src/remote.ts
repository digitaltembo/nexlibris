import type { MessageImpl, RemoteApi } from '@nexlibris/common';
import { Readable } from 'node:stream';
import { storeStream } from './importService';

/** The most a catalog page may be. */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
/** The most a downloaded book may be. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
/** The most an image read whole may be. */
const MAX_BYTES = 10 * 1024 * 1024;

function checkUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Not a web address: ${url}`);
  return parsed;
}

/** A downloaded file's name: the server's (Content-Disposition), else the address's last part. */
export function downloadName(response: Pick<Response, 'headers' | 'url'>): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition)?.[1];
  let name: string | undefined;
  try {
    name = star ? decodeURIComponent(star) : plain;
  } catch {
    name = plain;
  }
  name ||= decodeURIComponent(new URL(response.url).pathname.split('/').pop() ?? '');
  // Just a name: no folders.
  return name.replace(/[\\/]/g, '_').trim() || 'download';
}

/**
 * The page's fetching from the web (`common/src/remoteApi.ts`). `libraryDir` gives the folder
 * downloads are stored in (the library's, or its `.nexlibris/` in a folder of the user's).
 */
export function createRemote(libraryDir: () => string, fetcher: typeof fetch = fetch): MessageImpl<RemoteApi>['remote'] {
  return {
    async fetchText({ url, headers }) {
      checkUrl(url);
      const response = await fetcher(url, { headers: headers ?? {}, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_TEXT_BYTES) throw new Error('That page is too big to be a catalog.');
      const text = await response.text();
      if (text.length > MAX_TEXT_BYTES) throw new Error('That page is too big to be a catalog.');
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return { status: response.status, url: response.url || url, text, ...(etag && { etag }), ...(lastModified && { lastModified }) };
    },
    async fetchBytes({ url, headers }) {
      checkUrl(url);
      const response = await fetcher(url, { headers: headers ?? {}, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('That image is too big.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('That image is too big.');
      const type = response.headers.get('content-type')?.split(';')[0]?.trim();
      return { status: response.status, data: bytes.toString('base64'), ...(type && { type }) };
    },
    async download({ url, headers }) {
      checkUrl(url);
      const response = await fetcher(url, { headers: headers ?? {}, redirect: 'follow', signal: AbortSignal.timeout(10 * TIMEOUT_MS) });
      if (!response.ok || !response.body) throw new Error(`The server said ${response.status} ${response.statusText}.`);
      if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error('That file is too big.');
      let received = 0;
      const limited = async function* () {
        for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) throw new Error('That file is too big.');
          yield chunk;
        }
      };
      const { hash, size } = await storeStream(libraryDir(), limited());
      const type = response.headers.get('content-type')?.split(';')[0]?.trim();
      return { hash, size, name: downloadName(response), ...(type && { type }) };
    },
  };
}
