import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { adminDb } from '../helpers/adminDb';
import { randomInt, randomToken } from '../helpers/random';

// THE ORG FLEET READ, against real Postgres: for an owner or an admin, every
// part of what the org runs on the fleet, keyed to that org alone (two seeded
// orgs, both directions); the gate refuses before any read; each part fails to
// its own `not_read`; Motir's stops cover seven days, newest first; and the
// serialised answer carries no organisation, account, shard, machine, volume,
// region, app or user id — by key or by value. motir-ai's subscription read and
// Sentry are the stubbed seams; the kind switches are wired off, as
// `fleetUseService.test.ts` wires them.

const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { orgFleetService } = await import('@/lib/services/orgFleetService');
const { fleetUseService } = await import('@/lib/services/fleetUseService');
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
const { ciRunnerProvisioningIntentRepository } =
  await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
const { fleetInFlightSlotRepository } =
  await import('@/lib/repositories/fleetInFlightSlotRepository');
const { fleetMachineKillRepository } =
  await import('@/lib/repositories/fleetMachineKillRepository');
const { _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { wireFleetKindSwitch } = await import('@/lib/ciFleet/shardTargets');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { makeWorkItemFixture, createTestWorkItem } = await import('../fixtures/workItemFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-11-04T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60 * 60_000);
const DAY = 24 * 60 * 60_000;
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'code_graph_index',
  'hosted_agent',
  'agent_instance',
];

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;

interface Org {
  fx: Fixture;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  owner: { id: string; email: string };
  admin: { id: string; email: string };
  member: { id: string; email: string; name: string };
  /** Every id and secret seeded for this org that must never leave. */
  secrets: string[];
  /** What a correct read of this org names. */
  marks: { runIds: string[]; instanceIds: string[]; intentIds: string[]; cardTitle: string };
}

let seq = 0;

async function makeOrg(label: string): Promise<Org> {
  const fx = await makeWorkItemFixture({
    name: `Fleet ${label}`,
    identifier: `F${label}${randomInt(10, 100)}`,
  });
  const projectName = `Project ${label}`;
  await adminDb.project.update({ where: { id: fx.projectId }, data: { name: projectName } });
  const organizationId = fx.workspace.organizationId;
  const admin = await createTestUser({ name: `Admin ${label}` });
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: fx.ownerId,
  });
  const memberName = `Member ${label}`;
  const member = await createTestUser({ name: memberName });
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: fx.ownerId,
  });
  return {
    fx,
    organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    projectName,
    owner: { id: fx.owner.id, email: fx.owner.email },
    admin: { id: admin.id, email: admin.email },
    member: { id: member.id, email: member.email, name: memberName },
    secrets: [
      organizationId,
      fx.workspaceId,
      fx.projectId,
      fx.owner.id,
      fx.owner.email,
      admin.id,
      admin.email,
      member.id,
      member.email,
    ],
    marks: { runIds: [], instanceIds: [], intentIds: [], cardTitle: `Card of ${label}` },
  };
}

/** A live hosted run: the run row and the fleet slot its container holds. */
async function hostedRun(org: Org, options: { scoped: boolean; startedAt: Date }) {
  const scope = options.scoped
    ? await createTestWorkItem(org.fx, { kind: 'task', title: org.marks.cardTitle })
    : null;
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: org.workspaceId,
      projectId: org.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: org.member.id,
      scopeWorkItemId: scope?.id ?? null,
      startedAt: options.startedAt,
    },
  });
  const ref = hostedRunDispatchId(run.id);
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref,
      ownerRef: ref,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      expiresAt: LATER,
    },
  });
  org.marks.runIds.push(run.id);
  return { run, scope };
}

async function indexSlot(org: Org) {
  seq += 1;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'code_graph_index',
      ref: `index-${seq}`,
      ownerRef: `index-${seq}`,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      expiresAt: LATER,
    },
  });
}

