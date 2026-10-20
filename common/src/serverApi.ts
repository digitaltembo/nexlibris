import { get, post, put, TransportType, type SimpleMeta } from 'estuary-rpc';
import type { Change, Operation } from './operations';
import type { FileHash, Library } from './types';

/**
 * M4's server, as the web client sees it: accounts, and each account's library in the cloud. The
 * server serves the web app too, so these are called on the page's own origin, signed in by a
 * session cookie the server sets (HttpOnly, so the page never sees it). Signed out, the page works
 * as it does anywhere, with the library in the browser.
 *
 * The server serves it with estuary-rpc-server, and clients call it with estuary-rpc-client
 * (`rest.ts`): reads are GETs with the request in the query, changes POSTs of JSON; a reply is the
 * response as JSON (204 for none), and an error a status with `{ status: 'error', message }`. A
 * call that needs the session (its `authentication`) answers 401 when signed out. Files stream as
 * they are, by estuary-rpc's raw transport: a book's at `api/library/files/<hash>` (a PUT is
 * refused unless the bytes hash to `<hash>`), the library's local files at `api/library/local`.
 *
 * The desktop and Android apps reach a server at an address the user gives (self-hosting): they
 * sign in asking for the session's token (`Credentials.token`) and send it as a bearer token where
 * the page would send the cookie; the API answers other origins (CORS) for them.
 *
 * The server serves the sync API (`syncApi.ts`) for each account too, at `api/sync/…`: a signed-in
 * page pairs with it without a code (`pair` takes the session instead), so a library kept in the
 * browser can keep a copy in the account and sync with it as it does with other instances.
 */

export interface Account {
  id: string;
  /** What the user signs in with. */
  name: string;
}

export interface SessionInfo {
  /** Who's signed in; none when signed out. */
  account?: Account;
  /** For an app that signed in asking for it (`Credentials.token`): its session token, sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Whether someone signed out may make an account here. */
  signup: boolean;
  /** What the server calls itself, e.g. as the hub of a pairing. */
  name: string;
}

export interface Credentials {
  name: string;
  password: string;
  /**
   * Set by the desktop and Android apps, whose pages aren't on the server's origin, so a cookie
   * wouldn't reach it: the session's token comes back in the reply instead of a cookie.
   */
  token?: boolean;
}

export interface CloudLibraryStatus {
  /** Whether the account has a library with anything in it. */
  exists: boolean;
  items: number;
  /** The books' files kept, and their size in bytes. */
  files: number;
  bytes: number;
}

export interface ImportRequest {
  /** The library as stored (any schema; it's migrated when opened). */
  library: Library;
  /** Its change log, oldest first. */
  changes: Change[];
}

/** The session cookie the server sets (HttpOnly; the page never reads it). */
export const SESSION_COOKIE = 'nexlibris_session';

/** Endpoints only for someone signed in: the server checks the session cookie before calling them. */
const signedIn = { authentication: { type: 'cookie' as const, keyPair: [SESSION_COOKIE] as [string] } };
/** Reads: a GET, with the request's fields in the query. */
const query = { transport: { transportType: TransportType.URL_FORM_DATA as const } };
/**
 * Files, streamed: the request is the query and the URL's path parameters; the body (a PUT's) is the
 * file's bytes, and the reply a GET's. The client gets the `Response`; the server's endpoint writes
 * its reply itself (returning nothing).
 */
const raw = { transport: { transportType: TransportType.RAW as const } };

/** A raw endpoint's reply: the `Response` on the client; nothing on the server, whose endpoint answers itself. */
export type RawReply = Response | void;

export const serverApiMeta = {
  auth: {
    session: get<null, SessionInfo, SimpleMeta>('api/auth/session', query),
    signIn: post<Credentials, SessionInfo, SimpleMeta>('api/auth/sign-in'),
    /** Makes an account and signs in, where the server allows it (`SessionInfo.signup`). */
    signUp: post<Credentials, SessionInfo, SimpleMeta>('api/auth/sign-up'),
    signOut: post<null, SessionInfo, SimpleMeta>('api/auth/sign-out'),
    changePassword: post<{ password: string; newPassword: string }, null, SimpleMeta>('api/auth/password', signedIn),
  },
  /** The signed-in account's library: a `LibraryBackend`'s calls (`serverBackend.ts`), and moving a library in and out. */
  library: {
    status: get<null, CloudLibraryStatus, SimpleMeta>('api/library/status', { ...signedIn, ...query }),
    /** The library, or null if it's still at `revision` (the one the caller has). */
    get: get<{ revision?: number }, Library | null, SimpleMeta>('api/library/get', { ...signedIn, ...query }),
    apply: post<{ ops: Operation[]; expectRevision?: number }, Library, SimpleMeta>('api/library/apply', signedIn),
    changes: get<{ since: number }, Change[], SimpleMeta>('api/library/changes', { ...signedIn, ...query }),
    hasFile: get<{ hash: FileHash }, boolean, SimpleMeta>('api/library/hasFile', { ...signedIn, ...query }),
    deleteFile: post<{ hash: FileHash }, null, SimpleMeta>('api/library/deleteFile', signedIn),
    /** Which of these files the account lacks, so moving a library there sends only those. */
    missing: post<{ hashes: FileHash[] }, FileHash[], SimpleMeta>('api/library/missing', signedIn),
    readLocalState: get<{ key: string }, unknown, SimpleMeta>('api/library/readLocalState', { ...signedIn, ...query }),
    writeLocalState: post<{ key: string; value: unknown }, null, SimpleMeta>('api/library/writeLocalState', signedIn),
    deleteLocalFile: post<{ path: string }, null, SimpleMeta>('api/library/deleteLocalFile', signedIn),
    /** Puts a library moved from elsewhere in the account, after its files; refused if the account has one already. */
    import: post<ImportRequest, null, SimpleMeta>('api/library/import', signedIn),
    /** Deletes the account's library and its files, once it's been moved out. */
    remove: post<null, null, SimpleMeta>('api/library/remove', signedIn),
    /** A book's file (404 if it isn't stored), served as untrusted bytes. */
    file: get<{ hash: FileHash }, RawReply, SimpleMeta>('api/library/files/:hash', { ...signedIn, ...raw }),
    /** Stores a book's file, the body, refused unless it hashes to `hash`. */
    putFile: put<{ hash: FileHash }, RawReply, SimpleMeta>('api/library/files/:hash', { ...signedIn, ...raw }),
    /** One of the library's local files (`LibraryBackend.readLocalFile`; 404 if there's none). */
    localFile: get<{ path: string }, RawReply, SimpleMeta>('api/library/local', { ...signedIn, ...raw }),
    putLocalFile: put<{ path: string }, RawReply, SimpleMeta>('api/library/local', { ...signedIn, ...raw }),
  },
};

export type ServerApi = typeof serverApiMeta;
