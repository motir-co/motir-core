import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveBoot, installInlineBootDriver } from '../helpers/agentBootDriver';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import {
  INSTANCE_BOOT_DEADLINE_MS,
  INSTANCE_BOOT_EXIT_GRACE_MS,
  INSTANCE_WORKSPACE_PATH,
} from '@/lib/agentInstances/config';
import { AGENT_IDLE_COMMAND } from '@/lib/agentInstances/terminal';
import { OFFERED_AGENT_PROFILES } from '@/lib/agentInstances/profiles';
import { imageDigestResolver } from '@/lib/agentInstances/imageDigest';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import {
  agentInstanceClock,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { capAgentsAt } from '../helpers/agentPlanCaps';
import { truncateAuthTables } from '../helpers/db';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';

// THE AGENT-INSTANCE LIFECYCLE (Story MOTIR-6860 · MOTIR-6872) — create, wake,
// hibernate and delete over the real services and a real Postgres, with the
// instance fleet on the FAKE persistent orchestrator and motir-ai and GitHub
// stubbed at their HTTP seam (`fetch`), the way the hosted-run suites stub them.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no instance row, no
// fleet slot, no interval, nothing provisioned. A refusal that took a slot or
// booted a machine and then threw would read, from the error alone, exactly like
// one that did none of it.

const AI = 'https://ai.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
}
let calls: Call[] = [];
let mayRun: boolean | 'unanswerable' = true;
/** The org's AI subscription status as motir-ai reports it; `'unanswerable'` is a 503. */
let plan: string | null = 'active';
/** Max ×2 — 10 per person and 50 running, the figures the flat limits had (MOTIR-9374). */
const MAX_X2_TIER = { key: 'max_x2', name: 'Max ×2', monthlyCreditAllotment: 60_000 };
let tokenSeq = 0;

function stubFetch(): void {
  calls = [];
  tokenSeq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, body, authorization: headers['authorization'] ?? null });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        return json(200, { balanceCredits: mayRun ? 100 : 0, mayRun });
      }
      if (url.startsWith(`${AI}/v1/stripe/subscription?`)) {
        if (plan === 'unanswerable') return json(503, { code: 'internal_error' });
        return json(200, {
          status: plan,
          currentPeriodEnd: null,
          priceId: null,
          planTier: MAX_X2_TIER,
        });
      }
      if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
        return json(200, {
          id: 42,
          account: { login: 'acme' },
          permissions: {},
          suspended_at: null,
        });
      }
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        tokenSeq += 1;
        return json(201, { token: `ghs_clone_${tokenSeq}`, expires_at: '2026-09-28T23:00:00Z' });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;
let repoSeq = 0;

async function seedRepo(owner: string, name: string): Promise<void> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(900_000 + repoSeq),
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'connected',
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

/** A second member of the workspace, with a role. */
async function member(role: 'member' | 'viewer' = 'member') {
  const user = await adminDb.user.create({
    data: { name: `M ${role}`, email: `m-${role}-${Date.now()}-${Math.random()}@example.com` },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  if (role === 'viewer') await setWorkspaceRoleFor(user.id, fx.workspaceId, 'viewer');
  return { userId: user.id, workspaceId: fx.workspaceId };
}

const slots = () => adminDb.fleetInFlightSlot.findMany({ where: { workload: 'agent_instance' } });
const instances = () => adminDb.agentInstance.findMany({});
const intervals = () => adminDb.agentInstanceInterval.findMany({ orderBy: { createdAt: 'asc' } });

async function expectNothingStarted(): Promise<void> {
  expect(await instances()).toEqual([]);
  expect(await slots()).toEqual([]);
  expect(await intervals()).toEqual([]);
  expect(fleet.persistentSpecs).toEqual([]);
}

/** A virtual clock: `sleep` advances it, so a bounded wait never waits for real. */
let virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fleet.reset();
  fx = await makeWorkItemFixture();
  mayRun = true;
  plan = 'active';
  _resetAiPlanCache();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stubFetch();
  virtualNow = new Date('2026-09-28T10:00:00.000Z').getTime();
  vi.spyOn(agentInstanceClock, 'now').mockImplementation(() => new Date(virtualNow));
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    virtualNow += ms;
  });
  fleet.setNow(() => new Date(virtualNow));
  installInlineBootDriver();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const create = (name = 'yue-claude', profileId = 'claude', ctx = fx.ctx) =>
  lifecycle.create(KEY(), { name, profileId }, ctx);

