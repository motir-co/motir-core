// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import en from '@/messages/en.json';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { agentRunnerOnPool } from '@/lib/ciFleet/fleetKindSwitches';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import type { PlatformPoolBlockDTO, PlatformPoolsDTO } from '@/lib/dto/platformFleetPools';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { setAwsEc2OverrideForTests } from '@/lib/orchestrator';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { fleetPoolStatusService } from '@/lib/services/fleetPoolStatusService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';

// STORY MOTIR-9367's INTEGRATION GATE (MOTIR-9564) — the Pools read path from
// real Postgres rows to the rendered section. The service card proves its gate,
// audit and per-kind failure; the section card proves each state from a stubbed
// DTO. Neither can show that the REAL rows, read in system context across
// several workspaces, come out of the REAL section with the right totals and
// without a number standing in for a quota nobody has read. This suite does.
//
// Mocked: `getSession()` (the one `vi.mock` CLAUDE.md allows), and next-intl's
// server translator bound to the real `en` catalogue, as `monitoringStoryGate`
// does — Fizz has no next-intl request scope. Real: the staff gate, the shard
// rows, the CI intents the headroom pass measures use from, the quota requests,
// the growth events, the audit chain, the service, the section and the page.
// The two AWS seams are installed THROWING, so a call to either fails the case.

