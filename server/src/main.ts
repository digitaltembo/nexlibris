import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createAccounts } from './accounts';
import { createApp } from './app';
import { objectStoreFor, parseConfig, USAGE, type ServerConfig } from './config';

/** The server's command line: runs it, or manages accounts (see `USAGE` in `config.ts`). */

const here = dirname(fileURLToPath(import.meta.url));
const builtClient = join(here, '..', '..', 'client', 'dist');

async function main() {
  let config: ServerConfig;
  try {
    config = parseConfig(process.argv.slice(2), process.env, existsSync(builtClient) ? { clientDir: builtClient } : {});
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
  if (config.command === 'help') return void process.stdout.write(USAGE);

  if (config.command !== 'serve') {
    const accounts = createAccounts(config.dataDir, { signup: config.signup });
    if (config.command === 'accounts') {
      for (const account of await accounts.list()) console.log(`${account.name}\t${account.id}`);
      return;
    }
    const password = process.env.NEXLIBRIS_PASSWORD ?? (await ask(`Password for ${config.account}: `));
    if (config.command === 'add-account') {
      const account = await accounts.create(config.account, password, true);
      return void console.log(`Made the account ${account.name}.`);
    }
    const account = await accounts.find(config.account!);
    if (!account) throw new Error(`There’s no account called ${config.account}.`);
    await accounts.setPassword(account.id, undefined, password);
    return void console.log(`Changed ${account.name}’s password, and signed it out everywhere.`);
  }

  const files = objectStoreFor(config.storage);
  // A bucket that can't be reached is better found now than at the first upload.
  await files.list(`${config.prefix ?? ''}accounts/.check/`).catch((e: unknown) => {
    throw new Error(`Can’t use ${files.description}: ${e instanceof Error ? e.message : e}`);
  });
  const { server } = createApp({
    ...config,
    files,
    ...(config.tls && { server: createHttpsServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }) }),
  });
  // Big books upload slowly on slow links; the default request timeout would cut them off.
  server.requestTimeout = 0;
  server.listen(config.port, config.host, () => {
    const scheme = config.tls ? 'https' : 'http';
    console.log(`nexlibris server at ${scheme}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  data in ${config.dataDir}; books’ files in ${files.description}`);
    console.log(config.clientDir ? `  serving the web app from ${config.clientDir}` : '  serving only the API (no web app: build the client, or pass --client)');
    if (config.signup !== 'closed') console.log(`  sign-up: ${config.signup === 'open' ? 'open to anyone' : 'the first account only'}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
