import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformRole } from '@/generated/prisma/client';
import { SHARD_VCPU_QUOTA_TARGET } from '@/lib/ciFleet/shardTargets';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  registerShardProvisioningProvider,
  type ProviderStepContext,
  type ShardProvisioningProvider,
} from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `fleet-admin add-shard` / `refresh-limits` (Story MOTIR-8953 · MOTIR-8967),
// against a real database for the row and the audit entry, GitHub stubbed at
// `fetch`, and a fake provider whose account, network, quota and credential steps
// can be told to leave work pending.

const SLUG = 'moooon-bv';
const ORG = 'motir-fleet-iad-1';
const NAME = 'ci-runner-iad-1';
const PREFIX = 'FLEET_SHARD_CI_RUNNER_IAD_1';
const CLIENT_ID = 'Iv1.studio';
const SECRETS = {
  admin: 'ghp_ADMIN_SECRET_never_printed',
  installation: 'ghs_INSTALL_SECRET_never_printed',
  management: 'FAKE_MANAGEMENT_SECRET_never_printed',
  runtimeKey: 'FAKE_RUNTIME_KEY_SECRET_never_printed',
};

interface GithubWorld {
  orgs: Set<string>;
  installed: Set<string>;
  calls: string[];
}

interface FakeWorld {
  accounts: Set<string>;
  networks: Set<string>;
  quota: number;
  accountCreates: number;
  networkCreates: number;
}

let github: GithubWorld;
let fake: FakeWorld;
let unregister: () => void;
let operatorEmail: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      github.calls.push(`${method} ${path}`);
      if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        return json({ token: SECRETS.installation, expires_at: '2099-01-01T00:00:00Z' }, 201);
      }
      if (method === 'GET' && path === '/app/installations') {
        return json([
          { id: 150298786, target_type: 'Organization', account: { login: 'motir-projects' } },
          { id: 174620715, target_type: 'Enterprise', account: { slug: SLUG } },
        ]);
      }
      if (method === 'GET' && path === '/app') return json({ client_id: CLIENT_ID });
      const orgInstallation = path.match(/^\/orgs\/([^/]+)\/installation$/);
      if (method === 'GET' && orgInstallation) return json({ id: 9001 });
      const org = path.match(/^\/orgs\/([^/]+)$/);
      if (method === 'GET' && org) {
        return github.orgs.has(org[1]!) ? json({ login: org[1], id: 77 }) : json({}, 404);
      }
      if (method === 'POST' && path === '/graphql') {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { input?: { login: string } };
        };
        if (body.query.includes('enterprise(slug')) {
          return json({ data: { enterprise: { id: 'E_kgDOAAyC2w' } } });
        }
        const login = body.variables.input!.login;
        github.orgs.add(login);
        return json({
          data: { createEnterpriseOrganization: { organization: { login, databaseId: 77 } } },
        });
      }
      const installs = path.match(
        new RegExp(`^/enterprises/${SLUG}/apps/organizations/([^/]+)/installations$`),
      );
      if (installs && method === 'GET') {
        return json(
          github.installed.has(installs[1]!)
            ? [{ id: 5, client_id: CLIENT_ID, app_slug: 'motir-studio' }]
            : [],
        );
      }
      if (installs && method === 'POST') {
        github.installed.add(installs[1]!);
        return json({ id: 5, client_id: CLIENT_ID, app_slug: 'motir-studio' });
      }
      return json({ message: `unstubbed ${method} ${path}` }, 500);
    }),
  );
}

/** A provider that keeps its account, network and quota in memory, and confirms
 *  the runtime key when `<PREFIX>_ACCESS_KEY` is set to the expected value. */
const fakeProvider: ShardProvisioningProvider = {
  name: 'fake',
  options: [{ name: 'fake-account', description: 'the fake account id', required: false }],
  requiredEnv: () => ['FAKE_PROVIDER_MANAGEMENT_TOKEN'],
  validate: (ctx) => (ctx.region ? [] : ['--region is required']),
  location: (ctx) => ({
    provider: 'fly',
    flyOrg: 'fake',
    flyApp: `fake-${ctx.name}`,
    flyRegion: ctx.region,
  }),
  matchesRow: (shard: FleetShardDTO, ctx: ProviderStepContext) =>
    shard.provider === 'fly' &&
    shard.fly?.app === `fake-${ctx.name}` &&
    shard.fly.region === ctx.region,
  async account(ctx) {
    if (fake.accounts.has(ctx.name)) {
      return { created: false, detail: 'account found', account: { id: ctx.name } };
    }
    fake.accounts.add(ctx.name);
    fake.accountCreates += 1;
    return { created: true, detail: 'account created', account: { id: ctx.name } };
  },
  async network(ctx) {
    if (fake.networks.has(ctx.name)) return { created: [] };
    fake.networks.add(ctx.name);
    fake.networkCreates += 1;
    return { created: ['vpc', 'subnet'] };
  },
  async readQuota() {
    return { vcpuQuota: fake.quota, limits: { machineLimit: 10 } };
  },
  async runtimeCredential(ctx) {
    return { confirmed: process.env[`${ctx.credentialRef}_ACCESS_KEY`] === SECRETS.runtimeKey };
  },
  manualCredentialStep: (ctx) =>
    `create the account's access key, then run: flyctl secrets set -a motir-core ${ctx.credentialRef}_ACCESS_KEY=<key>`,
};