async function instance(org: Org, state: 'running' | 'hibernated', stateChangedAt: Date) {
  seq += 1;
  const machineId = `mach-${randomToken(8)}`;
  const volumeId = `vol-${randomToken(8)}`;
  const flyApp = `motir-agents-${randomToken(6).toLowerCase()}`;
  const row = await adminDb.agentInstance.create({
    data: {
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      projectId: org.projectId,
      ownerId: org.member.id,
      name: `agent-${seq}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      region: 'ams',
      state,
      stateChangedAt,
      machineId,
      volumeId,
      flyApp,
    },
  });
  org.secrets.push(machineId, volumeId, flyApp);
  org.marks.instanceIds.push(row.id);
  return row;
}

async function intent(
  org: Org,
  status: string,
  options: { waitingReason?: string | null; queuedAt?: Date } = {},
) {
  seq += 1;
  const containerId = `ctr-${randomToken(8)}`;
  const row = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      projectId: org.projectId,
      installationId: '556677',
      runId: String(7000 + seq),
      runAttempt: 1,
      jobId: String(80_000 + seq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: `web-${org.fx.projectIdentifier.toLowerCase()}`,
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: options.queuedAt ?? NOW,
      status,
      waitingReason: options.waitingReason ?? null,
      containerId: status === 'pending' ? null : containerId,
      containerRegion: status === 'pending' ? null : 'iad',
    },
  });
  if (status !== 'pending') org.secrets.push(containerId);
  if (['pending', 'provisioning', 'running'].includes(status)) org.marks.intentIds.push(row.id);
  return row;
}

async function kill(
  org: Org | null,
  options: {
    decidedAt: Date;
    reason?: string;
    workload?: string | null;
    completedAt?: Date | null;
  },
) {
  const machineId = `kill-${randomToken(10)}`;
  const app = `motir-ci-${randomToken(6).toLowerCase()}`;
  const recordRef = `ref-${randomToken(8)}`;
  const failureDetail = `provider said ${randomToken(8)}`;
  await adminDb.fleetMachineKill.create({
    data: {
      app,
      machineId,
      reason: options.reason ?? 'record_ended',
      action: 'destroyed',
      workload: options.workload === undefined ? 'ci_runner' : options.workload,
      recordRef,
      organizationId: org?.organizationId ?? null,
      ageSeconds: 600,
      decidedAt: options.decidedAt,
      completedAt: options.completedAt === undefined ? options.decidedAt : options.completedAt,
      failureDetail,
    },
  });
  org?.secrets.push(machineId, app, recordRef, failureDetail);
}

/** Everything a full seed gives one org. */
async function seed(org: Org) {
  await hostedRun(org, { scoped: true, startedAt: new Date(NOW.getTime() - 30 * 60_000) });
  await hostedRun(org, { scoped: false, startedAt: new Date(NOW.getTime() - 5 * 60_000) });
  await instance(org, 'running', new Date(NOW.getTime() - 2 * 60 * 60_000));
  await instance(org, 'hibernated', new Date(NOW.getTime() - DAY));
  await intent(org, 'running', { queuedAt: new Date(NOW.getTime() - 3 * 60_000) });
  await intent(org, 'pending', {
    waitingReason: 'plan_cap',
    queuedAt: new Date(NOW.getTime() - 2 * 60_000),
  });
  await intent(org, 'pending', {
    waitingReason: 'shard_capacity',
    queuedAt: new Date(NOW.getTime() - 60_000),
  });
  await intent(org, 'completed');
  await indexSlot(org);
  await kill(org, { decidedAt: new Date(NOW.getTime() - DAY), reason: 'no_record' });
  await kill(org, {
    decidedAt: new Date(NOW.getTime() - 2 * DAY),
    reason: 'org_stopped',
    workload: 'hosted_agent',
    completedAt: null,
  });
  await kill(org, { decidedAt: new Date(NOW.getTime() - 8 * DAY) });
}

function wire(on: Partial<Record<FleetWorkloadKind, boolean>>) {
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => on[kind] ?? false);
}

const answers: string[] = [];
async function read(org: Org, actorUserId = org.owner.id) {
  const answer = await orgFleetService.read(
    { organizationId: org.organizationId, actorUserId },
    NOW,
  );
  answers.push(JSON.stringify(answer));
  return answer;
}

/** Every key in a serialised value, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
}

const FORBIDDEN_KEYS = [
  'organizationId',
  'workspaceId',
  'projectId',
  'awsAccountId',
  'shardId',
  'fleetShardId',
  'credentialRef',
  'machineId',
  'volumeId',
  'region',
  'containerRegion',
  'containerId',
  'flyApp',
  'app',
  'recordRef',
  'failureDetail',
  'ownerId',
  'createdById',
  'userId',
  'email',
  'panelUrl',
  'terminalUrl',
];

let a: Org;
let b: Org;
const allSecrets: string[] = [];

async function clean() {
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.agentInstance.deleteMany({});
}

beforeEach(async () => {
  await truncateAuthTables();
  await clean();
  _resetPlanCapsCache();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockResolvedValue({
    status: 'active',
    currentPeriodEnd: null,
    priceId: null,
    planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 1 },
  });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  wire({});
  a = await makeOrg('A');
  b = await makeOrg('B');
});

afterEach(async () => {
  allSecrets.push(...a.secrets, ...b.secrets);
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  // No answer this file produced carries an id, a machine, an app or a provider's words.
  const all = answers.join('\n');
  for (const secret of allSecrets) expect(all).not.toContain(secret);
  await clean();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('an owner or admin reads every part of their own org', () => {
  it.each(['owner', 'admin'] as const)('as the %s', async (who) => {
    await seed(a);
    const answer = await read(a, a[who].id);

    if (answer.tiles.kind !== 'read') throw new Error('tiles not read');
    expect(answer.tiles.plan).toEqual({
      kind: 'limited',
      planKey: 'pro',
      planName: 'Pro',
      noFleet: false,
    });
    expect(answer.tiles.countsRead).toBe(true);
    expect(answer.tiles.figures.agentRunsInParallel.inUse).toBe(2);
    expect(answer.tiles.figures.agentsInOrg.inUse).toBe(2);
    expect(Object.keys(answer.tiles).sort()).toEqual(['countsRead', 'figures', 'kind', 'plan']);

    if (answer.hostedRuns.kind !== 'read') throw new Error('hosted runs not read');
    const [scoped, unscoped] = a.marks.runIds;
    expect(answer.hostedRuns.rows).toEqual([
      {
        id: scoped,
        projectName: a.projectName,
        card: { key: expect.stringMatching(/^FA\d+-\d+$/), title: a.marks.cardTitle },
        dispatcherName: a.member.name,
        startedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
        runUrl: `/runs?run=${scoped}`,
      },
      {
        id: unscoped,
        projectName: a.projectName,
        card: null,
        dispatcherName: a.member.name,
        startedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        runUrl: `/runs?run=${unscoped}`,
      },
    ]);

    if (answer.agentInstances.kind !== 'read') throw new Error('agents not read');
    expect(answer.agentInstances.rows).toEqual([
      {
        id: a.marks.instanceIds[0],
        ownerName: a.member.name,
        profileId: 'claude-code',
        projectName: a.projectName,
        state: 'running',
        since: new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(),
      },
      {
        id: a.marks.instanceIds[1],
        ownerName: a.member.name,
        profileId: 'claude-code',
        projectName: a.projectName,
        state: 'hibernated',
        since: new Date(NOW.getTime() - DAY).toISOString(),
      },
    ]);

    if (answer.ciJobs.kind !== 'read') throw new Error('CI jobs not read');
    expect(answer.ciJobs.inFlight).toBe(1);
    expect(answer.ciJobs.waiting).toEqual({ planLimit: 1, poolFull: 1, other: 0 });
    const repository = `motir-projects/web-${a.fx.projectIdentifier.toLowerCase()}`;
    expect(answer.ciJobs.rows.map((row) => [row.state, row.waitingCause])).toEqual([
      ['in_flight', null],
      ['waiting', 'planLimit'],
      ['waiting', 'poolFull'],
    ]);
    expect(answer.ciJobs.rows.map((row) => row.id)).toEqual(a.marks.intentIds);
    const first = answer.ciJobs.rows[0]!;
    expect(first).toEqual({
      id: a.marks.intentIds[0],
      repository,
      workflowName: 'CI',
      jobName: 'build',
      projectName: a.projectName,
      queuedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
      state: 'in_flight',
      waitingCause: null,
      actionsUrl: expect.stringMatching(
        new RegExp(`^https://github\\.com/${repository}/actions/runs/\\d+$`),
      ),
    });

    expect(answer.indexJobs).toEqual({ kind: 'read', running: 1 });
  });
});