describe('create', () => {
  it('pins a digest, provisions machine + volume in the org’s instance app, clones every repository, holds ONE slot, opens ONE interval, ends running', async () => {
    await seedRepo('acme', 'web');
    await seedRepo('acme', 'api');
    const dto = await create();

    expect(dto).toMatchObject({ name: 'yue-claude', profileId: 'claude', state: 'running' });
    expect(dto.imageTag).toBe('ghcr.io/motir-co/motir-sandbox:claude');
    expect(dto.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(fleet.persistentSpecs).toHaveLength(1);
    const spec = fleet.persistentSpecs[0]!;
    expect(spec.image).toBe(`ghcr.io/motir-co/motir-sandbox@${dto.imageDigest}`);
    expect(spec).toMatchObject({
      volumeSizeGb: 10,
      mountPath: '/home/node',
      orgId: fx.workspace.organizationId,
    });
    expect(fleet.appNames()).toEqual([fleet.appNameFor(fx.workspace.organizationId)]);
    expect(fleet.liveVolumeIds()).toHaveLength(1);

    const row = (await instances())[0]!;
    expect(row.machineId).toBeTruthy();
    expect(row.volumeId).toBeTruthy();
    expect(await slots()).toHaveLength(1);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ agentInstanceId: row.id, endedAt: null });
    expect((await slots())[0]!.ownerRef).toBe(interval!.id);

    // One clone exec PER repository (AMENDMENT 6 §1), in the project's order, on
    // ONE token (one installation → one mint).
    expect(fleet.execs.map((e) => e.command.at(-1))).toEqual(['acme/web', 'acme/api']);
    expect(new Set(fleet.execs.map((e) => e.command.at(-2))).size).toBe(1);
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1);
  });

  it('the clone token is READ-scoped and revoked; it is absent from the env, and every remote URL is token-free', async () => {
    await seedRepo('acme', 'web');
    await create();
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(mint.body).toMatchObject({ permissions: { contents: 'read' } });
    expect(
      calls.some(
        (c) =>
          c.url.endsWith('/installation/token') &&
          c.method === 'DELETE' &&
          c.authorization === 'token ghs_clone_1',
      ),
    ).toBe(true);

    // The machine's env carries no credential at all — only which record it is.
    expect(fleet.persistentSpecs[0]!.env).toEqual({
      MOTIR_INSTANCE_ID: (await instances())[0]!.id,
    });

    const command = fleet.execs[0]!.command.join('\n');
    expect(command).toContain('https://github.com/$repo.git');
    expect(command).not.toMatch(/https:\/\/[^@\s]*ghs_/);
    expect(command).not.toContain('ghs_clone_1');
    expect(command).toContain(Buffer.from('x-access-token:ghs_clone_1').toString('base64'));
    expect(command).toContain(INSTANCE_WORKSPACE_PATH);
    expect(fleet.execs[0]!.command.slice(0, 4)).toEqual(['runuser', '-u', 'node', '--']);
  });

  it('a project with no repositories clones nothing and still runs', async () => {
    const dto = await create();
    expect(dto.state).toBe('running');
    expect(fleet.execs).toEqual([]);
    expect(calls.some((c) => c.url.endsWith('/access_tokens'))).toBe(false);
  });

  it('corrects the interval’s start to the machine’s own start instant', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    const row = (await instances())[0]!;
    const opened = (await intervals())[0]!.startedAt;
    virtualNow += 45_000;
    fleet.completeBoot(row.machineId!);
    expect(await driveBoot(row.id)).toBe('running');
    const corrected = (await intervals())[0]!.startedAt;
    expect(corrected.getTime()).toBe(opened.getTime() + 45_000 + 20_000);
    expect(await driveBoot(row.id)).toBe('noop');
  });

  describe('every refusal changes nothing and provisions nothing', () => {
    it('a profile that is not offered', async () => {
      await expect(create('x', 'cursor')).rejects.toThrow(AgentProfileNotOfferedError);
      await expect(create('x', 'antigravity')).rejects.toThrow(/Antigravity isn.t offered/);
      await expectNothingStarted();
      expect(OFFERED_AGENT_PROFILES.map((p) => p.id)).toEqual([
        'claude',
        'codex',
        'opencode',
        'kimi',
        'aider',
        'goose',
      ]);
    });

    it('a malformed name, and a name already taken on this project', async () => {
      await expect(create('Bad Name')).rejects.toThrow(AgentInstanceNameInvalidError);
      await expectNothingStarted();
      await create('taken');
      await expect(create('taken')).rejects.toThrow(AgentInstanceNameTakenError);
      expect(await instances()).toHaveLength(1);
      expect(await slots()).toHaveLength(1);
    });

    it('credits that cannot start a machine — and credits that could not be checked', async () => {
      mayRun = false;
      await expect(create()).rejects.toMatchObject({ reason: 'credits' });
      mayRun = 'unanswerable';
      await expect(create()).rejects.toMatchObject({ reason: 'credits_unknown' });
      await expectNothingStarted();
    });

    it('the org figure is the ORGANISATION’s own: at its plan’s figure in LIVE agents it refuses a create, naming the plan and the limit, and never a wake', async () => {
      capAgentsAt({ perOrg: 2 });
      await create('one');
      const two = await create('two');
      await expect(create('three')).rejects.toMatchObject({
        reason: 'org_cap',
        limit: 2,
        planName: 'Test',
        message:
          'Your organization’s Test plan allows 2 agents in the organization, running or asleep, and it already has that many. Each one is charged for its storage every day, even asleep. Delete one to create another.',
      });
      expect(await instances()).toHaveLength(2);
      expect(await slots()).toHaveLength(2);
      // A hibernated agent still counts: the create stays refused, and its wake is admitted.
      await lifecycle.hibernate(KEY(), two.id, fx.ctx);
      await expect(create('three')).rejects.toMatchObject({ reason: 'org_cap', limit: 2 });
      expect((await lifecycle.wake(KEY(), two.id, fx.ctx)).state).toBe('running');
    });

    it('one organisation at its limit never refuses another — in the same instant, under the admission lock', async () => {
      capAgentsAt({ perOrg: 2 });
      const other = await makeWorkItemFixture({ name: 'Other org', identifier: 'OTHR' });
      const createIn = (name: string, profileId = 'claude') =>
        lifecycle.create(other.projectIdentifier, { name, profileId }, other.ctx);
      await create('one');
      await create('two');
      const [a, b, c] = await Promise.allSettled([
        create('three'),
        createIn('b-one'),
        createIn('b-two', 'codex'),
      ]);
      expect(a).toMatchObject({ status: 'rejected', reason: { reason: 'org_cap' } });
      expect(b).toMatchObject({ status: 'fulfilled', value: { state: 'running' } });
      expect(c).toMatchObject({ status: 'fulfilled', value: { state: 'running' } });
      // …and the other org's own cap holds against its own racing creates.
      const racing = await Promise.allSettled([createIn('b-three'), createIn('b-four')]);
      expect(racing.every((r) => r.status === 'rejected')).toBe(true);
      const byOrg = await adminDb.agentInstance.groupBy({
        by: ['organizationId'],
        _count: { _all: true },
      });
      expect(byOrg.map((g) => g._count._all).sort()).toEqual([2, 2]);
    });

    it('no create is refused as Motir being busy because of other organisations — only the kill switch reads that way', async () => {
      capAgentsAt({ perOrg: 1 });
      const other = await makeWorkItemFixture({ name: 'Other org', identifier: 'OTHR' });
      await lifecycle.create(
        other.projectIdentifier,
        { name: 'b-one', profileId: 'claude' },
        other.ctx,
      );
      expect((await create('one')).state).toBe('running');

      vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
      await expect(create('two')).rejects.toMatchObject({
        reason: 'fleet_busy',
        message: expect.stringContaining('Motir is running as many machines as it can'),
      });
      expect(await instances()).toHaveLength(2);
    });

    it('agents are slotted and counted per workload, never in a shared total', async () => {
      await create('one');
      await create('two');
      expect(await slots()).toHaveLength(2);
      const census = await withSystemContext((tx) => fleetCeilingService.census(new Date(), tx));
      expect(census.byWorkload.agent_instance).toBe(2);
      expect(census.total).toBe(0);
    });

    it('the ten-per-user cap', async () => {
      for (let i = 0; i < 10; i++) {
        await adminDb.agentInstance.create({
          data: {
            workspaceId: fx.workspaceId,
            organizationId: fx.workspace.organizationId,
            projectId: fx.projectId,
            ownerId: fx.ownerId,
            name: `old-${i}`,
            profileId: 'claude',
            imageTag: 't',
            imageDigest: 'sha256:x',
            region: 'iad',
            state: 'hibernated',
          },
        });
      }
      await expect(create()).rejects.toMatchObject({ reason: 'user_cap' });
      expect(await slots()).toEqual([]);
      expect(fleet.persistentSpecs).toEqual([]);
    });

    it('no permission — a viewer is refused `instance:use`', async () => {
      const viewer = await member('viewer');
      await expect(create('v', 'claude', viewer)).rejects.toThrow(PermissionDeniedError);
      await expectNothingStarted();
    });
  });

  it('a provider failure mid-create leaves the instance failed with its reason, no slot, no machine', async () => {
    fleet.failNextMachineCreate('no capacity in iad');
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect(dto.failureReason).toMatch(/no capacity in iad/);
    expect(await slots()).toEqual([]);
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'lost', billableSeconds: 0 });
  });

  it('a clone that fails fails the instance with the reason', async () => {
    await seedRepo('acme', 'web');
    fleet.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' });
    const dto = await create();
    expect(dto).toMatchObject({ state: 'failed' });
    expect(dto.failureReason).toMatch(/repository not found/);
    expect(await slots()).toEqual([]);
  });

  it('a digest the registry cannot resolve refuses before anything is taken', async () => {
    vi.spyOn(imageDigestResolver, 'resolve').mockRejectedValueOnce(new Error('ghcr down'));
    await expect(create()).rejects.toThrow(/ghcr down/);
    await expectNothingStarted();
  });
});

