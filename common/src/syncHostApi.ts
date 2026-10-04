import { post, type SimpleMeta } from 'estuary-rpc';

/**
 * Hosting sync (M6) in the desktop app: what its page asks the main process, which serves the
 * sync API on the local network, holds the pairings and passes each sync call on to the page
 * (where the library is). Desktop only: the Android app syncs with a hub rather than being one.
 */

export interface PairedPeer {
  origin: string;
  name: string;
  pairedAt: string;
  lastSyncedAt?: string;
}

export interface SyncHostStatus {
  enabled: boolean;
  /** This computer's name, which peers show. */
  name: string;
  /** Where peers can reach the sync API, e.g. `http://192.168.0.11:47811`; empty when off or with no network. */
  addresses: string[];
  peers: PairedPeer[];
  /** Why it isn't listening, if it should be (the port is taken, say). */
  error?: string;
}

export interface PairingCode {
  /** Typed in on the other device, or read from the QR code: e.g. `K3Q9-TX2M`. */
  code: string;
  expiresAt: string;
}

export const syncHostApiMeta = {
  syncHost: {
    status: post<null, SyncHostStatus, SimpleMeta>('api/syncHost/status'),
    setEnabled: post<{ enabled: boolean }, SyncHostStatus, SimpleMeta>('api/syncHost/setEnabled'),
    /** A new one-time code, replacing any earlier one. */
    newCode: post<null, PairingCode, SimpleMeta>('api/syncHost/newCode'),
    unpair: post<{ origin: string }, SyncHostStatus, SimpleMeta>('api/syncHost/unpair'),
  },
};

export type SyncHostApi = typeof syncHostApiMeta;
