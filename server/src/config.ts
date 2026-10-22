import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SignupPolicy } from './accounts';
import type { AppOptions } from './app';
import { folderStore, type ObjectStore } from './objectStore';
import { bucketStore, providerDefaults, type Provider } from './s3';

/**
 * The server's options, from the command line, else the environment, else defaults. Secrets
 * (bucket credentials) come only from the environment, so they don't show in process lists.
 */

export const USAGE = `nexlibris server

Usage:
  nexlibris-server [serve] [options]      run the server
  nexlibris-server add-account <name>     make an account (password from NEXLIBRIS_PASSWORD, else asked for)
  nexlibris-server set-password <name>    change an account's password, signing it out everywhere
  nexlibris-server accounts               list the accounts

Options (environment variable in brackets):
  --port <n>             port to listen on (PORT, NEXLIBRIS_PORT; default 8080)
  --host <address>       address to listen on (NEXLIBRIS_HOST; default 0.0.0.0)
  --data <dir>           accounts, sessions and libraries' details (NEXLIBRIS_DATA; default ./data)
  --client <dir>         the built web app to serve (NEXLIBRIS_CLIENT; default client/dist beside the server)
  --name <text>          what the server calls itself to paired devices (NEXLIBRIS_NAME; default "nexlibris cloud")
  --signup <policy>      who may make an account from the web: open, first (only the first account), or
                         closed (NEXLIBRIS_SIGNUP; default first)

  --storage <kind>       where books' files go (NEXLIBRIS_STORAGE; default fs):
                           fs    a folder on this machine (--files)
                           s3    Amazon S3, or any S3-compatible service with --endpoint (MinIO, R2, …)
                           gcs   Google Cloud Storage, through its S3-compatible API with HMAC keys
                           b2    Backblaze B2, through its S3-compatible API (needs --region)
  --files <dir>          for fs: the folder (NEXLIBRIS_FILES; default <data>/files)
  --bucket <name>        for s3, gcs, b2: the bucket, which should be private (NEXLIBRIS_BUCKET)
  --region <region>      the bucket's region (NEXLIBRIS_REGION, AWS_REGION)
  --endpoint <url>       the service's address, for other S3-compatible services (NEXLIBRIS_ENDPOINT)
  --path-style           address objects as <endpoint>/<bucket>/<key> (NEXLIBRIS_PATH_STYLE=1; default
                         with --endpoint)
  --prefix <text>        before every object's key, to share a bucket (NEXLIBRIS_PREFIX)
                         Credentials: NEXLIBRIS_ACCESS_KEY_ID and NEXLIBRIS_SECRET_ACCESS_KEY, else
                         AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN.

  --tls-cert <file>      serve https with this certificate (NEXLIBRIS_TLS_CERT)
  --tls-key <file>       and this key (NEXLIBRIS_TLS_KEY)
  --trust-proxy          behind a reverse proxy: believe its X-Forwarded-* headers (NEXLIBRIS_TRUST_PROXY=1)
  --secure-cookies <x>   auto (when served over https), always or never (NEXLIBRIS_SECURE_COOKIES)
  --help                 show this
`;

export interface ServerConfig extends Omit<AppOptions, 'files' | 'now'> {
  command: 'serve' | 'add-account' | 'set-password' | 'accounts' | 'help';
  /** The account a command names. */
  account?: string;
  port: number;
  host: string;
  storage: StorageConfig;
  tls?: { cert: string; key: string };
}

export type StorageConfig =
  | { kind: 'fs'; dir: string }
  | {
      kind: Provider;
      bucket: string;
      region: string;
      endpoint: string;
      pathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };

const COMMANDS = ['serve', 'add-account', 'set-password', 'accounts', 'help'] as const;