describe('two organisations: each read holds its own org only', () => {
  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ] as const)('org %s’s read contains nothing of org %s', async (self, other) => {
    await seed(a);
    await seed(b);
    const orgs = { A: a, B: b };
    const mine = orgs[self];
    const theirs = orgs[other];
    const answer = await read(mine);
    const text = JSON.stringify(answer);

    for (const id of [
      ...theirs.marks.runIds,
      ...theirs.marks.instanceIds,
      ...theirs.marks.intentIds,
    ]) {
      expect(text).not.toContain(id);
    }
    for (const word of [
      theirs.projectName,
      theirs.member.name,
      theirs.marks.cardTitle,
      `web-${theirs.fx.projectIdentifier.toLowerCase()}`,
      ...theirs.secrets,
    ]) {
      expect(text).not.toContain(word);
    }
    if (answer.hostedRuns.kind !== 'read') throw new Error('hosted runs not read');
    expect(answer.hostedRuns.rows.map((row) => row.id)).toEqual(mine.marks.runIds);
    if (answer.agentInstances.kind !== 'read') throw new Error('agents not read');
    expect(answer.agentInstances.rows.map((row) => row.id)).toEqual(mine.marks.instanceIds);
    if (answer.ciJobs.kind !== 'read') throw new Error('CI jobs not read');
    expect(answer.ciJobs.rows.map((row) => row.id)).toEqual(mine.marks.intentIds);
    expect(answer.ciJobs.inFlight).toBe(1);
    expect(answer.indexJobs).toEqual({ kind: 'read', running: 1 });
    if (answer.motirStops.kind !== 'read') throw new Error('stops not read');
    expect(answer.motirStops.entries).toHaveLength(2);
  });
});