let session: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: AdminMonitoringPage } = await import('@/app/(admin)/admin/monitoring/page');
const { PoolsSection } = await import('@/app/(admin)/admin/monitoring/_components/PoolsSection');
const { platformFleetPoolsService } = await import('@/lib/services/platformFleetPoolsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { requirePlatformStaff } = await import('@/lib/platform/auth');

const p = en.platformAdmin.monitoring.pools;
const NOW = new Date();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** What one running CI job adds to its account's use: one container's peak. */
const VCPU_PER_JOB = FLEET_CONTAINER_SIZE.cpus;

const SECRET = 'FLEET_SECRET_NEVER_ON_THE_PAGE';
const ACCOUNT_PREFIX = '7777888899';
let seq = 0;
let memberEmails: string[] = [];

const ec2Factory = vi.fn(() => {
  throw new Error('the pools read must not reach EC2');
});
const quotaRead = vi.fn(async () => {
  throw new Error('the pools read must not read Service Quotas');
});
let unregisterProvider: () => void;

const fetchGuard = vi.fn(async () => {
  throw new Error('a provider reached the network in a test');
});

interface Tenant {
  organizationId: string;
  workspaceId: string;
}

/** An organisation in its own workspace, with an owner AND a member whose emails must never leak. */
async function seedTenant(): Promise<Tenant> {
  seq += 1;
  const ownerEmail = `pools-gate-owner-${seq}@customer.test`;
  const memberEmail = `pools-gate-member-${seq}@customer.test`;
  memberEmails.push(ownerEmail, memberEmail);
  const owner = await createTestUser({ email: ownerEmail });
  const member = await createTestUser({ email: memberEmail });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Pools gate ${seq}`,
    ownerUserId: owner.id,
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: member.id, workspaceRole: 'member' },
  });
  return { organizationId: workspace.organizationId, workspaceId: workspace.id };
}

async function account(
  name: string,
  options: {
    granted?: number | null;
    role?: 'primary' | 'spare';
    state?: 'active' | 'provisioning' | 'disabled';
  } = {},
) {
  seq += 1;
  const granted = options.granted === undefined ? 100 : options.granted;
  return fleetShardService.createShard({
    name,
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: options.role ?? 'primary',
    state: options.state ?? 'active',
    githubOrg: 'motir-fleet-use1-1',
    githubInstallationId: '9001',
    awsAccountId: `${ACCOUNT_PREFIX}${String(seq).padStart(2, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: SECRET,
    limits: granted === null ? {} : { vcpuQuota: granted },
    limitsSource: granted === null ? {} : { vcpuQuota: 'provider_read' },
  });
}

/** One CI job of `t`'s running on the account now. */
async function runningJob(t: Tenant, shardId: string) {
  seq += 1;
  await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.organizationId,
      installationId: '1',
      runId: `run-${seq}`,
      runAttempt: 1,
      jobId: `job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: ago(10 * MIN),
      status: 'running',
      fleetShardId: shardId,
      bootedAt: ago(2 * MIN),
      startedAt: ago(2 * MIN),
    },
  });
}

async function quotaRequest(
  shardId: string,
  options: {
    status: 'pending' | 'case_opened' | 'approved' | 'denied';
    desired?: number;
    createdAt: Date;
    closedAt?: Date | null;
  },
) {
  seq += 1;
  return adminDb.fleetQuotaRequest.create({
    data: {
      shardId,
      fleetKind: 'ci_runner',
      quotaCode: 'L-1216C47A',
      desiredValue: options.desired ?? 128,
      awsRequestId: `req-${seq}`,
      status: options.status,
      grantedValue: null,
      createdAt: options.createdAt,
      lastReadAt: ago(MIN),
      closedAt: options.closedAt ?? null,
    },
  });
}

/** A quota read that once succeeded and has since failed: the value is gone, its time stays. */
async function failLaterRead(shardId: string, lastGood: Date) {
  await adminDb.fleetShard.update({
    where: { id: shardId },
    data: { limitsSource: { vcpuQuota: 'provider_read' }, limitsVerifiedAt: lastGood },
  });
}

async function seedStaff(): Promise<PlatformPrincipal> {
  seq += 1;
  const staff = await createTestUser({ email: `ops+pools-${seq}@moooon.net` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  session = { user: { id: staff.id } };
  return requirePlatformStaff('support');
}

const awsBlock = (dto: PlatformPoolsDTO, kind = 'ci_runner') => {
  const block = dto.blocks.find((b) => b.fleetKind === kind);
  if (!block || block.provider !== 'aws') throw new Error(`${kind} is not on AWS`);
  return block as Extract<PlatformPoolBlockDTO, { provider: 'aws' }>;
};

/** The section rendered from what the real service returned, as the page passes it. */
async function renderSection(dto: PlatformPoolsDTO): Promise<HTMLElement> {
  const tree = await PoolsSection({ read: { status: 'ok', data: dto }, query: {}, now: NOW });
  document.body.innerHTML = await renderToHtml(tree);
  return document.body;
}

async function renderPage(): Promise<HTMLElement> {
  document.body.innerHTML = await renderToHtml(
    await AdminMonitoringPage({ searchParams: Promise.resolve({}) }),
  );
  return document.body;
}

const block = (root: HTMLElement, kind: string) =>
  root.querySelector<HTMLElement>(`[data-testid="pool-${kind}"]`)!;
const rowOf = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`tr[data-account="${name}"]`)!;
const cells = (tr: HTMLElement) =>
  [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
const vcpu = (n: number) => `${n} vCPU`;

/**
 * The cells of one account row that depend on its granted quota: granted, percent
 * and distance to 70%. Scoped on purpose, so a legitimate zero elsewhere (an
 * empty list's count, a measured use of 0) cannot fail the scan and an unread
 * figure cannot pass it by hiding in a cell nobody looked at.
 */
function quotaCells(tr: HTMLElement): string[] {
  const [, , , granted, , percent, toThreshold] = cells(tr);
  return [granted!, percent!, toThreshold!];
}

/** No digit-only 0, no 0%, no dash, and no vCPU figure standing in for a quota. */
function expectNoNumberFor(tr: HTMLElement) {
  for (const text of quotaCells(tr)) {
    expect(text).not.toMatch(/(^|\D)0(\D|$)/);
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/\d+\s*vCPU/);
    expect(text).not.toMatch(/^[-–—]$/);
  }
}

/** The Fleet section's first card, whichever state it renders in. */
const FLEET = '[data-testid="fleet-orgs"], [data-testid="fleet-disabled"]';

const estateReads = () =>
  adminDb.platformAuditLog.count({ where: { action: 'estate.read', targetKind: 'platform' } });

beforeAll(async () => {
  // Pay the page's module graph once, outside any case's clock.
  await import('@/app/(admin)/admin/monitoring/page');
}, 120_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubGlobal('fetch', fetchGuard);
  fetchGuard.mockClear();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  memberEmails = [];
  session = null;
  ec2Factory.mockClear();
  quotaRead.mockClear();
  setAwsEc2OverrideForTests(ec2Factory as never);
  unregisterProvider = registerShardProvisioningProvider({
    name: 'aws',
    options: [],
    requiredEnv: () => [],
    validate: () => [],
    location: () => {
      throw new Error('the pools read must not provision');
    },
    matchesRow: () => false,
    account: quotaRead as never,
    network: quotaRead as never,
    readQuota: quotaRead as never,
    runtimeCredential: quotaRead as never,
    manualCredentialStep: () => '',
  });
  wireFleetKindSwitch('ci_runner', () => true);
});

afterEach(() => {
  // Neither AWS seam was reached, in any case.
  expect(ec2Factory).not.toHaveBeenCalled();
  expect(quotaRead).not.toHaveBeenCalled();
  wireFleetKindSwitch('ci_runner', null);
  wireFleetKindSwitch('hosted_agent', agentRunnerOnPool);
  setAwsEc2OverrideForTests(null);
  unregisterProvider();
  document.body.innerHTML = '';
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('totals span every workspace', () => {
  // Jobs per account per tenant. The staff caller belongs to none of these.
  const PLAN = {
    'ci-iad-1': [2, 1, 1],
    'ci-iad-2': [1, 2, 0],
  } as const;
  const GRANTED = { 'ci-iad-1': 16, 'ci-iad-2': 32 } as const;
  const expectedUse = (name: keyof typeof PLAN, tenants: readonly number[]) =>
    tenants.reduce((sum, i) => sum + PLAN[name][i]! * VCPU_PER_JOB, 0);

  async function seedThreeWorkspaces() {
    const tenants = [await seedTenant(), await seedTenant(), await seedTenant()];
    const shards = {
      'ci-iad-1': await account('ci-iad-1', { granted: GRANTED['ci-iad-1'] }),
      'ci-iad-2': await account('ci-iad-2', { granted: GRANTED['ci-iad-2'] }),
    };
    for (const name of Object.keys(PLAN) as Array<keyof typeof PLAN>) {
      for (const [i, jobs] of PLAN[name].entries()) {
        for (let j = 0; j < jobs; j += 1) await runningJob(tenants[i]!, shards[name].id);
      }
    }
    return { tenants, shards };
  }

  it('the pool and each account carry every workspace’s use, in the DTO and on the page', async () => {
    const { tenants } = await seedThreeWorkspaces();
    const principal = await seedStaff();
    const all = [0, 1, 2];
    // The three workspaces really are three, and the caller is in none of them.
    expect(new Set(tenants.map((t) => t.workspaceId)).size).toBe(3);
    expect(
      await adminDb.workspaceMembership.count({
        where: { userId: principal.userId, workspaceId: { in: tenants.map((t) => t.workspaceId) } },
      }),
    ).toBe(0);

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    const ci = awsBlock(dto);
    const one = expectedUse('ci-iad-1', all);
    const two = expectedUse('ci-iad-2', all);
    const granted = GRANTED['ci-iad-1'] + GRANTED['ci-iad-2'];
    expect(ci.accounts.map((a) => [a.name, a.usedVcpu])).toEqual([
      ['ci-iad-1', one],
      ['ci-iad-2', two],
    ]);
    expect(ci.pool).toEqual({
      grantedVcpu: granted,
      usedVcpu: one + two,
      percent: Math.round(((one + two) / granted) * 100),
      complete: true,
    });

    const root = await renderSection(dto);
    const total = block(root, 'ci_runner').querySelector('[data-element="pool-total"]')!;
    expect(total.getAttribute('data-complete')).toBe('true');
    expect(total.textContent).toContain(vcpu(granted));
    expect(total.textContent).toContain(vcpu(one + two));
    expect(cells(rowOf(root, 'ci-iad-1'))[4]).toBe(vcpu(one));
    expect(cells(rowOf(root, 'ci-iad-2'))[4]).toBe(vcpu(two));
  });

  it('removing one workspace’s use drops the totals by exactly its share', async () => {
    const { tenants } = await seedThreeWorkspaces();
    const principal = await seedStaff();
    const before = awsBlock(await platformFleetPoolsService.listPools(principal, NOW));

    await adminDb.ciRunnerProvisioningIntent.deleteMany({
      where: { workspaceId: tenants[1]!.workspaceId },
    });
    const after = awsBlock(await platformFleetPoolsService.listPools(principal, NOW));

    const share = expectedUse('ci-iad-1', [1]) + expectedUse('ci-iad-2', [1]);
    expect(share).toBeGreaterThan(0);
    expect(before.pool.usedVcpu - after.pool.usedVcpu).toBe(share);
    expect(after.accounts.map((a) => [a.name, a.usedVcpu])).toEqual([
      ['ci-iad-1', expectedUse('ci-iad-1', [0, 2])],
      ['ci-iad-2', expectedUse('ci-iad-2', [0, 2])],
    ]);
    const root = await renderSection(await platformFleetPoolsService.listPools(principal, NOW));
    expect(
      block(root, 'ci_runner').querySelector('[data-element="pool-total"]')!.textContent,
    ).toContain(vcpu(after.pool.usedVcpu));
  });
});

describe('an unread quota never reaches the page as a number', () => {
  it('a never-read and a failed-after-success quota are null in the DTO and the Not-read mark on the page', async () => {
    const t = await seedTenant();
    const read = await account('ci-read', { granted: 20 });
    const never = await account('ci-never', { granted: null });
    const failed = await account('ci-failed', { granted: null });
    const lastGood = ago(3 * DAY);
    await failLaterRead(failed.id, lastGood);
    for (const shard of [read, never, failed]) await runningJob(t, shard.id);
    const principal = await seedStaff();

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    const ci = awsBlock(dto);
    const byName = Object.fromEntries(ci.accounts.map((a) => [a.name, a]));
    expect(byName['ci-never']).toMatchObject({
      grantedVcpu: null,
      grantedReadAt: null,
      percent: null,
      toThreshold: null,
      overThreshold: false,
    });
    expect(byName['ci-failed']).toMatchObject({
      grantedVcpu: null,
      grantedReadAt: lastGood.toISOString(),
      percent: null,
      toThreshold: null,
    });
    // Use is measured, not read from AWS, so it stays a figure on both.
    expect(byName['ci-never']!.usedVcpu).toBe(VCPU_PER_JOB);
    expect(ci.pool).toMatchObject({ complete: false, percent: null });

    const root = await renderSection(dto);
    for (const [name, readWords] of [
      ['ci-never', p.neverRead],
      ['ci-failed', 'last read 3 d ago'],
    ] as const) {
      const row = rowOf(root, name);
      const mark = row.querySelector('[data-mark="not-read"]')!;
      expect(mark, name).not.toBeNull();
      expect(mark.querySelector('[aria-label]')!.getAttribute('aria-label')).toBe(p.notReadLabel);
      expect(mark.textContent).toBe(`${p.notRead}${readWords}`);
      const [, percent, toThreshold] = quotaCells(row);
      expect(percent).toBe(p.notAvailable);
      expect(toThreshold).toBe(p.notAvailable);
      expectNoNumberFor(row);
    }
    // The read account keeps its figures, so the scan is not vacuous.
    expect(quotaCells(rowOf(root, 'ci-read'))[0]).toContain(vcpu(20));

    // The pool total is not available: no partial capacity sum, no percent.
    const total = block(root, 'ci_runner').querySelector('[data-element="pool-total"]')!;
    expect(total.getAttribute('data-complete')).toBe('false');
    expect(total.textContent).not.toContain(vcpu(20));
    expect(total.textContent).not.toMatch(/\d+\s*%/);
    expect(total.textContent).toContain('2 accounts’ quota is not read, so the total is not known');
    expect([...total.children].map((tile) => tile.firstElementChild!.textContent)).toEqual([
      p.notAvailable,
      vcpu(3 * VCPU_PER_JOB),
      p.notAvailable,
    ]);
  });
});

describe('every kind renders on its own', () => {
  it('a Fly kind shows words only, a throwing kind its own error, and the rest render as usual', async () => {
    const t = await seedTenant();
    const shard = await account('ci-iad-1', { granted: 64 });
    await runningJob(t, shard.id);
    const principal = await seedStaff();
    wireFleetKindSwitch('hosted_agent', () => true);
    const real = fleetPoolStatusService.getPoolStatus.bind(fleetPoolStatusService);
    vi.spyOn(fleetPoolStatusService, 'getPoolStatus').mockImplementation(async (kind, deps) => {
      if (kind === 'hosted_agent') throw new Error('the agent runner read broke');
      return real(kind, deps);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    expect(dto.blocks.map((b) => [b.fleetKind, b.provider])).toEqual([
      ['ci_runner', 'aws'],
      ['hosted_agent', 'unavailable'],
      ['code_graph_index', 'fly'],
      ['agent_instance', 'fly'],
    ]);

    const root = await renderSection(dto);
    const broken = block(root, 'hosted_agent');
    expect(broken.getAttribute('data-state')).toBe('failed');
    expect(broken.textContent).toContain('Couldn’t read the Agent runner pool');
    expect(broken.textContent).not.toContain(p.provider.aws);
    expect(broken.textContent).not.toContain(p.provider.fly);

    const fly = block(root, 'code_graph_index');
    expect(fly.getAttribute('data-state')).toBe('fly');
    expect(fly.textContent).toContain(p.provider.fly);
    expect(fly.querySelector('[data-element="pool-total"]')).toBeNull();
    expect(fly.querySelector('tr[data-account]')).toBeNull();
    expect(fly.textContent).not.toMatch(/\d/);

    expect(block(root, 'ci_runner').getAttribute('data-state')).toBe('aws');
    expect(cells(rowOf(root, 'ci-iad-1'))[4]).toBe(vcpu(VCPU_PER_JOB));
    expect(block(root, 'agent_instance').getAttribute('data-state')).toBe('fly');
  });
});

describe('the spare, the requests and the growth, from real rows', () => {
  it('shows the spare waiting, open before denied, the refusal in AWS’s words and the account over 70%', async () => {
    const t = await seedTenant();
    // 8 granted, 3 jobs: past 70%.
    const hot = await account('ci-hot', { granted: 8 });
    const cool = await account('ci-cool', { granted: 64 });
    for (let i = 0; i < 3; i += 1) await runningJob(t, hot.id);
    const spare = await account('ci-spare', { granted: 5, role: 'spare', state: 'provisioning' });
    await quotaRequest(cool.id, {
      status: 'denied',
      desired: 512,
      createdAt: ago(3 * DAY),
      closedAt: ago(2 * DAY),
    });
    await quotaRequest(spare.id, { status: 'pending', desired: 128, createdAt: ago(10 * DAY) });
    const reason = 'You have exceeded the allowed number of AWS accounts.';
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: hot.id,
        vcpuInUse: 6,
        grantedQuota: 8,
        outcome: 'spare_promoted',
        spareShardId: cool.id,
        createdAt: ago(5 * DAY),
      },
    });
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: 'ci_runner',
        triggeringShardId: cool.id,
        vcpuInUse: 50,
        grantedQuota: 64,
        outcome: 'refused',
        reason,
        createdAt: ago(1 * DAY),
      },
    });
    const principal = await seedStaff();

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    const ci = awsBlock(dto);
    expect(ci.accounts.find((a) => a.name === 'ci-hot')).toMatchObject({ overThreshold: true });
    expect(ci.spares).toEqual([expect.objectContaining({ name: 'ci-spare', ready: false })]);

    const root = await renderSection(dto);
    const hotRow = rowOf(root, 'ci-hot');
    expect(hotRow.getAttribute('data-over')).toBe('true');
    expect(hotRow.querySelector('[data-mark="over"]')!.textContent).toContain(p.over);
    expect(rowOf(root, 'ci-cool').querySelector('[data-mark="over"]')).toBeNull();

    const spareLine = root.querySelector('[data-spare="ci-spare"]')!;
    expect(spareLine.textContent).toContain(p.spare.waiting);
    expect(spareLine.textContent).toContain('A raise to 128 vCPU was asked');

    const requests = [
      ...root.querySelectorAll<HTMLElement>('[data-element="quota-request-list"] tbody tr'),
    ];
    expect(requests.map((tr) => cells(tr)[0])).toEqual(['ci-spare', 'ci-cool']);
    expect(cells(requests[0]!)[2]).toBe(p.requests.status.pending);
    expect(cells(requests[1]!)[2]).toBe(p.requests.status.denied);

    const events = [
      ...root.querySelectorAll<HTMLElement>('[data-element="growth-event-list"] tbody tr'),
    ];
    expect(events).toHaveLength(2);
    expect(events[0]!.textContent).toContain(p.events.outcome.refused);
    expect(events[0]!.textContent).toContain(`AWS said: “${reason}”`);
    expect(events[1]!.textContent).toContain(p.events.outcome.spare_promoted);
  });
});

describe('the rarer rows, from real data (the coverage floor)', () => {
  it('a provisioning account, unread spare times, an unread denial, every growth outcome and a non-Error kind failure', async () => {
    const t = await seedTenant();
    // Granted, but with no recorded read time: a figure, and the never-read words.
    const fresh = await account('ci-fresh', { granted: 16, state: 'provisioning' });
    await adminDb.fleetShard.update({ where: { id: fresh.id }, data: { limitsVerifiedAt: null } });
    const unread = await account('ci-unread', { granted: null });
    await runningJob(t, fresh.id);
    const spare = await account('ci-spare', { granted: 256, role: 'spare' });
    await adminDb.fleetShard.update({ where: { id: spare.id }, data: { limitsVerifiedAt: null } });
    // Denied, never read back, on an account whose own quota is unread.
    seq += 1;
    await adminDb.fleetQuotaRequest.create({
      data: {
        shardId: unread.id,
        fleetKind: 'ci_runner',
        quotaCode: 'L-1216C47A',
        desiredValue: 64,
        awsRequestId: `req-${seq}`,
        status: 'denied',
        grantedValue: null,
        createdAt: ago(2 * DAY),
        lastReadAt: null,
        closedAt: ago(DAY),
      },
    });
    const event = (data: Record<string, unknown>) =>
      adminDb.fleetGrowthEvent.create({
        data: { fleetKind: 'ci_runner', triggeringShardId: fresh.id, vcpuInUse: 12, ...data },
      } as never);
    await event({
      grantedQuota: 16,
      outcome: 'spare_promoted',
      spareShardId: spare.id,
      newShardId: unread.id,
      createdAt: ago(4 * DAY),
    });
    await event({
      grantedQuota: 16,
      outcome: 'account_created',
      newShardId: unread.id,
      createdAt: ago(3 * DAY),
    });
    await event({ grantedQuota: 16, outcome: 'account_created', createdAt: ago(2 * DAY) });
    await event({ grantedQuota: 16, outcome: 'waiting_for_quota', createdAt: ago(DAY) });
    await event({ grantedQuota: 0, outcome: 'refused', createdAt: ago(MIN) });
    const principal = await seedStaff();
    wireFleetKindSwitch('hosted_agent', () => true);
    const real = fleetPoolStatusService.getPoolStatus.bind(fleetPoolStatusService);
    vi.spyOn(fleetPoolStatusService, 'getPoolStatus').mockImplementation(async (kind, deps) => {
      // A rejection that is not an Error still lands in its own block.
      if (kind === 'hosted_agent') throw 'not an Error';
      return real(kind, deps);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    expect(dto.blocks[1]).toEqual({ fleetKind: 'hosted_agent', provider: 'unavailable' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('hosted_agent'), {
      detail: 'unknown',
    });
    const ci = awsBlock(dto);
    expect(ci.requests).toEqual([
      expect.objectContaining({ account: 'ci-unread', status: 'denied', lastReadAt: null }),
    ]);

    const root = await renderSection(dto);
    const freshRow = rowOf(root, 'ci-fresh');
    expect(cells(freshRow)[2]).toBe(p.state.provisioning);
    expect(cells(freshRow)[3]).toBe(`${vcpu(16)}${p.neverRead}`);
    expectNoNumberFor(rowOf(root, 'ci-unread'));

    const spareLine = root.querySelector('[data-spare="ci-spare"]')!;
    expect(spareLine.textContent).toContain(vcpu(256));
    expect(spareLine.textContent).not.toContain('read ');

    const [denied] = [
      ...root.querySelectorAll<HTMLElement>('[data-element="quota-request-list"] tbody tr'),
    ];
    expect(denied!.textContent).toContain(p.requests.notGranted);
    expect(denied!.textContent).toContain(p.requests.quotaUnchanged);
    expect(denied!.textContent).toContain(p.requests.notReadYet);

    const events = [
      ...root.querySelectorAll<HTMLElement>('[data-element="growth-event-list"] tbody tr'),
    ].map((tr) => tr.textContent ?? '');
    expect(events).toHaveLength(5);
    // Newest first: the refusal with no reason and no quota to take a percent of.
    expect(events[0]).toContain(p.events.refusedNote);
    expect(events[0]).not.toContain('AWS said');
    expect(events[0]).not.toMatch(/\d+%/);
    expect(events[1]).toContain(p.events.waiting);
    expect(events[2]).toContain(p.events.outcome.account_created);
    expect(events[2]).not.toContain('added, with no spare');
    expect(events[3]).toContain('ci-unread added, with no spare to promote');
    expect(events[4]).toContain(
      'ci-spare joined the shared pool; new spare ci-unread being created',
    );
  });
});

describe('nothing secret, no email, no AWS, one audit', () => {
  it('the DTO and the markup carry no credential, account id or member email; one estate.read entry', async () => {
    const [a, b, c] = [await seedTenant(), await seedTenant(), await seedTenant()];
    const one = await account('ci-iad-1', { granted: 32 });
    const two = await account('ci-iad-2', { granted: null });
    await account('ci-spare', { granted: 128, role: 'spare' });
    for (const t of [a, b, c]) await runningJob(t, one.id);
    await runningJob(a, two.id);
    await quotaRequest(two.id, { status: 'case_opened', createdAt: ago(DAY) });
    const principal = await seedStaff();
    expect(memberEmails).toHaveLength(6);

    const dto = await platformFleetPoolsService.listPools(principal, NOW);
    expect(await estateReads()).toBe(1);
    const root = await renderSection(dto);

    const json = JSON.stringify(dto);
    const html = root.innerHTML;
    for (const text of [json, html]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCOUNT_PREFIX);
      expect(text).not.toMatch(/credentialRef|awsAccountId|githubInstallationId/);
      // Nothing credential-shaped: no AWS access key id, no ARN.
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}|arn:aws:/);
      expect(text).not.toMatch(/@customer\.test|@moooon\.net/);
      for (const email of [...memberEmails, principal.email]) expect(text).not.toContain(email);
    }
    // Rendering the section is not a second read.
    expect(await estateReads()).toBe(1);
  });
});

describe('the page', () => {
  it.each([
    ['a tenant member', true],
    ['no session', false],
  ] as const)('refuses %s with no Pools read and no audit entry', async (_who, signedIn) => {
    const t = await seedTenant();
    await account('ci-iad-1', { granted: 8 });
    void t;
    if (signedIn) {
      const member = await adminDb.user.findFirstOrThrow({
        where: { email: memberEmails[1] },
      });
      session = { user: { id: member.id } };
    } else {
      session = null;
    }
    const listPools = vi.spyOn(platformFleetPoolsService, 'listPools');

    await expect(AdminMonitoringPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
    expect(listPools).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('a platform admin whose pools read rejects sees the in-card error, and every other section still renders', async () => {
    await seedStaff();
    vi.spyOn(platformFleetPoolsService, 'listPools').mockRejectedValue(new Error('pools down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const root = await renderPage();

    const failed = root.querySelector('[data-testid="pools-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain(p.sectionError.title);
    expect(failed.textContent).toContain(p.sectionError.body);
    expect(root.querySelector('[data-testid^="pool-"]')).toBeNull();
    // The health board, the Index allowance and the Fleet section are all there.
    expect(root.querySelector('h1')!.textContent).toBe(en.platformAdmin.monitoring.title);
    expect(root.textContent).toContain(en.platformAdmin.monitoring.overdue.title);
    // Off-cloud the Fleet section is its one disabled card; on a fleet, its two.
    expect(root.querySelector(FLEET)).not.toBeNull();
    expect(logged).toHaveBeenCalledWith(
      '[admin/monitoring] the fleet pools read failed',
      expect.anything(),
    );
  });

  it('a platform admin sees the Pools section rendered from the real read, after the Fleet section', async () => {
    const t = await seedTenant();
    const shard = await account('ci-iad-1', { granted: 40 });
    await runningJob(t, shard.id);
    await seedStaff();

    const root = await renderPage();

    const section = root.querySelector('[data-testid="pools-section"]')!;
    const fleet = root.querySelector(FLEET)!;
    expect(section).not.toBeNull();
    expect(fleet.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cells(rowOf(root, 'ci-iad-1'))[4]).toBe(vcpu(VCPU_PER_JOB));
    expect(await estateReads()).toBeGreaterThanOrEqual(1);
  });
});
