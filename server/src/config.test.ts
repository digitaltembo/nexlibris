import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const keys = { NEXLIBRIS_ACCESS_KEY_ID: 'id', NEXLIBRIS_SECRET_ACCESS_KEY: 'secret' };

describe('parseConfig', () => {
  it('keeps files in the data folder by default', () => {
    const config = parseConfig([], {}, { clientDir: '/srv/client' });
    expect(config).toMatchObject({ command: 'serve', port: 8080, host: '0.0.0.0', signup: 'first', secureCookies: 'auto', trustProxy: false });
    expect(config.clientDir).toBe('/srv/client');
    expect(config.storage).toEqual({ kind: 'fs', dir: `${config.dataDir}/files` });
  });

  it('takes options from the command line before the environment', () => {
    const config = parseConfig(['--port', '9000', '--signup', 'open'], { PORT: '7000', NEXLIBRIS_SIGNUP: 'closed', NEXLIBRIS_TRUST_PROXY: '1' });
    expect(config).toMatchObject({ port: 9000, signup: 'open', trustProxy: true });
  });

  it('sets up each kind of bucket', () => {
    expect(parseConfig(['--storage', 's3', '--bucket', 'b', '--region', 'eu-west-2'], keys).storage).toMatchObject({
      kind: 's3',
      endpoint: 'https://s3.eu-west-2.amazonaws.com',
      region: 'eu-west-2',
      pathStyle: false,
    });
    expect(parseConfig(['--storage', 'gcs', '--bucket', 'b'], keys).storage).toMatchObject({ endpoint: 'https://storage.googleapis.com', region: 'auto' });
    expect(parseConfig(['--storage', 'b2', '--bucket', 'b', '--region', 'us-west-004'], keys).storage).toMatchObject({
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
    });
    expect(parseConfig(['--storage', 's3', '--bucket', 'b', '--endpoint', 'http://minio:9000'], keys).storage).toMatchObject({
      endpoint: 'http://minio:9000',
      pathStyle: true,
    });
    expect(parseConfig(['--storage', 'aws', '--bucket', 'b'], { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' }).storage).toMatchObject({
      accessKeyId: 'a',
      sessionToken: 't',
    });
  });

  it('takes empty variables as unset, as Docker Compose passes them', () => {
    const env = { NEXLIBRIS_PORT: '', PORT: '7000', NEXLIBRIS_REGION: '', AWS_REGION: 'eu-west-2', NEXLIBRIS_ACCESS_KEY_ID: '', NEXLIBRIS_SECRET_ACCESS_KEY: '' };
    const config = parseConfig(['--storage', 's3', '--bucket', 'b'], { ...env, AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' });
    expect(config.port).toBe(7000);
    expect(config.storage).toMatchObject({ region: 'eu-west-2', accessKeyId: 'a' });
    expect(parseConfig([], { NEXLIBRIS_PREFIX: '', NEXLIBRIS_STORAGE: '' }).storage.kind).toBe('fs');
  });

  it('says what’s missing', () => {
    expect(() => parseConfig(['--storage', 's3'], keys)).toThrow('--bucket');
    expect(() => parseConfig(['--storage', 's3', '--bucket', 'b'], {})).toThrow('credentials');
    expect(() => parseConfig(['--storage', 'b2', '--bucket', 'b'], keys)).toThrow('--region');
    expect(() => parseConfig(['--storage', 'ftp'], {})).toThrow('fs, s3, gcs or b2');
    expect(() => parseConfig(['--signup', 'maybe'], {})).toThrow('open, first or closed');
    expect(() => parseConfig(['--tls-cert', 'c.pem'], {})).toThrow('both');
    expect(() => parseConfig(['add-account'], {})).toThrow('name');
    expect(parseConfig(['add-account', 'ada'], {})).toMatchObject({ command: 'add-account', account: 'ada' });
  });
});