describe('the response is built field by field', () => {
  it('no forbidden key or seeded secret at any depth, and no agent link', async () => {
    await seed(a);
    const answer = JSON.parse(JSON.stringify(await read(a)));
    const keys = keysOf(answer);
    for (const key of FORBIDDEN_KEYS) expect(keys.has(key), `key ${key}`).toBe(false);
    const text = JSON.stringify(answer);
    for (const secret of a.secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/agents\/|\/terminal|\/panel/);
    for (const row of answer.agentInstances.rows) {
      expect(Object.keys(row).sort()).toEqual([
        'id',
        'ownerName',
        'profileId',
        'projectName',
        'since',
        'state',
      ]);
    }
  });
});

describe('Motir’s stops', () => {
  it('the last seven days only, newest first, time · workload · reason · completed', async () => {
    await kill(a, { decidedAt: new Date(NOW.getTime() - 3 * DAY), reason: 'foreign_org' });
    await kill(a, { decidedAt: new Date(NOW.getTime() - 60_000), workload: null });
    await kill(a, { decidedAt: new Date(NOW.getTime() - 7 * DAY + 60_000), reason: 'no_record' });
    await kill(a, { decidedAt: new Date(NOW.getTime() - 7 * DAY - 60_000) });
    await kill(null, { decidedAt: new Date(NOW.getTime() - 60_000) });
    await kill(b, { decidedAt: new Date(NOW.getTime() - 60_000) });

    const answer = await read(a);
    expect(answer.motirStops).toEqual({
      kind: 'read',
      since: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      entries: [
        {
          decidedAt: new Date(NOW.getTime() - 60_000).toISOString(),
          workload: null,
          reason: 'record_ended',
          completed: true,
        },
        {
          decidedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
          workload: 'ci_runner',
          reason: 'foreign_org',
          completed: true,
        },
        {
          decidedAt: new Date(NOW.getTime() - 7 * DAY + 60_000).toISOString(),
          workload: 'ci_runner',
          reason: 'no_record',
          completed: true,
        },
      ],
    });
  });

  it('a row whose reason this read does not know is left out and logged', async () => {
    await kill(a, { decidedAt: new Date(NOW.getTime() - 60_000), reason: 'something_new' });
    await kill(a, { decidedAt: new Date(NOW.getTime() - 120_000), completedAt: null });
    const answer = await read(a);
    if (answer.motirStops.kind !== 'read') throw new Error('stops not read');
    expect(answer.motirStops.entries).toEqual([
      expect.objectContaining({ reason: 'record_ended', completed: false }),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('a reason this read does not know'),
      expect.objectContaining({ reason: 'something_new' }),
    );
  });

  it('an org with nothing on the fleet reads empty lists and zeros — read, not failed', async () => {
    const answer = await read(a);
    expect(answer.hostedRuns).toEqual({ kind: 'read', rows: [] });
    expect(answer.agentInstances).toEqual({ kind: 'read', rows: [] });
    expect(answer.ciJobs).toEqual({
      kind: 'read',
      inFlight: 0,
      waiting: { planLimit: 0, poolFull: 0, other: 0 },
      rows: [],
    });
    expect(answer.indexJobs).toEqual({ kind: 'read', running: 0 });
    expect(answer.motirStops).toMatchObject({ kind: 'read', entries: [] });
  });
});

describe('each part fails alone', () => {
  const PARTS = [
    'tiles',
    'hostedRuns',
    'agentInstances',
    'ciJobs',
    'indexJobs',
    'motirStops',
    'lastStop',
  ];

  it.each([
    ['tiles', () => vi.spyOn(fleetUseService, 'readForOrganization')],
    ['hostedRuns', () => vi.spyOn(fleetInFlightSlotRepository, 'listLiveForOrganization')],
    ['agentInstances', () => vi.spyOn(agentInstanceRepository, 'listLiveForOrganization')],
    ['ciJobs', () => vi.spyOn(ciRunnerProvisioningIntentRepository, 'listOpenForOrganization')],
    ['motirStops', () => vi.spyOn(fleetMachineKillRepository, 'listSinceForOrganization')],
  ] as const)('%s not read: logged, the rest still carry data', async (part, spyOn) => {
    await seed(a);
    (spyOn() as unknown as { mockRejectedValue(e: Error): void }).mockRejectedValue(
      new Error('down'),
    );
    const answer = await read(a);
    expect(answer[part as keyof typeof answer]).toEqual({ kind: 'not_read' });
    for (const other of PARTS.filter((p) => p !== part)) {
      expect(answer[other as keyof typeof answer].kind, other).toBe('read');
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('could not read'),
      expect.objectContaining({ organizationId: a.organizationId, error: 'Error' }),
    );
  });

  it('the index count not read is not_read — never 0 — and the tiles report counts not read', async () => {
    await seed(a);
    vi.spyOn(fleetCeilingService, 'orgCensus').mockRejectedValue(new Error('down'));
    const answer = await read(a);
    expect(answer.indexJobs).toEqual({ kind: 'not_read' });
    if (answer.tiles.kind !== 'read') throw new Error('tiles not read');
    expect(answer.tiles.countsRead).toBe(false);
    expect(answer.tiles.figures.agentRunsInParallel.inUse).toBeNull();
    expect(answer.hostedRuns.kind).toBe('read');
  });

  it('a failed project-name read fails its part rather than naming nothing', async () => {
    await seed(a);
    const { projectRepository } = await import('@/lib/repositories/projectRepository');
    vi.spyOn(projectRepository, 'findManyByIds').mockRejectedValue(new Error('down'));
    const answer = await read(a);
    expect(answer.hostedRuns).toEqual({ kind: 'not_read' });
    expect(answer.agentInstances).toEqual({ kind: 'not_read' });
    expect(answer.ciJobs).toEqual({ kind: 'not_read' });
    expect(answer.motirStops.kind).toBe('read');
  });
});

describe('a name that cannot be found reads null — never a guess', () => {
  it('slots of another shape are skipped; a run with no dispatcher; ties order by id', async () => {
    for (const ref of ['hosted-run:', 'container:abc']) {
      await adminDb.fleetInFlightSlot.create({
        data: {
          workload: 'hosted_agent',
          ref,
          ownerRef: ref,
          organizationId: a.organizationId,
          workspaceId: a.workspaceId,
          expiresAt: LATER,
        },
      });
    }
    const startedAt = new Date(NOW.getTime() - 60_000);
    for (let i = 0; i < 2; i += 1) {
      const run = await adminDb.dispatchRun.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          command: 'run',
          origin: 'hosted',
          status: 'running',
          createdById: null,
          startedAt,
        },
      });
      const ref = hostedRunDispatchId(run.id);
      await adminDb.fleetInFlightSlot.create({
        data: {
          workload: 'hosted_agent',
          ref,
          ownerRef: ref,
          organizationId: a.organizationId,
          workspaceId: a.workspaceId,
          expiresAt: LATER,
        },
      });
      a.marks.runIds.push(run.id);
    }
    const answer = await read(a);
    if (answer.hostedRuns.kind !== 'read') throw new Error('hosted runs not read');
    expect(answer.hostedRuns.rows.map((row) => row.id)).toEqual([...a.marks.runIds].sort());
    expect(answer.hostedRuns.rows.map((row) => row.dispatcherName)).toEqual([null, null]);
  });

  it('a CI job with no project; a waiting job no admission pass judged yet', async () => {
    const row = await intent(a, 'pending', { waitingReason: null });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: row.id },
      data: { projectId: null },
    });
    const answer = await read(a);
    if (answer.ciJobs.kind !== 'read') throw new Error('CI jobs not read');
    expect(answer.ciJobs.rows).toEqual([
      expect.objectContaining({ projectName: null, state: 'waiting', waitingCause: 'other' }),
    ]);
    expect(answer.ciJobs.waiting).toEqual({ planLimit: 0, poolFull: 0, other: 1 });
  });

  it('a project or a person that reads back missing is null on the row', async () => {
    await seed(a);
    const { projectRepository } = await import('@/lib/repositories/projectRepository');
    const { userRepository } = await import('@/lib/repositories/userRepository');
    vi.spyOn(projectRepository, 'findManyByIds').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findByIds').mockResolvedValue([]);
    const answer = await read(a);
    if (answer.hostedRuns.kind !== 'read') throw new Error('hosted runs not read');
    if (answer.agentInstances.kind !== 'read') throw new Error('agents not read');
    if (answer.ciJobs.kind !== 'read') throw new Error('CI jobs not read');
    for (const run of answer.hostedRuns.rows) {
      expect(run).toMatchObject({ projectName: null, dispatcherName: null });
    }
    for (const agent of answer.agentInstances.rows) {
      expect(agent).toMatchObject({ projectName: null, ownerName: null });
    }
    for (const job of answer.ciJobs.rows) expect(job.projectName).toBeNull();
  });

  it('a thrown value that is not an Error is logged by a neutral name', async () => {
    vi.spyOn(fleetMachineKillRepository, 'listSinceForOrganization').mockRejectedValue('down');
    const answer = await read(a);
    expect(answer.motirStops).toEqual({ kind: 'not_read' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Motir stops'),
      expect.objectContaining({ error: 'UnknownError' }),
    );
  });
});

