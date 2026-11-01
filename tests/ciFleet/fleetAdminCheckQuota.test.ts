import { describe, expect, it, vi } from 'vitest';
import {
  AwsManagementApiError,
  OrchestratorNotConfiguredError,
  type AwsManagementApi,
  type AwsSessionCredentials,
} from '@motir/orchestrator';

// MOTIR-9926 — `fleet-admin check-quota` reads ONE account's granted vCPU quota
// through the management API and nothing else. The database is made to throw on
// ANY use, so a passing test proves the command never touches it: the AWS core
// database it runs against may be empty.
const noDatabase = () => {
  throw new Error('check-quota touched the database');
};
// Reading a property is allowed (modules wire themselves up at import); CALLING
// anything reached from the database or a repository throws.
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

const { runFleetAdmin } = await import('@/scripts/fleet/fleetAdmin');
const { CHECK_QUOTA_USAGE } = await import('@/scripts/fleet/fleetAdminCheckQuota');

const SESSION: AwsSessionCredentials = {
  accessKeyId: 'ASIAMEMBER',
  secretAccessKey: 'member-secret',
  sessionToken: 'member-token',
} as AwsSessionCredentials;

/** A management API recording every call; only the two the command needs exist. */
function fakeManagement(opts: { granted?: number; assumeFails?: Error; readFails?: Error } = {}): {
  api: AwsManagementApi;
  calls: string[];
} {
  const calls: string[] = [];
  const api = new Proxy({} as AwsManagementApi, {
    get(_target, name) {
      if (name === 'then') return undefined;
      if (name === 'assumeMemberRole') {
        return (accountId: string) => {
          calls.push(`assumeMemberRole ${accountId}`);
          if (opts.assumeFails) return Promise.reject(opts.assumeFails);
          return Promise.resolve(SESSION);
        };
      }
      if (name === 'readVcpuQuota') {
        return (session: AwsSessionCredentials, region: string) => {
          calls.push(`readVcpuQuota ${session === SESSION ? 'session' : 'other'} ${region}`);
          if (opts.readFails) return Promise.reject(opts.readFails);
          return Promise.resolve(opts.granted ?? 64);
        };
      }
      return () => {
        calls.push(`unexpected ${String(name)}`);
        throw new Error(`unexpected management call ${String(name)}`);
      };
    },
  });
  return { api, calls };
}

async function run(argv: string[], management: () => AwsManagementApi) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(
    ['check-quota', ...argv],
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    {},
    { management },
  );
  return { code, out, err };
}

describe('fleet-admin check-quota', () => {
  it('prints the granted quota for the account and region, and exits 0', async () => {
    const { api, calls } = fakeManagement({ granted: 64 });
    const { code, out, err } = await run(
      ['--account-id', '123456789012', '--region', 'us-east-1'],
      () => api,
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(['account 123456789012 us-east-1 L-1216C47A granted 64']);
    expect(calls).toEqual(['assumeMemberRole 123456789012', 'readVcpuQuota session us-east-1']);
  });

  it('defaults the region to us-east-1', async () => {
    const { api, calls } = fakeManagement({ granted: 8 });
    const { code, out } = await run(['--account-id', '210987654321'], () => api);
    expect(code).toBe(0);
    expect(out).toEqual(['account 210987654321 us-east-1 L-1216C47A granted 8']);
    expect(calls).toEqual(['assumeMemberRole 210987654321', 'readVcpuQuota session us-east-1']);
  });

  it.each([
    ['assumeMemberRole', { assumeFails: new AwsManagementApiError('sts', 'AccessDenied', 403) }],
    ['readVcpuQuota', { readFails: new AwsManagementApiError('quotas', 'AccessDenied', 403) }],
  ])('prints only the AWS code when %s is denied, and exits 1', async (_call, failure) => {
    const { api } = fakeManagement(failure);
    const { code, out, err } = await run(['--account-id', '123456789012'], () => api);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['error: AccessDenied']);
    expect(err.join('\n')).not.toMatch(/refused the call|HTTP/);
  });

  it("prints the error's class for a non-AWS failure", async () => {
    const { api } = fakeManagement({ readFails: new TypeError('secret detail') });
    const { code, err } = await run(['--account-id', '123456789012'], () => api);
    expect(code).toBe(1);
    expect(err).toEqual(['error: TypeError']);
  });

  it('prints the not-configured message, naming what is unset, and exits 1', async () => {
    const { code, err } = await run(['--account-id', '123456789012'], () => {
      throw new OrchestratorNotConfiguredError('set AWS_ORG_ADMIN_ROLE_ARN');
    });
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('AWS_ORG_ADMIN_ROLE_ARN');
  });

  it.each([
    ['no account id', []],
    ['a short account id', ['--account-id', '12345']],
    ['a non-numeric account id', ['--account-id', '12345678901a']],
    ['an unknown flag', ['--account-id', '123456789012', '--name', 'pool-1']],
    ['a positional', ['123456789012']],
  ])('prints the usage and exits 1 without calling AWS for %s', async (_case, argv) => {
    const management = vi.fn(() => fakeManagement().api);
    const { code, out, err } = await run(argv, management);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([CHECK_QUOTA_USAGE]);
    expect(management).not.toHaveBeenCalled();
  });

  it('is listed in the fleet-admin usage', async () => {
    const err: string[] = [];
    const code = await runFleetAdmin(['no-such-command'], {
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('fleet-admin check-quota --account-id');
  });
});
