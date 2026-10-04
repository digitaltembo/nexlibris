import { hashBlob, StoredLibraryBackend } from './backend';
import { storedFilePath } from './importApi';
import { createMessageClient, createMessageHandler, type MessageImpl } from './rpc';
import type { Storage } from './storage';
import { createSyncService, type SyncClient } from './sync';
import { syncApiMeta, type SyncApi } from './syncApi';
import { referencedFiles, type HubFiles } from './syncFiles';
import type { FileHash, Item, Library } from './types';
import type { LibraryBackend } from './backend';

/**
 * Sync (M6) through a shared folder, such as a phone's folder on a computer it's plugged into by
 * USB: the folder holds a library of its own that each device syncs with in turn, as with a hub.
 * The phone syncs with it, then the computer (with the phone mounted), then the phone again to
 * take what the computer sent; nothing needs to be running on the other side.
 *
 * Books' files only pass through: each device leaves a record in `peers/` of the files it holds
 * and which it keeps (its `keepFiles` search), so the next one sends just what the others need
 * and lack, and once they have it, it's removed from the folder. A device with no other record
 * there yet sends all its files, for whichever comes next.
 */

/** A folder's storage, with what a folder hub needs beyond `Storage`: listing and removing. */
export interface FolderStorage extends Storage {
  /** The names in a folder (files and folders); none if it doesn't exist. */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

/** Copies between the folder and the local library, where that's faster than reading and writing through the page (Android). */
export interface FolderCopy {
  toFolder(hash: FileHash): Promise<void>;
  fromFolder(hash: FileHash): Promise<void>;
}

/** A device's record in the folder, as of its last sync there. */
export interface FolderPeer {
  origin: string;
  name: string;
  syncedAt: string;
  /** The files it holds. */
  has: FileHash[];
  /** Which books' files it keeps, as a search; all when unset. */
  keepFiles?: string;
}

/** The device syncing with the folder. */
export interface FolderSelf {
  origin: string;
  name: string;
  /** Written for devices whose library has no connection for it yet (see `KeepRule`). */
  keepFiles?: string;
}

/**
 * Which items' files a device keeps: by its connection in the library where there is one, else by
 * the `keepFiles` search it recorded; all of them when it returns undefined. The client's to say,
 * as both are in the search box's syntax.
 */
export type KeepRule = (peer: { origin: string; keepFiles?: string }, library: Library) => ((item: Item) => boolean) | undefined;

const PEERS = 'peers';
const peerPath = (origin: string) => {
  if (!/^[A-Za-z0-9-]+$/.test(origin)) throw new Error(`Bad instance id: ${origin}`);
  return `${PEERS}/${origin}.json`;
};

export function openFolderHub(storage: FolderStorage, options: { name: string; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const backend = new StoredLibraryBackend(storage, 'Sync folder');
  const service = createSyncService(backend, { name: () => options.name });

  async function readPeers(): Promise<FolderPeer[]> {
    const peers: FolderPeer[] = [];
    for (const name of await storage.list(PEERS)) {
      if (!name.endsWith('.json')) continue;
      try {
        const peer = JSON.parse((await storage.readText(`${PEERS}/${name}`)) ?? '') as FolderPeer;
        if (peer?.origin && Array.isArray(peer.has)) peers.push(peer);
      } catch {
        // A record cut short (the folder was unplugged mid-write, say) counts as none.
      }
    }
    return peers;
  }

  async function writePeer(peer: FolderPeer) {
    await storage.writeText(peerPath(peer.origin), JSON.stringify(peer));
  }

  const impl: MessageImpl<SyncApi> = {
    sync: {
      ...service,
      // Whoever can reach the folder may sync with it: there's no key to hand out.
      pair: async () => ({ key: 'folder', hub: await service.hello(null) }),
      done: async ({ origin, at }) => {
        const existing = (await readPeers()).find((peer) => peer.origin === origin);
        if (existing) await writePeer({ ...existing, syncedAt: at });
        return null;
      },
      missing: async ({ hashes }) => {
        const lacking: FileHash[] = [];
        for (const hash of hashes) if (!(await backend.hasFile(hash))) lacking.push(hash);
        return lacking;
      },
    },
  };
  const handle = createMessageHandler(syncApiMeta, impl);
  const client: SyncClient = createMessageClient(syncApiMeta, async (request) => {
    const response = await handle({ id: 0, ...request });
    if (!response.ok) throw new Error(response.message);
    return response.value;
  }).sync;

  /** The files other devices keep and don't have yet, as of their last sync here. */
  async function neededByOthers(self: FolderSelf, keepRule: KeepRule): Promise<Set<FileHash> | undefined> {
    const others = (await readPeers()).filter((peer) => peer.origin !== self.origin);
    if (others.length === 0) return undefined;
    const library = await backend.getLibrary();
    const { covers, books } = referencedFiles(library);
    const needed = new Set<FileHash>();
    for (const peer of others) {
      const has = new Set(peer.has);
      const keep = keepRule(peer, library) ?? (() => true);
      for (const hash of covers) if (!has.has(hash)) needed.add(hash);
      for (const [hash, items] of books) if (!has.has(hash) && items.some(keep)) needed.add(hash);
    }
    return needed;
  }

  /** Every stored file in the folder. */
  async function storedFiles(): Promise<FileHash[]> {
    const hashes: FileHash[] = [];
    for (const dir of await storage.list('files')) for (const name of await storage.list(`files/${dir}`)) if (/^[0-9a-f]{64}$/.test(name)) hashes.push(name);
    return hashes;
  }

  return {
    client,
    /** The folder's library, e.g. for tests. */
    backend,
    /** Its files, as the device `self` (with `local` as its library) moves them. */
    files(local: LibraryBackend, self: FolderSelf, keepRule: KeepRule, copy?: FolderCopy): HubFiles {
      return {
        missing: (hashes) => impl.sync.missing({ hashes }),
        async wanted(hashes) {
          const needed = await neededByOthers(self, keepRule);
          const lacking = new Set(await impl.sync.missing({ hashes }));
          return hashes.filter((hash) => lacking.has(hash) && (!needed || needed.has(hash)));
        },
        async download(hash) {
          if (copy) return copy.fromFolder(hash);
          const blob = await backend.getFile(hash);
          if (!blob) throw new Error('That file isn’t in the folder.');
          if ((await local.putFile(blob)).hash !== hash) throw new Error('The file in the folder doesn’t match its hash.');
        },
        async upload(hash) {
          if (copy) return copy.toFolder(hash);
          const blob = await local.getFile(hash);
          if (!blob) throw new Error('That file isn’t stored here.');
          if ((await hashBlob(blob)) !== hash) throw new Error('The file stored here doesn’t match its hash.');
          await backend.putFile(blob);
        },
        async finish(held) {
          await writePeer({
            origin: self.origin,
            name: self.name,
            syncedAt: now().toISOString(),
            has: held,
            ...(self.keepFiles?.trim() && { keepFiles: self.keepFiles }),
          });
          // What no other device needs any more (or ever did) leaves the folder; with no others yet, everything stays for them.
          const needed = await neededByOthers(self, keepRule);
          if (!needed) return;
          for (const hash of await storedFiles()) if (!needed.has(hash)) await storage.remove(storedFilePath(hash));
        },
      };
    },
  };
}

export type FolderHub = ReturnType<typeof openFolderHub>;
