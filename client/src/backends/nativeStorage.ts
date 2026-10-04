import { RpcStorage } from '@nexlibris/common';

/** What the apps serve (see `desktop/src/appProtocol.ts` and `LibraryFilesPathHandler.kt`). */
const SERVED = ['files/', 'local/thumbs/'];

/**
 * Library storage in the Android or desktop app's native files: the bridge for
 * everything, except reading stored files (books, covers) and cover thumbnails,
 * which the app serves at `/library/`. Fetching them skips base64 and the bridge's single queue, so a
 * book opens and covers load several times faster.
 */
export class NativeStorage extends RpcStorage {
  constructor(
    api: ConstructorParameters<typeof RpcStorage>[0],
    private readonly fetchFile: typeof fetch = (input, init) => fetch(input, init),
  ) {
    super(api);
  }

  override async readBlob(path: string): Promise<Blob | undefined> {
    if (!SERVED.some((prefix) => path.startsWith(prefix))) return super.readBlob(path);
    const response = await this.fetchFile(`/library/${path}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Couldn't read ${path}: ${response.status} ${response.statusText}`);
    return response.blob();
  }
}