export function parseConfig(argv: string[], env: Record<string, string | undefined>, defaults: { clientDir?: string } = {}): ServerConfig {
  // An empty variable is unset, as Docker Compose passes one it was given none for.
  env = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      client: { type: 'string' },
      name: { type: 'string' },
      signup: { type: 'string' },
      storage: { type: 'string' },
      files: { type: 'string' },
      bucket: { type: 'string' },
      region: { type: 'string' },
      endpoint: { type: 'string' },
      'path-style': { type: 'boolean' },
      prefix: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'trust-proxy': { type: 'boolean' },
      'secure-cookies': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const flag = (value: string | undefined) => value === '1' || value === 'true' || value === 'yes';
  const command = values.help ? 'help' : ((positionals[0] ?? 'serve') as ServerConfig['command']);
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}. Try --help.`);
  if ((command === 'add-account' || command === 'set-password') && !positionals[1]) throw new Error(`${command} needs the account’s name.`);

  const port = Number(values.port ?? env.NEXLIBRIS_PORT ?? env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Bad port: ${values.port ?? env.NEXLIBRIS_PORT ?? env.PORT}`);
  const dataDir = resolve(values.data ?? env.NEXLIBRIS_DATA ?? 'data');
  const signup = (values.signup ?? env.NEXLIBRIS_SIGNUP ?? 'first') as SignupPolicy;
  if (!['open', 'first', 'closed'].includes(signup)) throw new Error(`--signup is open, first or closed, not ${signup}.`);
  const cookies = values['secure-cookies'] ?? env.NEXLIBRIS_SECURE_COOKIES ?? 'auto';
  if (!['auto', 'always', 'never'].includes(cookies)) throw new Error(`--secure-cookies is auto, always or never, not ${cookies}.`);
  const cert = values['tls-cert'] ?? env.NEXLIBRIS_TLS_CERT;
  const key = values['tls-key'] ?? env.NEXLIBRIS_TLS_KEY;
  if (!!cert !== !!key) throw new Error('https needs both --tls-cert and --tls-key.');
  const clientDir = values.client ?? env.NEXLIBRIS_CLIENT ?? defaults.clientDir;
  const prefix = values.prefix ?? env.NEXLIBRIS_PREFIX;

  return {
    command,
    ...(positionals[1] && { account: positionals[1] }),
    port,
    host: values.host ?? env.NEXLIBRIS_HOST ?? '0.0.0.0',
    dataDir,
    ...(clientDir && { clientDir: resolve(clientDir) }),
    name: values.name ?? env.NEXLIBRIS_NAME ?? 'nexlibris cloud',
    signup,
    secureCookies: cookies === 'auto' ? 'auto' : cookies === 'always',
    trustProxy: values['trust-proxy'] ?? flag(env.NEXLIBRIS_TRUST_PROXY),
    ...(prefix && { prefix: prefix.endsWith('/') ? prefix : `${prefix}/` }),
    ...(cert && key && { tls: { cert: resolve(cert), key: resolve(key) } }),
    storage: storageConfig(values, env, dataDir),
  };
}

function storageConfig(
  values: { storage?: string; files?: string; bucket?: string; region?: string; endpoint?: string; 'path-style'?: boolean },
  env: Record<string, string | undefined>,
  dataDir: string,
): StorageConfig {
  const kind = (values.storage ?? env.NEXLIBRIS_STORAGE ?? 'fs').toLowerCase();
  if (kind === 'fs' || kind === 'local') return { kind: 'fs', dir: resolve(values.files ?? env.NEXLIBRIS_FILES ?? resolve(dataDir, 'files')) };
  const provider = (kind === 'aws' ? 's3' : kind) as Provider;
  if (!['s3', 'gcs', 'b2'].includes(provider)) throw new Error(`--storage is fs, s3, gcs or b2, not ${kind}.`);
  const bucket = values.bucket ?? env.NEXLIBRIS_BUCKET;
  if (!bucket) throw new Error(`--storage ${kind} needs --bucket.`);
  const accessKeyId = env.NEXLIBRIS_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.NEXLIBRIS_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`--storage ${kind} needs credentials: set NEXLIBRIS_ACCESS_KEY_ID and NEXLIBRIS_SECRET_ACCESS_KEY.`);
  }
  const region = values.region ?? env.NEXLIBRIS_REGION ?? env.AWS_REGION;
  const endpoint = values.endpoint ?? env.NEXLIBRIS_ENDPOINT;
  const defaults = endpoint ? { endpoint, region: region ?? (provider === 'gcs' ? 'auto' : 'us-east-1'), pathStyle: true } : providerDefaults(provider, region);
  const pathStyle = values['path-style'] ?? (env.NEXLIBRIS_PATH_STYLE !== undefined ? ['1', 'true', 'yes'].includes(env.NEXLIBRIS_PATH_STYLE) : defaults.pathStyle);
  const sessionToken = env.NEXLIBRIS_ACCESS_KEY_ID ? undefined : env.AWS_SESSION_TOKEN;
  return { kind: provider, bucket, ...defaults, pathStyle, accessKeyId, secretAccessKey, ...(sessionToken && { sessionToken }) };
}

export function objectStoreFor(storage: StorageConfig, fetchImpl: typeof fetch = fetch): ObjectStore {
  if (storage.kind === 'fs') return folderStore(storage.dir);
  const { kind: _, ...options } = storage;
  return bucketStore(options, fetchImpl);
}