describe('a paid AI plan comes first (MOTIR-6918, agent-instance-storage.md §1)', () => {
  const asked = (path: string) => calls.filter((c) => c.url.includes(path));

  /** Motir's own organisations, flagged on their own row. */
  const flagOrg = (data: { isMeta?: boolean; internalBilling?: boolean }) =>
    adminDb.organization.update({ where: { id: fx.workspace.organizationId }, data });

  it('an org without a paid plan is refused `ai_plan_required` at create — before the per-user cap, the credits or Fly', async () => {
    for (const status of [null, 'trialing', 'canceled']) {
      _resetAiPlanCache();
      plan = status;
      calls = [];
      await expect(create()).rejects.toMatchObject({
        reason: 'ai_plan_required',
        message: expect.stringContaining('Agents need a paid AI plan'),
      });
      expect(asked('agent-run-check')).toEqual([]);
    }
    await expectNothingStarted();
    expect(fleet.operations).toEqual([]);
  });

  it('an org without a paid plan is refused at the ten-per-user cap too: the plan is asked first', async () => {
    for (let i = 0; i < 10; i++) {
      await adminDb.agentInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          organizationId: fx.workspace.organizationId,
          projectId: fx.projectId,
          ownerId: fx.ownerId,
          name: `seeded-${i}`,
          profileId: 'claude',
          imageTag: 't',
          imageDigest: 'sha256:x',
          region: 'iad',
          state: 'hibernated',
        },
      });
    }
    plan = 'canceled';
    await expect(create()).rejects.toMatchObject({ reason: 'ai_plan_required' });
  });

  it('a plan that cannot be read refuses `ai_plan_unknown` (fail closed), asking nothing further', async () => {
    plan = 'unanswerable';
    await expect(create()).rejects.toMatchObject({
      reason: 'ai_plan_unknown',
      message: expect.stringContaining('could not check your organization’s AI plan'),
    });
    expect(asked('agent-run-check')).toEqual([]);
    await expectNothingStarted();
  });

  it('a wake is refused the same way, before the credit check: the agent stays hibernated', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const opsBefore = fleet.operations.length;
    for (const [status, reason] of [
      ['canceled', 'ai_plan_required'],
      ['unanswerable', 'ai_plan_unknown'],
    ] as const) {
      _resetAiPlanCache();
      plan = status;
      calls = [];
      await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toMatchObject({ reason });
      expect(asked('agent-run-check')).toEqual([]);
    }
    expect((await instances())[0]!.state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    expect(await intervals()).toHaveLength(1);
    expect(fleet.operations).toHaveLength(opsBefore);
  });

  it('a paid org (active or past_due) proceeds to the credit check and boots', async () => {
    plan = 'past_due';
    const dto = await create('paid-one');
    expect(dto.state).toBe('running');
    expect(asked('agent-run-check')).toHaveLength(1);
  });

  it('the meta org and an internal org pass without asking motir-ai for a plan — even while it is unreachable', async () => {
    plan = 'unanswerable';
    await flagOrg({ isMeta: true });
    expect((await create('meta-one')).state).toBe('running');
    _resetAiPlanCache();
    await flagOrg({ isMeta: false, internalBilling: true });
    const dto = await create('internal-one');
    expect(dto.state).toBe('running');
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await lifecycle.wake(KEY(), dto.id, fx.ctx)).state).toBe('running');
    expect(asked('/v1/stripe/subscription')).toEqual([]);
  });

  it('a self-hosted build checks no plan', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    plan = 'unanswerable';
    expect((await create('self-hosted')).state).toBe('running');
    expect(asked('/v1/stripe/subscription')).toEqual([]);
  });
});