describe('the gate', () => {
  it.each([
    ['a plain member', 'member', 'BillingForbiddenError'],
    ['a non-member', null, 'OrganizationNotFoundError'],
    ['a member of another org', 'other', 'OrganizationNotFoundError'],
  ] as const)('%s is refused before any read', async (_, who, errorName) => {
    const slots = vi.spyOn(fleetInFlightSlotRepository, 'listLiveForOrganization');
    const kills = vi.spyOn(fleetMachineKillRepository, 'listSinceForOrganization');
    const tiles = vi.spyOn(fleetUseService, 'readForOrganization');
    const actor =
      who === 'member' ? a.member.id : who === 'other' ? b.owner.id : (await createTestUser()).id;
    await expect(read(a, actor)).rejects.toMatchObject({ name: errorName });
    expect(slots).not.toHaveBeenCalled();
    expect(kills).not.toHaveBeenCalled();
    expect(tiles).not.toHaveBeenCalled();
  });

  it('off a build with the fleet meter: BillingNotAvailableError before any read', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const kills = vi.spyOn(fleetMachineKillRepository, 'listSinceForOrganization');
    await expect(read(a)).rejects.toMatchObject({ name: 'BillingNotAvailableError' });
    expect(kills).not.toHaveBeenCalled();
  });
});

describe('a report', () => {
  it('writes nothing', async () => {
    await seed(a);
    const counts = async () => ({
      slots: await adminDb.fleetInFlightSlot.findMany({ orderBy: { id: 'asc' } }),
      intents: await adminDb.ciRunnerProvisioningIntent.findMany({ orderBy: { id: 'asc' } }),
      instances: await adminDb.agentInstance.findMany({ orderBy: { id: 'asc' } }),
      kills: await adminDb.fleetMachineKill.findMany({ orderBy: { id: 'asc' } }),
      runs: await adminDb.dispatchRun.findMany({ orderBy: { id: 'asc' } }),
    });
    const before = await counts();
    await read(a);
    expect(await counts()).toEqual(before);
  });
});
