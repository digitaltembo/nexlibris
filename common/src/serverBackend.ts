import { hashBlob, type LibraryBackend } from './backend';
import type { Change, Operation } from './operations';
import { failedWith, httpClient, reaching } from './rest';
import type { MessageClient } from './rpc';
import { serverApiMeta, type ServerApi } from './serverApi';
import type { FileHash, Library } from './types';

/**
 * The library in a nexlibris server account (M4), as a `LibraryBackend` for the web client the
 * server serves: calls go to the page's own origin (or `base`), signed in by the session cookie,
 * with estuary-rpc-client. The server applies operations, so several devices on one account can't
 * overwrite each other's; `getLibrary` asks it whether the library moved on since it was last
 * fetched. Files stream (`serverApi.ts`'s raw endpoints).
 */

const UNREACHABLE = 'Couldn’t reach the nexlibris server. Check your connection.';

/** Whether a call failed because nobody's signed in (the session ended, say): a 401. */
export const isSignedOut = (e: unknown) => failedWith(e, 401);

/** The server API's client (`serverApi.ts`), on the page's origin unless given `base`. */
export const serverClient = (base?: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): MessageClient<ServerApi> =>
  httpClient(serverApiMeta, { ...(base && { baseUrl: base }), fetch: reaching(fetchImpl, UNREACHABLE) });

/** A raw endpoint's reply, or undefined for a 404. */
async function found(reply: Promise<unknown>): Promise<Response | undefined> {
  try {
    return (await reply) as Response;
  } catch (e) {
    if (failedWith(e, 404)) return undefined;
    throw e;
  }
}

export class ServerLibraryBackend implements LibraryBackend {
  private readonly api: MessageClient<ServerApi>['library'];
  private library: Library | undefined;

  constructor(base?: string, fetchImpl?: typeof fetch) {
    this.api = serverClient(base, fetchImpl).library;
  }

  async getLibrary(): Promise<Library> {
    const fresh = await this.api.get(this.library ? { revision: this.library.revision } : {});
    if (fresh) this.library = fresh;
    return this.library!;
  }

  async apply(ops: Operation[], expectRevision?: number): Promise<Library> {
    this.library = await this.api.apply({ ops, ...(expectRevision !== undefined && { expectRevision }) });
    return this.library;
  }

  getChanges(sinceRevision: number): Promise<Change[]> {
    return this.api.changes({ since: sinceRevision });
  }

  async putFile(data: Blob): Promise<{ hash: FileHash; size: number }> {
    const hash = await hashBlob(data);
    if (!(await this.api.hasFile({ hash }))) await this.upload(this.api.putFile, { hash }, data);
    return { hash, size: data.size };
  }

  async getFile(hash: FileHash): Promise<Blob | undefined> {
    return (await found(this.api.file({ hash })))?.blob();
  }

  hasFile(hash: FileHash): Promise<boolean> {
    return this.api.hasFile({ hash });
  }

  async deleteFile(hash: FileHash): Promise<void> {
    await this.api.deleteFile({ hash });
  }

  async readLocalState<T>(key: string): Promise<T | undefined> {
    return ((await this.api.readLocalState({ key })) ?? undefined) as T | undefined;
  }

  async writeLocalState(key: string, value: unknown): Promise<void> {
    await this.api.writeLocalState({ key, value });
  }

  async readLocalFile(path: string): Promise<Blob | undefined> {
    return (await found(this.api.localFile({ path })))?.blob();
  }

  writeLocalFile(path: string, data: Blob): Promise<void> {
    return this.upload(this.api.putLocalFile, { path }, data);
  }

  async deleteLocalFile(path: string): Promise<void> {
    await this.api.deleteLocalFile({ path });
  }

  /** A raw endpoint called with a body, which `MessageClient`'s one-argument form doesn't show. */
  private async upload<Req>(endpoint: (input: Req) => Promise<unknown>, request: Req, body: Blob): Promise<void> {
    await (endpoint as (input: Req, options: { body: Blob }) => Promise<unknown>)(request, { body });
  }
}