describe('Motir’s own organisations have no agent limits (AMENDMENT 3, MOTIR-6926)', () => {
  const seedLive = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await adminDb.agentInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          organizationId: fx.workspace.organizationId,
          projectId: fx.projectId,
          ownerId: fx.ownerId,
          name: `old-${i}`,
          profileId: 'claude',
          imageTag: 't',
          imageDigest: 'sha256:x',
          region: 'iad',
          state: 'hibernated',
        },
      });
    }
  };

  for (const flag of ['isMeta', 'internalBilling'] as const) {
    it(`an ${flag} org runs past the running cap, makes an 11th agent for one person, and creates and wakes at zero credits`, async () => {
      await adminDb.organization.update({
        where: { id: fx.workspace.organizationId },
        data: { [flag]: true },
      });
      capAgentsAt({ perOrg: 1 });
      mayRun = false;
      await seedLive(10);
      const first = await create('one');
      const second = await create('two');
      expect([first.state, second.state]).toEqual(['running', 'running']);
      await lifecycle.hibernate(KEY(), first.id, fx.ctx);
      expect((await lifecycle.wake(KEY(), first.id, fx.ctx)).state).toBe('running');
      expect(await instances()).toHaveLength(12);
      // The credit gate is skipped, never asked and overruled.
      expect(calls.filter((c) => c.url.endsWith('/v1/credits/agent-run-check'))).toEqual([]);
    });
  }

  it('an org with neither flag is limited exactly as before — per person, by credits, and by its own running cap', async () => {
    await seedLive(10);
    await expect(create()).rejects.toMatchObject({ reason: 'user_cap' });
    await adminDb.agentInstance.deleteMany({});
    mayRun = false;
    await expect(create()).rejects.toMatchObject({ reason: 'credits' });
    mayRun = true;
    capAgentsAt({ perOrg: 1 });
    await create('one');
    await expect(create('two')).rejects.toMatchObject({ reason: 'org_cap', limit: 1 });
  });
});

