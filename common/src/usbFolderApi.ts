import { get, post, type SimpleMeta } from 'estuary-rpc';
import { storageEndpoints, type PathRequest } from './storageApi';

/**
 * The Android app's sync folder (see `folderHub.ts`): a folder in shared storage the user picks
 * once (say `Documents/nexlibris-sync`), which a computer sees when the phone is plugged in by
 * USB. The app reaches it through the system's storage provider, so it can use files a computer
 * copied in. The iOS app's is a folder picked in Files that a computer also reaches (on a drive, or
 * in iCloud Drive), as iOS shows no folders over USB. Android and iOS only: the page reaches the folder as `Storage` (the same endpoints as the
 * library's, under `api/usbFolder`), lists and removes in it, and has the app copy stored files
 * between it and the library.
 */

export interface HashRequest {
  hash: string;
}

export const usbFolderApiMeta = {
  usbFolder: {
    ...storageEndpoints('api/usbFolder'),
    /** Where the folder is, as a computer browsing the phone sees it (e.g. `Documents/nexlibris-sync`); null before one is chosen. */
    info: get<null, { path: string | null }, SimpleMeta>('api/usbFolder/info'),
    /** Shows the system's folder picker, and keeps the folder chosen; refused if none was. */
    choose: post<null, { path: string }, SimpleMeta>('api/usbFolder/choose'),
    /** The names in a folder; none if it doesn't exist. */
    list: get<PathRequest, string[], SimpleMeta>('api/usbFolder/list'),
    /** Copies a stored file from the library into the folder; refused unless it hashes to `hash`. */
    toFolder: post<HashRequest, null, SimpleMeta>('api/usbFolder/toFolder'),
    /** Copies a stored file from the folder into the library; refused unless it hashes to `hash`. */
    fromFolder: post<HashRequest, null, SimpleMeta>('api/usbFolder/fromFolder'),
  },
};

export type UsbFolderApi = typeof usbFolderApiMeta;
