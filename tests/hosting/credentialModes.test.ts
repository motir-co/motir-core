import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_MANAGEMENT_ENV,
  OrchestratorNotConfiguredError,
  awsManagementCredentials,
  createAwsManagementApi,
  type AwsManagementClientFactory,
} from '@motir/orchestrator';

// Story MOTIR-9709 · MOTIR-9933 — the story gate over BOTH credential modes.
// On Fly, motir-core signs with static keys (Tigris's pair, the management IAM
// user's key); on Fargate it holds no key and the SDK's default chain resolves
// the task role. Each card tested its own half; this file runs the keyed and the
// key-free mode side by side across the blob client, the uploader's operations,
// the management credentials and `fleet-admin check-quota`, so neither mode can
// regress the other unnoticed. No network and no database: the object store is
// an in-process transport, the management SDK a recording factory, and the
// database modules throw on any call.

const noDatabase = () => {
  throw new Error('the credential path touched the database');
};
const throwingModule = (): object =>
  new Proxy(noDatabase, {
    get: (_target, name) => (name === 'then' ? undefined : throwingModule()),
    apply: noDatabase,
  });
vi.mock('@/lib/db', () => ({ db: throwingModule(), adminDb: throwingModule() }));
vi.mock('@/lib/repositories/fleetShardRepository', () => ({
  fleetShardRepository: throwingModule(),
}));
vi.mock('@/lib/workspaces/context', () => ({ withSystemContext: noDatabase }));

const { S3_ENV, installObjectStoreTransport, resetS3ClientForTests, s3Client } =
  await import('@/lib/blob/s3');
const { createObjectStoreTransport } = await import('@/lib/test-blob-mock');
const { deleteAttachmentBlob, headPrivateBlob, putPrivateAttachment, signedDownloadUrl } =
  await import('@/lib/blob/uploader');
const { runFleetAdmin } = await import('@/scripts/fleet/fleetAdmin');

const BUCKETS = {
  [S3_ENV.privateBucket]: 'core-private',
  [S3_ENV.publicBucket]: 'core-public',
  [S3_ENV.publicBaseUrl]: 'https://assets.example.test',
};
const KEYED = {
  ...BUCKETS,
  [S3_ENV.endpoint]: 'https://fly.storage.tigris.dev',
  [S3_ENV.accessKeyId]: 'tigris-access-key',
  [S3_ENV.secretAccessKey]: 'tigris-secret-key',
};
/** What the chain reads on a machine with no profile — standing in for the task role. */
const CHAIN = {
  AWS_ACCESS_KEY_ID: 'ASIATASKROLE',
  AWS_SECRET_ACCESS_KEY: 'task-role-secret',
  AWS_SESSION_TOKEN: 'task-role-session',
};
const KEY_FREE = { ...BUCKETS, ...CHAIN, [S3_ENV.region]: 'us-east-1' };
const ALL = [
  ...Object.values(S3_ENV),
  ...Object.keys(CHAIN),
  ...Object.values(AWS_MANAGEMENT_ENV),
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

describe('the blob client in both modes, in one run', () => {
  it('keyed: static credentials, path-style, the custom host', async () => {
    setEnv(KEYED);
    const client = s3Client();
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'tigris-access-key',
      secretAccessKey: 'tigris-secret-key',
    });
    expect(client.config.forcePathStyle).toBe(true);
    const url = new URL(await signedDownloadUrl('a/b.png'));
    expect(url.hostname).toBe('fly.storage.tigris.dev');
    expect(url.pathname).toBe('/core-private/a/b.png');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBeNull();
  });

  it('key-free: chain credentials, no custom endpoint, a presign carrying the session token', async () => {
    setEnv(KEY_FREE);
    const client = s3Client();
    expect(client.config.endpoint).toBeUndefined();
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: 'ASIATASKROLE' });
    const url = new URL(await signedDownloadUrl('a/b.png'));
    expect(url.hostname).toBe('core-private.s3.us-east-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('task-role-session');
  });

  it('flipping the mode builds a new client; an unchanged environment keeps the instance', () => {
    setEnv(KEYED);
    const keyed = s3Client();
    expect(s3Client()).toBe(keyed);
    setEnv(KEY_FREE);
    const keyFree = s3Client();
    expect(keyFree).not.toBe(keyed);
    expect(s3Client()).toBe(keyFree);
    setEnv(KEYED);
    expect(s3Client()).not.toBe(keyFree);
  });

  it.each([
    [S3_ENV.accessKeyId, S3_ENV.secretAccessKey],
    [S3_ENV.secretAccessKey, S3_ENV.accessKeyId],
  ])('a half-set pair (%s only) throws naming the missing one', (present, missing) => {
    setEnv({ ...KEY_FREE, [present]: 'half' });
    expect(() => s3Client()).toThrow(new RegExp(`^${missing} is not set`));
  });
});

interface Seen {
  method: string;
  hostname: string;
  credential: string;
  token: string | undefined;
}

/** The in-process store, recording who signed each request and where it went. */
function recordingStore(): Seen[] {
  const seen: Seen[] = [];
  const store = createObjectStoreTransport();
  installObjectStoreTransport({
    handle(request: {
      method: string;
      path: string;
      hostname: string;
      headers: Record<string, string>;
    }) {
      seen.push({
        method: request.method,
        hostname: request.hostname,
        credential: /Credential=([^/]+)\//.exec(request.headers.authorization ?? '')?.[1] ?? '',
        token: request.headers['x-amz-security-token'],
      });
      return store.handle(request);
    },
  });
  return seen;
}