describe('hibernate, wake and delete', () => {
  it('hibernate from running stops the machine, closes the ONE interval at the stop instant and releases the slot', async () => {
    const dto = await create();
    virtualNow += 90_000;
    const after = await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect(after.state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'hibernated', chargeOutcome: 'pending' });
    expect(interval!.billableSeconds).toBe(90);
    expect(fleet.liveVolumeIds()).toHaveLength(1);
    // The wrong-state call is refused.
    await expect(lifecycle.hibernate(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
  });

  it('wake from hibernated starts the machine (a cold boot), takes a slot and opens exactly one new interval', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('running');
    expect(await slots()).toHaveLength(1);
    const all = await intervals();
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.endedAt === null)).toHaveLength(1);
    expect((await slots())[0]!.ownerRef).toBe(all[1]!.id);
    // No re-clone on a wake.
    expect(fleet.operations.filter((o) => o.startsWith('machine:exec'))).toEqual([]);
    await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
  });

  it('a wake the credits refuse changes nothing', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    mayRun = false;
    await expect(lifecycle.wake(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStartRefusedError,
    );
    expect((await instances())[0]!.state).toBe('hibernated');
    expect(await slots()).toEqual([]);
    expect(await intervals()).toHaveLength(1);
  });

  it('a start that fails leaves the instance failed, and a failed instance can be woken', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.failNextStart();
    const failed = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toMatch(/could not start/);
    expect(await slots()).toEqual([]);
    const again = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(again).toMatchObject({ state: 'running', failureReason: null });
  });

  it('TWO CONCURRENT WAKES start one machine and open one interval', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const results = await Promise.allSettled([
      lifecycle.wake(KEY(), dto.id, fx.ctx),
      lifecycle.wake(KEY(), dto.id, fx.ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentInstanceStateConflictError);
    expect(fleet.operations.filter((o) => o.startsWith('machine:start'))).toHaveLength(1);
    expect((await intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
    expect(await slots()).toHaveLength(1);
  });

  describe('two concurrent wakes, forced in order — the slot is the WINNER’s (MOTIR-7492)', () => {
    /**
     * Hold each wake right after its fleet reserve returns, so a case can decide
     * which wake reserves the slot and which one wins the move to `waking`. The
     * first caller RESERVES; every later one finds the slot `already_held`.
     */
    function gateReserves() {
      const reserved: Array<() => void> = [];
      const holds: Array<() => void> = [];
      const reservedAt = [0, 1].map((i) => new Promise<void>((r) => (reserved[i] = r)));
      const gates = [0, 1].map((i) => new Promise<void>((r) => (holds[i] = r)));
      const original = fleetCeilingService.reserve.bind(fleetCeilingService);
      let calls = 0;
      vi.spyOn(fleetCeilingService, 'reserve').mockImplementation(async (req, now) => {
        const n = calls++;
        const verdict = await original(req, now);
        if (n < 2) {
          reserved[n]!();
          await gates[n];
        }
        return verdict;
      });
      return { reservedAt, release: (i: number) => holds[i]!() };
    }

    async function expectOneSlotOwnedByTheOpenRun(): Promise<void> {
      expect((await instances())[0]!.state).toBe('running');
      const open = (await intervals()).filter((i) => i.endedAt === null);
      expect(open).toHaveLength(1);
      const held = await slots();
      expect(held).toHaveLength(1);
      expect(held[0]!.ownerRef).toBe(open[0]!.runId);
    }

    async function expectHibernateReleasesIt(id: string): Promise<void> {
      const warn = vi.spyOn(console, 'warn');
      await lifecycle.hibernate(KEY(), id, fx.ctx);
      expect(await slots()).toEqual([]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('removed no row'))).toEqual([]);
    }

    it('the wake that RESERVED loses the move: the winner adopts the slot, the loser’s release removes nothing', async () => {
      const dto = await create();
      await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
      const gate = gateReserves();

      const a = lifecycle.wake(KEY(), dto.id, fx.ctx);
      await gate.reservedAt[0];
      const b = lifecycle.wake(KEY(), dto.id, fx.ctx);
      await gate.reservedAt[1];
      gate.release(1);
      await expect(b).resolves.toMatchObject({ state: 'running' });
      gate.release(0);
      await expect(a).rejects.toThrow(AgentInstanceStateConflictError);

      expect(fleet.operations.filter((o) => o.startsWith('machine:start'))).toHaveLength(1);
      await expectOneSlotOwnedByTheOpenRun();
      await expectHibernateReleasesIt(dto.id);
    });

    it('the wake that RESERVED also wins the move: the slot stays its own', async () => {
      const dto = await create();
      await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
      const gate = gateReserves();

      const a = lifecycle.wake(KEY(), dto.id, fx.ctx);
      await gate.reservedAt[0];
      const b = lifecycle.wake(KEY(), dto.id, fx.ctx);
      await gate.reservedAt[1];
      gate.release(0);
      await expect(a).resolves.toMatchObject({ state: 'running' });
      gate.release(1);
      await expect(b).rejects.toThrow(AgentInstanceStateConflictError);

      expect(fleet.operations.filter((o) => o.startsWith('machine:start'))).toHaveLength(1);
      await expectOneSlotOwnedByTheOpenRun();
      await expectHibernateReleasesIt(dto.id);
    });
  });

  it('delete destroys the machine then the volume, closes the open interval, releases the slot, and drops it from the list', async () => {
    const dto = await create();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    const ops = fleet.operations;
    expect(ops.indexOf(`machine:destroy:${(await instances())[0]!.machineId}`)).toBeLessThan(
      ops.findIndex((o) => o.startsWith('volume:destroy')),
    );
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    expect(await slots()).toEqual([]);
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
    expect((await instances())[0]!.deletedAt).not.toBeNull();
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).total).toBe(0);
    // The name is free again.
    await expect(create()).resolves.toMatchObject({ state: 'running' });
  });

  it('a destroy that fails leaves the instance deleting for the sweep to retry', async () => {
    const dto = await create();
    fleet.failNextDestroy();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    expect((await instances())[0]).toMatchObject({ state: 'deleting', deletedAt: null });
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect(await lifecycle.settleDelete(dto.id)).toBe('noop');
  });
});

function handleFor(a: {
  flyApp: string | null;
  machineId: string | null;
  volumeId: string | null;
}) {
  return {
    provider: 'fake' as const,
    app: a.flyApp!,
    machineId: a.machineId!,
    volumeId: a.volumeId!,
    region: 'iad',
    createdAt: new Date(),
  };
}

