import { isFileHash } from '@nexlibris/common';
import { ApiError } from 'estuary-rpc';
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import type { Libraries } from '../libraries';

/** Books' files as the library and sync endpoints both serve and take them. */

export function fileHash(value: unknown): string {
  if (typeof value !== 'string' || !isFileHash(value)) throw new ApiError(400, 'Bad file hash.');
  return value;
}

/**
 * A stored file, as untrusted bytes: books carry HTML, so nothing the server sends from them may
 * run as its own page (no sniffing, and sandboxed if opened directly).
 */
export function sendObject(res: ServerResponse, object: { size: number; body: Readable } | undefined): void {
  if (!object) throw new ApiError(404, 'That file isn’t stored here.');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': object.size,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-cache',
  });
  object.body.on('error', () => res.destroy()).pipe(res);
}

/** Stores a file streamed in as a request's body, under its hash; answered with nothing (204). */
export async function receive(libraries: Libraries, accountId: string, body: AsyncIterable<Buffer | Uint8Array>, hash: string): Promise<void> {
  await libraries.storeFile(accountId, body, hash);
}

/** Which of the hashes asked about an account doesn't have the file of. */
export async function lacking(libraries: Libraries, accountId: string, hashes: unknown): Promise<string[]> {
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && isFileHash(h))) throw new ApiError(400, 'Bad request.');
  const missing: string[] = [];
  for (const hash of new Set(hashes as string[])) if (!(await libraries.hasFile(accountId, hash))) missing.push(hash);
  return missing;
}
