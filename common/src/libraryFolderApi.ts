import { post, type SimpleMeta } from 'estuary-rpc';
import type { FileLayout } from './placedLibrary';
import type { FileHash } from './types';

/**
 * Where the desktop app keeps the library: its data folder (the default), or a folder the user
 * chose, with the books where the layout says (`placedLibrary.ts`). Moving the library between
 * them happens in the main process, which can move files without copying them; the page polls
 * `status` meanwhile. Desktop only: the browser does this itself, with folder handles.
 */

export interface LibraryLocation {
  /** The folder, as the system shows it. */
  path: string;
  /** Whether it's the app's own data folder. */
  isDefault: boolean;
  /** A folder of the user's, with a layout. */
  placed: boolean;
  /** Whether the data folder has a library, when this isn't it (one left there by opening another). */
  defaultHasLibrary: boolean;
}

export interface FolderChoice {
  path: string;
  /** What's there already: a nexlibris library (opened rather than moved into), other files, or nothing. */
  holds: 'library' | 'files' | 'nothing';
}

export interface MoveRequest {
  /** The folder to move to; the app's data folder if not given. */
  to?: string;
  /** Where books go there; not given for the data folder. */
  layout?: FileLayout;
  /** Each book file's path there, by hash, by the layout. */
  placed?: Record<FileHash, string>;
}

export interface MoveStatus {
  state: 'idle' | 'moving' | 'done' | 'failed';
  done: number;
  total: number;
  /** Why it failed; everything was put back. */
  message?: string;
}

export const libraryFolderApiMeta = {
  libraryFolder: {
    location: post<null, LibraryLocation, SimpleMeta>('api/libraryFolder/location'),
    /** Asks the user for a folder. */
    choose: post<null, FolderChoice | null, SimpleMeta>('api/libraryFolder/choose'),
    /** Starts moving the library (see `status`); once it's moved, the app opens it there and reloads the page. */
    move: post<MoveRequest, null, SimpleMeta>('api/libraryFolder/move'),
    status: post<null, MoveStatus, SimpleMeta>('api/libraryFolder/status'),
    /** Opens the library in another folder (the data folder if no path), leaving this one where it is, and reloads the page. */
    open: post<{ path?: string }, null, SimpleMeta>('api/libraryFolder/open'),
    /** `Storage.move` and `prune` in the library's folder. */
    moveFile: post<{ from: string; to: string }, null, SimpleMeta>('api/libraryFolder/moveFile'),
    prune: post<{ path: string }, null, SimpleMeta>('api/libraryFolder/prune'),
  },
};

export type LibraryFolderApi = typeof libraryFolderApiMeta;