describe('a boot that ends in a stopped machine always ends (MOTIR-7336)', () => {
  /** The interval a failed boot closed, and the slot it released. */
  async function expectFailedBoot(reason: RegExp): Promise<void> {
    const row = (await instances())[0]!;
    expect(row.state).toBe('failed');
    expect(row.failureReason).toMatch(reason);
    expect((await intervals()).filter((i) => i.endedAt === null)).toEqual([]);
    expect((await intervals()).at(-1)).toMatchObject({ endReason: 'lost' });
    expect(await slots()).toEqual([]);
  }

  it('a CREATE whose machine exits cleanly (code 0) while starting ends failed, naming the exit code', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    const row = (await instances())[0]!;
    virtualNow += 30_000;
    fleet.exitOutside(row.machineId!, 0);
    expect(await driveBoot(row.id)).toBe('failed');
    await expectFailedBoot(
      /exited during boot \(exit code 0\)\. Wake to try again, or delete it\./,
    );
    expect(await driveBoot(row.id)).toBe('noop');
  });

  it('a WAKE whose machine exits cleanly while waking ends failed the same way', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.setBootBehaviour('never_start');
    virtualNow += 60_000;
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('waking');
    fleet.exitOutside((await instances())[0]!.machineId!, 0);
    expect(await driveBoot(dto.id)).toBe('failed');
    await expectFailedBoot(/exited during boot \(exit code 0\)/);
    // The owner can act on it: a failed agent wakes again.
    fleet.setBootBehaviour('start');
    expect((await lifecycle.wake(KEY(), dto.id, fx.ctx)).state).toBe('running');
  });

  it('a non-zero exit waits out the restart grace — a restart that comes in time boots normally', async () => {
    fleet.setBootBehaviour('never_start');
    await create();
    const row = (await instances())[0]!;
    fleet.exitOutside(row.machineId!, 1);
    expect(await driveBoot(row.id)).toBe('pending');
    virtualNow += INSTANCE_BOOT_EXIT_GRACE_MS - 1_000;
    expect(await driveBoot(row.id)).toBe('pending');
    // Fly's on-failure restart brings it up.
    await fleet.start(handleFor(row));
    fleet.completeBoot(row.machineId!);
    expect(await driveBoot(row.id)).toBe('running');
  });

  it('a non-zero exit nobody restarts ends failed once the grace has passed', async () => {
    fleet.setBootBehaviour('never_start');
    await create();
    const row = (await instances())[0]!;
    fleet.exitOutside(row.machineId!, 137);
    virtualNow += INSTANCE_BOOT_EXIT_GRACE_MS;
    expect(await driveBoot(row.id)).toBe('failed');
    await expectFailedBoot(/exited during boot \(exit code 137\)/);
  });

  it('a wake that still reads the HIBERNATION stop is not failed for it — the start has not taken yet', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    virtualNow += 3_600_000;
    // The state a wake leaves before Fly has acted on its start: waking, the
    // machine still stopped since the hibernate an hour ago.
    // Staged in the database, so no attempt is open: the sweep's backstop opens
    // one, and the driver's passes leave the agent waking.
    await adminDb.agentInstance.update({
      where: { id: dto.id },
      data: { state: 'waking', stateChangedAt: new Date(virtualNow) },
    });
    expect(await lifecycle.resumeBoot(dto.id)).toBe('opened');
    expect(await driveBoot(dto.id)).toBe('pending');
    expect((await instances())[0]!.state).toBe('waking');
  });

  it('a boot that never reaches running ends failed at the deadline — no agent sits starting forever', async () => {
    fleet.setBootBehaviour('never_start');
    await create();
    const row = (await instances())[0]!;
    const began = row.stateChangedAt.getTime();
    virtualNow = began + INSTANCE_BOOT_DEADLINE_MS - 1_000;
    expect(await driveBoot(row.id)).toBe('pending');
    virtualNow = began + INSTANCE_BOOT_DEADLINE_MS;
    expect(await driveBoot(row.id)).toBe('failed');
    await expectFailedBoot(/did not finish starting within 10 minutes/);
  });

  it('the DRIVER fails such a boot and logs one lifecycle line: the instance, the provider state and the exit code — no credential', async () => {
    fleet.setBootBehaviour('never_start');
    await create();
    const row = (await instances())[0]!;
    fleet.exitOutside(row.machineId!, 0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await driveBoot(row.id)).toBe('failed');
    await expectFailedBoot(/exit code 0/);
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('boot failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({
      instanceId: row.id,
      attempt: 1,
      state: 'starting',
      step: 'machine_start',
      repository: null,
      providerState: 'stopped',
      exitCode: 0,
      reason: expect.stringMatching(/exit code 0/),
    });
    expect(JSON.stringify(lines[0])).not.toMatch(/ghs_|token|key/i);
  });
});

describe('the machine’s main process (MOTIR-7336, agent-terminal.md Q4)', () => {
  it('with the terminal OFF (no MOTIR_TERMINAL_MASTER_KEY) the machine idles instead of exiting', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    await create();
    const spec = fleet.persistentSpecs[0]!;
    expect(spec.terminal).toBeNull();
    expect(spec.idleCommand).toEqual(['sleep', 'infinity']);
    expect(AGENT_IDLE_COMMAND).toEqual(['sleep', 'infinity']);
  });
});