describe('the uploader in both modes', () => {
  it.each([
    [
      'key-free',
      KEY_FREE,
      'ASIATASKROLE',
      'task-role-session',
      'core-private.s3.us-east-1.amazonaws.com',
    ],
    ['keyed', KEYED, 'tigris-access-key', undefined, 'fly.storage.tigris.dev'],
  ])(
    '%s: put, head, delete and a presigned GET all sign and complete',
    async (_mode, env, credential, token, host) => {
      setEnv(env);
      const seen = recordingStore();
      const { pathname } = await putPrivateAttachment(
        'evidence/clip.webm',
        Buffer.from('bytes'),
        'video/webm',
      );
      expect(await headPrivateBlob(pathname)).toEqual({ size: 5, contentType: 'video/webm' });
      await deleteAttachmentBlob(pathname);
      expect(await headPrivateBlob(pathname)).toBeNull();
      expect(
        new URL(await signedDownloadUrl(pathname)).searchParams.get('X-Amz-Signature'),
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.map((s) => s.method)).toEqual(['PUT', 'HEAD', 'DELETE', 'HEAD']);
      for (const request of seen) {
        expect(request).toMatchObject({ credential, hostname: host });
        expect(request.token).toBe(token);
      }
    },
  );
});

const ROLE_ARN = 'arn:aws:iam::111111111111:role/motir-add-shard';
const MANAGEMENT_KEYED = {
  [AWS_MANAGEMENT_ENV.accessKeyId]: 'AKIAMANAGEMENT',
  [AWS_MANAGEMENT_ENV.secretAccessKey]: 'management-secret',
  [AWS_MANAGEMENT_ENV.roleArn]: ROLE_ARN,
};
const MANAGEMENT_KEY_FREE = { [AWS_MANAGEMENT_ENV.roleArn]: ROLE_ARN };

interface Built {
  service: string;
  credentials: { accessKeyId: string } | undefined;
}

/** A management SDK recording each client it builds and each command it sends. */
function managementSdk() {
  const built: Built[] = [];
  const sent: string[] = [];
  const session = (id: string) => ({
    Credentials: {
      AccessKeyId: id,
      SecretAccessKey: `${id}-secret`,
      SessionToken: `${id}-token`,
      Expiration: new Date(Date.now() + 3_600_000),
    },
  });
  const factory: AwsManagementClientFactory = (service, config) => {
    built.push({ service, credentials: config.credentials });
    return {
      send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        sent.push(name);
        if (name === 'AssumeRoleCommand') {
          const arn = (command as { input: { RoleArn: string } }).input.RoleArn;
          return Promise.resolve(session(arn === ROLE_ARN ? 'ASIAMGMT' : 'ASIAMEMBER'));
        }
        return Promise.resolve({ Quota: { Value: 64 } });
      },
    };
  };
  return { factory, built, sent };
}

describe('the fleet management credentials in both modes', () => {
  it('role ARN only: builds, and the first STS client gets no static credentials', async () => {
    const { factory, built } = managementSdk();
    const credentials = awsManagementCredentials(MANAGEMENT_KEY_FREE);
    expect(credentials).toEqual({ roleArn: ROLE_ARN });
    const api = createAwsManagementApi(credentials, { clientFactory: factory });
    await api.readVcpuQuota(await api.assumeMemberRole('222222222222'), 'us-east-1');
    expect(built[0]).toEqual({ service: 'sts', credentials: undefined });
    expect(built.some((b) => b.credentials?.accessKeyId === 'AKIAMANAGEMENT')).toBe(false);
  });

  it('the key trio: the first STS client signs with the management key, as before', async () => {
    const { factory, built } = managementSdk();
    const api = createAwsManagementApi(awsManagementCredentials(MANAGEMENT_KEYED), {
      clientFactory: factory,
    });
    await api.assumeMemberRole('222222222222');
    expect(built[0]).toMatchObject({
      service: 'sts',
      credentials: { accessKeyId: 'AKIAMANAGEMENT' },
    });
  });

  it('no role ARN throws OrchestratorNotConfiguredError naming every unset variable', () => {
    expect(() => awsManagementCredentials({})).toThrow(OrchestratorNotConfiguredError);
    expect(() => awsManagementCredentials({})).toThrow(AWS_MANAGEMENT_ENV.roleArn);
    const halfKey = { [AWS_MANAGEMENT_ENV.accessKeyId]: 'AKIA' };
    expect(() => awsManagementCredentials(halfKey)).toThrow(
      new RegExp(`${AWS_MANAGEMENT_ENV.secretAccessKey}.*${AWS_MANAGEMENT_ENV.roleArn}`),
    );
  });
});

describe('fleet-admin check-quota in both modes', () => {
  it.each([
    ['key-free', MANAGEMENT_KEY_FREE],
    ['keyed', MANAGEMENT_KEYED],
  ])('%s: exits 0 with one line, one member assumption and one quota read', async (_mode, env) => {
    const { factory, sent } = managementSdk();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runFleetAdmin(
      ['check-quota', '--account-id', '222222222222'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {},
      {
        management: () =>
          createAwsManagementApi(awsManagementCredentials(env), { clientFactory: factory }),
      },
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(['account 222222222222 us-east-1 L-1216C47A granted 64']);
    // The management role, then the member role, then the quota.
    expect(sent).toEqual(['AssumeRoleCommand', 'AssumeRoleCommand', 'GetServiceQuotaCommand']);
  });
});

describe('fleet-admin check-quota with its production management API', () => {
  it('builds it from the process environment and prints what is unset', async () => {
    setEnv({});
    const err: string[] = [];
    const code = await runFleetAdmin(['check-quota', '--account-id', '222222222222'], {
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err).toEqual([expect.stringContaining(AWS_MANAGEMENT_ENV.roleArn)]);
  });
});