async function staff(role: PlatformRole | null): Promise<string> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.email;
}

function args(overrides: Record<string, string | null> = {}, flags: string[] = ['--create-org']) {
  const values: Record<string, string | null> = {
    provider: 'fake',
    'fleet-kind': 'ci_runner',
    name: NAME,
    region: 'iad',
    'github-org': ORG,
    'admin-login': 'zhuyue11',
    operator: operatorEmail,
    ...overrides,
  };
  const out = ['add-shard', ...flags];
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) out.push(`--${key}`, value);
  }
  return out;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function creates(): string[] {
  return github.calls.filter(
    (call) =>
      call === 'POST /graphql' ||
      (call.startsWith('POST /enterprises/') && call.endsWith('/installations')),
  );
}

async function shardRow() {
  return adminDb.fleetShard.findUnique({ where: { name: NAME } });
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { startsWith: 'fleet.shard.' } },
    orderBy: { seq: 'asc' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', SLUG);
  vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', SECRETS.admin);
  vi.stubEnv('FAKE_PROVIDER_MANAGEMENT_TOKEN', SECRETS.management);
  vi.stubEnv(`${PREFIX}_ACCESS_KEY`, '');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  github = { orgs: new Set(), installed: new Set(), calls: [] };
  fake = {
    accounts: new Set(),
    networks: new Set(),
    quota: SHARD_VCPU_QUOTA_TARGET - 500,
    accountCreates: 0,
    networkCreates: 0,
  };
  installGithub();
  unregister = registerShardProvisioningProvider(fakeProvider);
  operatorEmail = await staff('superadmin');
});

afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add-shard, first run', () => {
  it('creates the org, installs the App, runs the provider steps once and writes a provisioning row', async () => {
    const result = await run(args());

    expect(result.code).toBe(2);
    expect(creates()).toEqual([
      'POST /graphql',
      'POST /graphql',
      `POST /enterprises/${SLUG}/apps/organizations/${ORG}/installations`,
    ]);
    expect(github.calls.filter((c) => c === 'POST /graphql')).toHaveLength(2); // enterprise id + the mutation
    expect(fake.accountCreates).toBe(1);
    expect(fake.networkCreates).toBe(1);

    const row = await shardRow();
    expect(row).toMatchObject({
      role: 'primary',
      state: 'provisioning',
      fleetKind: 'ci_runner',
      githubOrg: ORG,
      githubInstallationId: '9001',
      credentialRef: PREFIX,
      vcpuQuota: SHARD_VCPU_QUOTA_TARGET - 500,
      githubRegistrationsPer5Min: 1500,
      githubApiPerHour: 15000,
    });
    expect(row!.limitsSource).toMatchObject({
      vcpuQuota: 'provider_read',
      githubRegistrationsPer5Min: 'documented',
      githubApiPerHour: 'documented',
    });

    expect(result.out).toContain('Pending manual steps:');
    expect(result.out).toContain(`vCPU quota from ${SHARD_VCPU_QUOTA_TARGET - 500}`);
    expect(result.out).toContain(`flyctl secrets set -a motir-core ${PREFIX}_ACCESS_KEY=<key>`);
  });

  it('a re-run makes no create call and reports every completed step already', async () => {
    await run(args());
    github.calls = [];

    const result = await run(args());

    expect(result.code).toBe(2);
    expect(creates()).toEqual([]);
    expect(fake.accountCreates).toBe(1);
    expect(fake.networkCreates).toBe(1);
    for (const step of [
      'github_org',
      'app_installation',
      'provider_account',
      'network',
      'account_row',
    ]) {
      expect(result.out).toMatch(new RegExp(`^${step}\\s+already`, 'm'));
    }
    expect(await adminDb.fleetShard.count()).toBe(1);
  });

  it('with the quota at target and the runtime key accepted, a resume makes the row active and exits 0', async () => {
    await run(args());
    fake.quota = SHARD_VCPU_QUOTA_TARGET;
    vi.stubEnv(`${PREFIX}_ACCESS_KEY`, SECRETS.runtimeKey);

    const result = await run(args());

    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Pending manual steps');
    const row = await shardRow();
    expect(row).toMatchObject({ state: 'active', vcpuQuota: SHARD_VCPU_QUOTA_TARGET });
  });
});