// MOTIR-7341 (AMENDMENT 4): a boot or a stop that never settles must still be
// deletable. Each case leaves the agent stuck the way production did, deletes it,
// and holds the delete to the ordinary one's outcome: machine and volume gone,
// the interval closed `deleted`, the slot free, the row gone from the list.
describe('delete from a boot or a stop that has not settled (AMENDMENT 4)', () => {
  async function expectFullyDeleted(id: string): Promise<void> {
    const row = (await instances()).find((r) => r.id === id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(fleet.liveMachineIds()).toEqual([]);
    expect(fleet.liveVolumeIds()).toEqual([]);
    expect(await slots()).toEqual([]);
    const open = (await intervals()).filter((i) => i.endedAt === null);
    expect(open).toEqual([]);
    expect((await intervals()).at(-1)).toMatchObject({ endReason: 'deleted' });
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).total).toBe(0);
  }

  it('an agent stuck `starting` is deleted', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    expect(await slots()).toHaveLength(1);
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    await expectFullyDeleted(dto.id);
  });

  it('an agent stuck `starting` on a machine that already STOPPED is deleted (MOTIR-7336’s shape)', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    const row = (await instances())[0]!;
    fleet.stopOutside(row.machineId!);
    // The boot settle reads a stopped machine as still booting — the stuck agent.
    expect(await driveBoot(dto.id)).toBe('pending');
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    await expectFullyDeleted(dto.id);
  });

  it('an agent stuck `waking` is deleted', async () => {
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.setBootBehaviour('never_start');
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('waking');
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    await expectFullyDeleted(dto.id);
  });

  it('an agent stuck `hibernating` is deleted', async () => {
    const dto = await create();
    fleet.failNextStop();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await instances())[0]!.state).toBe('hibernating');
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    await expectFullyDeleted(dto.id);
  });

  it('the sweep’s plan-lapse delete no longer skips a mid-boot agent', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(await lifecycle.beginDelete(dto.id)).toBe(true);
    await expectFullyDeleted(dto.id);
  });

  it('an `updating` agent is still refused (agent-image-update.md Q6), and nothing moves', async () => {
    const dto = await create();
    await adminDb.agentInstance.update({ where: { id: dto.id }, data: { state: 'updating' } });
    await expect(lifecycle.delete(KEY(), dto.id, fx.ctx)).rejects.toThrow(
      AgentInstanceStateConflictError,
    );
    expect((await instances())[0]).toMatchObject({ state: 'updating', deletedAt: null });
    expect(fleet.liveMachineIds()).toHaveLength(1);
    expect(await slots()).toHaveLength(1);
  });
});

