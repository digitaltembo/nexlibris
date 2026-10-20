import type { Account } from '@nexlibris/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { jsonFile } from './jsonFile';

/**
 * Instances paired with an account's library, as with the desktop app's hub (`desktop/src/syncHost.ts`):
 * each has a long-lived key, kept here as a SHA-256 hash in `<data>/pairings.json`, that it sends with
 * every sync call. A page signed in to the account pairs without a code; the session vouches for it.
 */

export interface StoredPairing {
  accountId: string;
  /** The paired instance's `Library.origin`. */
  origin: string;
  name: string;
  pairedAt: string;
  lastSyncedAt?: string;
  keyHash: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function createPairings(dataDir: string, now: () => Date = () => new Date()) {
  const file = jsonFile<{ pairings: StoredPairing[] }>(join(dataDir, 'pairings.json'), () => ({ pairings: [] }));
  return {
    /** Pairs an instance with the account (again, if it was), returning its new key. */
    async pair(account: Account, peer: { origin: unknown; name: unknown }): Promise<string> {
      if (typeof peer?.origin !== 'string' || typeof peer.name !== 'string' || !peer.origin) throw new Error('Bad pairing request.');
      const key = randomBytes(32).toString('base64url');
      await file.update((p) => {
        p.pairings = p.pairings.filter((pairing) => !(pairing.accountId === account.id && pairing.origin === peer.origin));
        p.pairings.push({
          accountId: account.id,
          origin: peer.origin as string,
          name: (peer.name as string).slice(0, 100),
          pairedAt: now().toISOString(),
          keyHash: sha256(key),
        });
      });
      return key;
    },

    /** The pairing a key belongs to. */
    async byKey(key: string | undefined): Promise<StoredPairing | undefined> {
      if (!key) return undefined;
      const hash = Buffer.from(sha256(key), 'hex');
      return (await file.read()).pairings.find((p) => timingSafeEqual(Buffer.from(p.keyHash, 'hex'), hash));
    },

    async synced(pairing: StoredPairing): Promise<void> {
      await file.update(() => void (pairing.lastSyncedAt = now().toISOString()));
    },

    /** Forgets an account's pairings (its library was deleted, say). */
    async forget(accountId: string): Promise<void> {
      await file.update((p) => void (p.pairings = p.pairings.filter((pairing) => pairing.accountId !== accountId)));
    },
  };
}

export type Pairings = ReturnType<typeof createPairings>;
