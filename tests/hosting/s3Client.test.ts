import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  S3_ENV,
  installObjectStoreTransport,
  privateBucket,
  publicBaseUrl,
  publicBucket,
  resetS3ClientForTests,
  s3Client,
} from '@/lib/blob/s3';
import { signedDownloadUrl } from '@/lib/blob/uploader';

// MOTIR-9925 — the client's two credential modes. On Tigris (and a self-hosted
// MinIO) it signs with a static key against a custom endpoint; on AWS neither is
// set and the SDK's default credential chain resolves the ECS task role. No
// network and no SDK mock: every assertion reads the constructed client's
// resolved config, or a presigned URL the SDK builds locally.

const KEYED = {
  [S3_ENV.endpoint]: 'https://fly.storage.tigris.dev',
  [S3_ENV.accessKeyId]: 'static-access-key',
  [S3_ENV.secretAccessKey]: 'static-secret-key',
};

// What the chain reads first on a machine with no profile: the AWS_* variables,
// standing in here for the container credentials a Fargate task is given.
const CHAIN = {
  AWS_ACCESS_KEY_ID: 'ASIACHAINKEY',
  AWS_SECRET_ACCESS_KEY: 'chain-secret',
  AWS_SESSION_TOKEN: 'chain-session-token',
};

const ALL = [
  ...Object.values(S3_ENV),
  ...Object.keys(CHAIN),
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
];

function setEnv(values: Record<string, string>) {
  for (const name of ALL) vi.stubEnv(name, '');
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

beforeEach(() => resetS3ClientForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  resetS3ClientForTests();
});

describe('s3Client with a static key and an endpoint (Tigris)', () => {
  it('signs with the key pair, path-style, in region auto', async () => {
    setEnv(KEYED);
    const client = s3Client();
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe('auto');
    const credentials = await client.config.credentials();
    expect(credentials).toMatchObject({
      accessKeyId: 'static-access-key',
      secretAccessKey: 'static-secret-key',
    });
    expect(credentials.sessionToken).toBeUndefined();
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('fly.storage.tigris.dev');
  });

  it('keeps an explicit region over the auto default', async () => {
    setEnv({ ...KEYED, [S3_ENV.region]: 'eu-west-1' });
    expect(await s3Client().config.region()).toBe('eu-west-1');
  });
});

describe('s3Client with no key and no endpoint (AWS)', () => {
  it('builds without throwing and resolves credentials from the chain', async () => {
    setEnv({ ...CHAIN, [S3_ENV.region]: 'us-east-1' });
    const client = s3Client();
    expect(client.config.endpoint).toBeUndefined();
    expect(client.config.forcePathStyle).toBe(false);
    expect(typeof client.config.credentials).toBe('function');
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'ASIACHAINKEY',
      secretAccessKey: 'chain-secret',
      sessionToken: 'chain-session-token',
    });
    expect(await client.config.region()).toBe('us-east-1');
  });

  it("takes the chain's region when MOTIR_S3_REGION is unset, never auto", async () => {
    setEnv({ ...CHAIN, AWS_REGION: 'eu-central-1' });
    expect(await s3Client().config.region()).toBe('eu-central-1');
  });

  it('presigns a GET against the AWS S3 host, carrying the session token', async () => {
    setEnv({ ...CHAIN, [S3_ENV.region]: 'us-east-1', [S3_ENV.privateBucket]: 'core-private' });
    const url = new URL(await signedDownloadUrl('attachments/a.png'));
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('chain-session-token');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIACHAINKEY\//);
    expect(url.hostname).toMatch(/^core-private\.s3\.us-east-1\.amazonaws\.com$/);
  });
});

describe('s3Client with half a key pair', () => {
  it.each([
    [S3_ENV.accessKeyId, S3_ENV.secretAccessKey],
    [S3_ENV.secretAccessKey, S3_ENV.accessKeyId],
  ])('throws naming the missing one when only %s is set', (present, missing) => {
    setEnv({ ...CHAIN, [present]: 'only-half' });
    expect(() => s3Client()).toThrow(new RegExp(`^${missing} is not set`));
  });
});

describe('the memoised client', () => {
  it('is the same instance while the env is unchanged', () => {
    setEnv(KEYED);
    expect(s3Client()).toBe(s3Client());
    setEnv(CHAIN);
    expect(s3Client()).toBe(s3Client());
  });

  it.each([
    ['the key pair', { [S3_ENV.accessKeyId]: 'other-key' }],
    ['the endpoint', { [S3_ENV.endpoint]: 'https://minio.local' }],
    ['the region', { [S3_ENV.region]: 'us-east-2' }],
    ['the credential mode', { [S3_ENV.accessKeyId]: '', [S3_ENV.secretAccessKey]: '' }],
    ['the endpoint mode', { [S3_ENV.endpoint]: '' }],
  ])('is rebuilt when %s changes', (_what, patch) => {
    setEnv(KEYED);
    const before = s3Client();
    setEnv({ ...KEYED, ...patch });
    expect(s3Client()).not.toBe(before);
  });

  it('is rebuilt when the E2E transport is installed', () => {
    setEnv(KEYED);
    const before = s3Client();
    installObjectStoreTransport({ handle: () => Promise.resolve({ response: {} }) });
    expect(s3Client()).not.toBe(before);
  });
});

describe('the bucket accessors', () => {
  it('still throw when their variables are unset', () => {
    setEnv({});
    expect(() => privateBucket()).toThrow(/MOTIR_S3_PRIVATE_BUCKET is not set/);
    expect(() => publicBucket()).toThrow(/MOTIR_S3_PUBLIC_BUCKET is not set/);
    expect(() => publicBaseUrl()).toThrow(/MOTIR_S3_PUBLIC_BASE_URL is not set/);
  });
});