// One winner (AMENDMENT 4 §2), against the real database: a settle that runs
// after the delete's guarded move loses its own compare-and-set and changes
// nothing. The delete's destroy is made to fail so the row stays `deleting` and
// the late settle has a live machine to read.
describe('a settle after a delete has begun changes nothing', () => {
  async function stuckBootThenDeleting(): Promise<{ id: string; machineId: string }> {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    const machineId = (await instances())[0]!.machineId!;
    fleet.failNextDestroy();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    expect((await instances())[0]).toMatchObject({ state: 'deleting', deletedAt: null });
    return { id: dto.id, machineId };
  }

  it('a boot that finishes after the delete began does not move the agent to running', async () => {
    const { id, machineId } = await stuckBootThenDeleting();
    fleet.completeBoot(machineId);
    expect(await driveBoot(id)).toBe('noop');
    expect((await instances())[0]!.state).toBe('deleting');
    expect(await lifecycle.settleDelete(id)).toBe('deleted');
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
  });

  it('a boot settle already IN FLIGHT when the delete lands loses its move', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    const machineId = (await instances())[0]!.machineId!;
    fleet.completeBoot(machineId);
    // The settle reads `starting`, then the owner's delete commits before it moves.
    const real = fleet.describePersistent.bind(fleet);
    vi.spyOn(fleet, 'describePersistent').mockImplementationOnce(async (handle) => {
      fleet.failNextDestroy();
      await lifecycle.delete(KEY(), dto.id, fx.ctx);
      return real(handle);
    });
    expect(await driveBoot(dto.id)).toBe('noop');
    expect((await instances())[0]!.state).toBe('deleting');
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect(await intervals()).toHaveLength(1);
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
  });

  it('a boot settle in flight that finds the machine gone loses its fail move and closes nothing', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    const real = fleet.describePersistent.bind(fleet);
    vi.spyOn(fleet, 'describePersistent').mockImplementationOnce(async (handle) => {
      fleet.failNextDestroy();
      await lifecycle.delete(KEY(), dto.id, fx.ctx);
      return { ...(await real(handle)), state: 'gone' };
    });
    expect(await driveBoot(dto.id)).toBe('noop');
    expect((await instances())[0]).toMatchObject({ state: 'deleting', failureReason: null });
    expect((await intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
    expect(await slots()).toEqual([]);
  });

  it('a stop that lands after the delete began does not move the agent to hibernated or close the interval', async () => {
    const dto = await create();
    fleet.failNextStop();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const machineId = (await instances())[0]!.machineId!;
    fleet.failNextDestroy();
    await lifecycle.delete(KEY(), dto.id, fx.ctx);
    fleet.stopOutside(machineId);
    expect(await lifecycle.settleStop(dto.id)).toBe('noop');
    expect((await instances())[0]!.state).toBe('deleting');
    expect((await intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
  });

  it('a stop settle in flight when the delete lands loses its move and closes nothing', async () => {
    const dto = await create();
    fleet.failNextStop();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const machineId = (await instances())[0]!.machineId!;
    fleet.stopOutside(machineId);
    const real = fleet.describePersistent.bind(fleet);
    vi.spyOn(fleet, 'describePersistent').mockImplementationOnce(async (handle) => {
      fleet.failNextDestroy();
      await lifecycle.delete(KEY(), dto.id, fx.ctx);
      return real(handle);
    });
    expect(await lifecycle.settleStop(dto.id)).toBe('noop');
    expect((await instances())[0]!.state).toBe('deleting');
    expect((await intervals()).filter((i) => i.endedAt === null)).toHaveLength(1);
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect((await intervals())[0]).toMatchObject({ endReason: 'deleted' });
  });
});

describe('a failed agent’s machine is stopped (MOTIR-7343)', () => {
  // `failed` is a RESTING state, like `hibernated`: its interval is closed `lost`
  // and its slot released, so nobody is charged for its machine. A move to it
  // that left the machine running leaked that machine to the attribution
  // reconciler, which stopped it unbilled 10 minutes later — in production, after
  // a clone cut off by the 30-second exec timeout (MOTIR-7405).
  const machineState = async () => {
    const row = (await instances())[0]!;
    return (await fleet.describePersistent(handleFor(row))).state;
  };

  it('a clone that fails on a RUNNING machine stops it', async () => {
    await seedRepo('acme', 'web');
    fleet.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' });
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect(await machineState()).toBe('stopped');
    // Stopped, never destroyed: the home volume is kept and the agent wakes again.
    expect(fleet.liveVolumeIds()).toHaveLength(1);
    expect((await lifecycle.wake(KEY(), dto.id, fx.ctx)).state).toBe('running');
  });

  it('a boot failed at the deadline stops a machine that may still come up', async () => {
    fleet.setBootBehaviour('never_start');
    await create();
    const row = (await instances())[0]!;
    virtualNow = row.stateChangedAt.getTime() + INSTANCE_BOOT_DEADLINE_MS;
    expect(await driveBoot(row.id)).toBe('failed');
    expect(await machineState()).toBe('stopped');
  });

  it('a machine the sweep finds failed under a running agent is stopped', async () => {
    const dto = await create();
    vi.spyOn(fleet, 'describePersistent').mockResolvedValueOnce({
      machineId: (await instances())[0]!.machineId!,
      state: 'failed',
      providerState: 'failed',
      startedAt: null,
      stoppedAt: null,
      events: [],
    });
    expect(await lifecycle.reconcileRunning(dto.id)).toBe('failed');
    vi.mocked(fleet.describePersistent).mockRestore();
    expect(await machineState()).toBe('stopped');
  });

  it('a stop the provider refuses still fails the agent, and is logged', async () => {
    await seedRepo('acme', 'web');
    fleet.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' });
    fleet.failNextStop('fly said no');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect(dto.failureReason).toMatch(/repository not found/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('stop after failure failed'))).toBe(
      true,
    );
  });

  it('a create whose machine was never made fails without asking the provider to stop anything', async () => {
    fleet.failNextMachineCreate('no capacity in iad');
    const stop = vi.spyOn(fleet, 'stop');
    expect((await create()).state).toBe('failed');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('owner isolation (§8)', () => {
  it('another member cannot list, wake, hibernate or delete my instance — even on the same project', async () => {
    const dto = await create();
    const other = await member('member');
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, other)).instances).toEqual([]);
    await expect(lifecycle.hibernate(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    await expect(lifecycle.wake(KEY(), dto.id, other)).rejects.toThrow(AgentInstanceNotFoundError);
    await expect(lifecycle.delete(KEY(), dto.id, other)).rejects.toThrow(
      AgentInstanceNotFoundError,
    );
    expect((await instances())[0]!.state).toBe('running');
    // …and a member may hold their own, several per project.
    await lifecycle.create(KEY(), { name: 'mine-1', profileId: 'codex' }, other);
    await lifecycle.create(KEY(), { name: 'mine-2', profileId: 'goose' }, other);
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, other)).total).toBe(2);
  });
});

describe('list', () => {
  it('pages the caller’s own instances with a total, and reports machine time and credits this month', async () => {
    const a = await create('a');
    virtualNow += 150_000;
    await lifecycle.hibernate(KEY(), a.id, fx.ctx);
    await create('b');
    const page1 = await lifecycle.list(KEY(), { take: 1, skip: 0 }, fx.ctx);
    const page2 = await lifecycle.list(KEY(), { take: 1, skip: 1 }, fx.ctx);
    expect(page1.total).toBe(2);
    expect([...page1.instances, ...page2.instances].map((i) => i.name).sort()).toEqual(['a', 'b']);
    const rowA = [...page1.instances, ...page2.instances].find((i) => i.name === 'a')!;
    expect(rowA).toMatchObject({
      profileName: 'Claude Code',
      machineSecondsThisMonth: 150,
      creditsThisMonth: 3,
      // The person hibernated it themselves: no line to explain.
      stopReason: null,
    });
  });

  it('says why Motir stopped a hibernated agent — credits, idle or the 12 hours — and nothing else', async () => {
    const a = await create('a');
    const b = await create('b');
    const c = await create('c');
    await lifecycle.beginHibernate(a.id, 'credits');
    await lifecycle.beginHibernate(b.id, 'idle');
    await lifecycle.settleStop(a.id, 'credits');
    await lifecycle.settleStop(b.id, 'idle');
    const rows = (await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx)).instances;
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get('a')).toMatchObject({ state: 'hibernated', stopReason: 'credits' });
    expect(byName.get('b')).toMatchObject({ state: 'hibernated', stopReason: 'idle' });
    // A running agent has nothing to explain.
    expect(byName.get('c')).toMatchObject({ state: 'running', stopReason: null });
    expect(c.id).toBeTruthy();
  });

  it('touchActivity bumps the idle signal', async () => {
    const dto = await create();
    virtualNow += 60_000;
    await lifecycle.touchActivity(dto.id);
    expect((await instances())[0]!.lastActivityAt.getTime()).toBe(virtualNow);
  });
});
