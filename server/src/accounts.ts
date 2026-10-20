import type { Account } from '@nexlibris/common';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { jsonFile } from './jsonFile';

/**
 * Accounts and sessions, kept in the data folder (`accounts.json`, `sessions.json`). Passwords
 * are kept as scrypt hashes, and sessions as SHA-256 hashes of their tokens, so neither file holds
 * anything that signs anyone in. A session lasts 30 days from when it was last used.
 */

export type SignupPolicy = 'open' | 'first' | 'closed';

interface StoredAccount extends Account {
  /** `scrypt$<N>$<r>$<p>$<salt>$<hash>`, base64url. */
  password: string;
  createdAt: string;
}

interface StoredSession {
  tokenHash: string;
  accountId: string;
  createdAt: string;
  lastSeenAt: string;
}

export const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;
/** Failed sign-ins allowed per name (and per address) in a window, before more are refused until it passes. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 32, { ...params, maxmem: 128 * params.N * params.r * 2 }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await deriveKey(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** An account's name as typed, tidied, or why it can't be one. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Enter a name.');
  const tidy = name.normalize('NFKC').trim();
  if (!tidy) throw new Error('Enter a name.');
  if (tidy.length > 64) throw new Error('That name is too long: up to 64 characters.');
  if (/[\p{C}]/u.test(tidy)) throw new Error('That name has characters that can’t be typed.');
  return tidy;
}

export function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) throw new Error('That password is too long.');
  return password;
}

export class SignInError extends Error {
  constructor(message = 'That name and password don’t match an account.') {
    super(message);
    this.name = 'SignInError';
  }
}

export function createAccounts(dataDir: string, options: { signup: SignupPolicy; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const accounts = jsonFile<{ accounts: StoredAccount[] }>(join(dataDir, 'accounts.json'), () => ({ accounts: [] }));
  const sessions = jsonFile<{ sessions: StoredSession[] }>(join(dataDir, 'sessions.json'), () => ({ sessions: [] }));
  const failures = new Map<string, number[]>();

  const public_ = ({ id, name }: StoredAccount): Account => ({ id, name });
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
  const live = (session: StoredSession) => now().getTime() - Date.parse(session.lastSeenAt) < SESSION_DAYS * DAY_MS;

  /** Too many recent failures for any of these (a name, an address). */
  function limited(keys: string[]): boolean {
    const since = now().getTime() - FAILURE_WINDOW_MS;
    return keys.some((key) => (failures.get(key) ?? []).filter((t) => t > since).length >= MAX_FAILURES);
  }
  function failed(keys: string[]) {
    const since = now().getTime() - FAILURE_WINDOW_MS;
    for (const key of keys) failures.set(key, [...(failures.get(key) ?? []).filter((t) => t > since), now().getTime()]);
  }

  async function startSession(accountId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const at = now().toISOString();
    await sessions.update((s) => {
      s.sessions = s.sessions.filter(live);
      s.sessions.push({ tokenHash: sha256(token), accountId, createdAt: at, lastSeenAt: at });
    });
    return token;
  }

  return {
    async canSignUp(): Promise<boolean> {
      if (options.signup === 'open') return true;
      if (options.signup === 'closed') return false;
      return (await accounts.read()).accounts.length === 0;
    },

    async list(): Promise<Account[]> {
      return (await accounts.read()).accounts.map(public_);
    },

    /** Makes an account. `force` makes it whatever the sign-up policy (an administrator, from the command line). */
    async create(name: unknown, password: unknown, force = false): Promise<Account> {
      const tidy = checkName(name);
      const hash = await hashPassword(checkPassword(password));
      return accounts.update(async (a) => {
        // Checked again here, so two sign-ups at once can't both be the first.
        if (!force && !(options.signup === 'open' || (options.signup === 'first' && a.accounts.length === 0))) {
          throw new Error('This server doesn’t take new accounts.');
        }
        if (a.accounts.some((account) => same(account.name, tidy))) throw new Error('There’s an account with that name already.');
        const account: StoredAccount = { id: randomUUID(), name: tidy, password: hash, createdAt: now().toISOString() };
        a.accounts.push(account);
        return public_(account);
      });
    },

    /** Checks a name and password, returning the account and a new session's token. */
    async signIn(name: unknown, password: unknown, from = ''): Promise<{ account: Account; token: string }> {
      const tidy = typeof name === 'string' ? name.normalize('NFKC').trim() : '';
      const keys = [`name:${tidy.toLowerCase()}`, ...(from ? [`from:${from}`] : [])];
      if (limited(keys)) throw new SignInError('Too many tries. Wait a few minutes, then try again.');
      const account = (await accounts.read()).accounts.find((a) => same(a.name, tidy));
      // A made-up hash when there's no such account, so the reply takes as long either way.
      const ok = await verifyPassword(typeof password === 'string' ? password : '', account?.password ?? (await dummyHash()));
      if (!account || !ok) {
        failed(keys);
        throw new SignInError();
      }
      return { account: public_(account), token: await startSession(account.id) };
    },

    startSession,

    /** The account a session token belongs to, if it's still live; using it keeps it live. */
    async session(token: string | undefined): Promise<Account | undefined> {
      if (!token) return undefined;
      const hash = sha256(token);
      const session = (await sessions.read()).sessions.find((s) => s.tokenHash === hash);
      if (!session || !live(session)) return undefined;
      const account = (await accounts.read()).accounts.find((a) => a.id === session.accountId);
      if (!account) return undefined;
      // Saved at most hourly: it only needs to be roughly right.
      if (now().getTime() - Date.parse(session.lastSeenAt) > 60 * 60_000) {
        await sessions.update(() => void (session.lastSeenAt = now().toISOString()));
      }
      return public_(account);
    },

    async endSession(token: string | undefined): Promise<void> {
      if (!token) return;
      const hash = sha256(token);
      await sessions.update((s) => void (s.sessions = s.sessions.filter((session) => session.tokenHash !== hash)));
    },

    /** Changes an account's password, ending its other sessions. `current` is checked unless it's undefined (an administrator's reset). */
    async setPassword(accountId: string, current: string | undefined, password: unknown, keepToken?: string): Promise<void> {
      const next = await hashPassword(checkPassword(password));
      const account = (await accounts.read()).accounts.find((a) => a.id === accountId);
      if (!account) throw new Error('No such account.');
      if (current !== undefined && !(await verifyPassword(current, account.password))) throw new SignInError('That isn’t your current password.');
      await accounts.update(() => void (account.password = next));
      const kept = keepToken && sha256(keepToken);
      await sessions.update((s) => void (s.sessions = s.sessions.filter((session) => session.accountId !== accountId || session.tokenHash === kept)));
    },

    async find(name: string): Promise<Account | undefined> {
      const account = (await accounts.read()).accounts.find((a) => same(a.name, name.trim()));
      return account && public_(account);
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
