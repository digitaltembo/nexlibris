import { RpcStorage, servedLibraryPath, type LibraryFolderApi, type MessageClient } from '@nexlibris/common';

/**
 * Library storage in the Android or desktop app's native files: the bridge for
 * everything, except reading stored files (books, covers) and cover thumbnails,
 * which the app serves at `/library/` (`servedLibraryPath`; see `desktop/src/appProtocol.ts`
 * and `LibraryFilesPathHandler.kt`). Fetching them skips base64 and the bridge's single queue,
 * so a book opens and covers load several times faster. In the desktop app, a library in a
 * folder of the user's (`placed`) has its books served too, and moves them without copying.
 */
export class NativeStorage extends RpcStorage {
  constructor(
    api: ConstructorParameters<typeof RpcStorage>[0],
    private readonly fetchFile: typeof fetch = (input, init) => fetch(input, init),
    private readonly folder?: { api: MessageClient<LibraryFolderApi>['libraryFolder']; placed: boolean },
  ) {
    super(api);
    if (folder) {
      this.move = async (from, to) => void (await folder.api.moveFile({ from, to }));
      this.prune = async (path) => void (await folder.api.prune({ path }));
    }
  }

  move?: (from: string, to: string) => Promise<void>;
  prune?: (path: string) => Promise<void>;

  override async readBlob(path: string): Promise<Blob | undefined> {
    if (!servedLibraryPath(path, this.folder?.placed ?? false)) return super.readBlob(path);
    // Paths in a folder of the user's have spaces and the like.
    const response = await this.fetchFile(`/library/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Couldn't read ${path}: ${response.status} ${response.statusText}`);
    return response.blob();
  }
}