describe('refusals before any external call', () => {
  it.each([
    ['a missing fleet kind', { 'fleet-kind': null }],
    ['an unknown fleet kind', { 'fleet-kind': 'mainframe' }],
    ['an unknown provider', { provider: 'acme-cloud' }],
  ])('%s', async (_label, overrides) => {
    const result = await run(args(overrides));

    expect(result.code).toBe(1);
    expect(result.err).toContain('refused:');
    expect(github.calls).toEqual([]);
    expect(fake.accountCreates).toBe(0);
    expect(await adminDb.fleetShard.count()).toBe(0);
  });

  it('an operator who is not platform staff is refused before the first external call', async () => {
    const result = await run(args({ operator: await staff(null) }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a superadmin');
    expect(github.calls).toEqual([]);
  });

  it('re-using a name with a different fleet kind, region or org refuses and changes nothing', async () => {
    await run(args());
    const before = await shardRow();
    github.calls = [];

    for (const overrides of [
      { 'fleet-kind': 'hosted_agent' } as Record<string, string>,
      { region: 'fra' },
      { 'github-org': 'motir-fleet-other' },
    ]) {
      const result = await run(args(overrides));
      expect(result.code).toBe(1);
      expect(result.err).toContain('already the ci_runner account');
    }
    expect(github.calls).toEqual([]);
    expect(await shardRow()).toEqual(before);
  });
});

describe('--existing-org', () => {
  it('refuses before any provider call when the org does not exist', async () => {
    const result = await run(args({ 'admin-login': null }, ['--existing-org']));

    expect(result.code).toBe(1);
    expect(result.err).toContain(`--existing-org ${ORG} does not exist`);
    expect(fake.accountCreates).toBe(0);
    expect(await adminDb.fleetShard.count()).toBe(0);
  });

  it('creates no org when it exists', async () => {
    github.orgs.add(ORG);

    const result = await run(args({ 'admin-login': null }, ['--existing-org']));

    expect(result.code).toBe(2);
    expect(github.calls).not.toContain('POST /graphql');
    expect(result.out).toMatch(/^github_org\s+already/m);
  });
});

describe('the audit and the secrets', () => {
  it('writes one fleet.shard.add entry per run, naming the account, its kind and the outcomes', async () => {
    await run(args());
    await run(args());

    const rows = await auditRows();
    const shard = await shardRow();
    expect(rows.map((r) => r.action)).toEqual(['fleet.shard.add', 'fleet.shard.add']);
    expect(rows[0]).toMatchObject({
      targetKind: 'platform',
      targetId: shard!.id,
      targetLabel: NAME,
    });
    expect(rows[0]!.metadata).toMatchObject({
      fleetKind: 'ci_runner',
      provider: 'fake',
      steps: expect.arrayContaining([
        expect.objectContaining({ step: 'github_org', outcome: 'done' }),
        expect.objectContaining({ step: 'quota', outcome: 'pending' }),
      ]),
    });
    expect((rows[0]!.metadata as { pendingManualSteps: string[] }).pendingManualSteps).toHaveLength(
      2,
    );
  });

  it('no stubbed secret value reaches stdout, stderr or the audit row', async () => {
    const first = await run(args());
    vi.stubEnv(`${PREFIX}_ACCESS_KEY`, SECRETS.runtimeKey);
    fake.quota = SHARD_VCPU_QUOTA_TARGET;
    const second = await run(args());

    const printed = [first.out, first.err, second.out, second.err].join('\n');
    const audited = JSON.stringify(await auditRows());
    for (const secret of Object.values(SECRETS)) {
      expect(printed).not.toContain(secret);
      expect(audited).not.toContain(secret);
    }
  });
});

describe('refresh-limits', () => {
  it('updates only vcpuQuota and its source, and writes a fleet.shard.limits entry', async () => {
    await run(args());
    const before = (await shardRow())!;
    fake.quota = 4000;

    const result = await run(['refresh-limits', '--name', NAME, '--operator', operatorEmail]);

    expect(result.code).toBe(0);
    const after = (await shardRow())!;
    expect(after.vcpuQuota).toBe(4000);
    expect(after.limitsSource).toEqual({
      ...(before.limitsSource as object),
      vcpuQuota: 'provider_read',
    });
    expect({ ...after, vcpuQuota: null, limitsVerifiedAt: null, updatedAt: null }).toEqual({
      ...before,
      vcpuQuota: null,
      limitsVerifiedAt: null,
      updatedAt: null,
    });
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({ action: 'fleet.shard.limits', targetId: before.id });
    expect(rows.at(-1)!.metadata).toMatchObject({ from: before.vcpuQuota, to: 4000 });
  });

  it('refuses a non-staff operator before reading anything', async () => {
    await run(args());
    const result = await run([
      'refresh-limits',
      '--name',
      NAME,
      '--operator',
      await staff('support'),
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a superadmin');
  });

  it('refuses a name no fleet account carries', async () => {
    const result = await run(['refresh-limits', '--name', 'nope', '--operator', operatorEmail]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('no fleet account is named nope');
  });

  it("refuses before reading the quota when the provider's env is missing", async () => {
    await run(args());
    fake.quota = 4000;
    vi.stubEnv('FAKE_PROVIDER_MANAGEMENT_TOKEN', '');

    const result = await run(['refresh-limits', '--name', NAME, '--operator', operatorEmail]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('missing env: FAKE_PROVIDER_MANAGEMENT_TOKEN');
    expect((await shardRow())!.vcpuQuota).not.toBe(4000);
  });
});
