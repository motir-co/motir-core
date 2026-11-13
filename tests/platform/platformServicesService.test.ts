import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { db } from '@/lib/db';
import { ECRClient } from '@aws-sdk/client-ecr';
import type {
  EcsDeploymentRead,
  EcsServiceRead,
  EcsServicesReader,
} from '@/lib/awsServices/ecsServicesReader';
import type { CommitComparison, DefaultBranchHead, RepoRef } from '@/lib/github/repoCommitHistory';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import {
  accountOfArn,
  createVersionReader,
  IMAGE_SOURCE_REPOSITORIES,
  judgeComparison,
  judgeCluster,
  judgeService,
  judgeShare,
  platformServicesService,
  primaryImageOf,
  servicesCluster,
  STALE_AFTER_MS,
  type DeploymentVersionRead,
  type ServiceVersionSources,
} from '@/lib/services/platformServicesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE SERVICES PAGE'S READ (MOTIR-10890). The gate runs for real over a real
// session (the session is the one thing mocked), the audit row and the
// last-read marks are real rows, and AWS is a fake reader handed in.

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const ACCOUNT = '123456789012';
const td = (family: string, revision: number) =>
  `arn:aws:ecs:eu-central-1:${ACCOUNT}:task-definition/${family}:${revision}`;
const NOW = new Date('2026-11-10T12:00:00.000Z');

function dep(over: Partial<EcsDeploymentRead> & { taskDefinitionArn: string }): EcsDeploymentRead {
  return {
    status: 'PRIMARY',
    rolloutState: 'COMPLETED',
    createdAt: new Date('2026-11-09T08:00:00.000Z'),
    runningCount: 2,
    desiredCount: 2,
    ...over,
  };
}

function service(
  name: string,
  opts: {
    running?: number;
    desired?: number;
    current?: string;
    deployments?: EcsDeploymentRead[];
    sizes?: Record<string, { cpuUnits: number | null; memoryMib: number | null }>;
    /** The image each task definition's first container names (MOTIR-11112). */
    images?: Record<string, string>;
  } = {},
): EcsServiceRead {
  const current = opts.current ?? td(name, 4);
  const running = opts.running ?? 2;
  const desired = opts.desired ?? 2;
  const deployments = opts.deployments ?? [
    dep({ taskDefinitionArn: current, runningCount: running, desiredCount: desired }),
  ];
  const sizes = opts.sizes ?? {};
  const taskDefinitions = Object.fromEntries(
    [...new Set([current, ...deployments.map((d) => d.taskDefinitionArn)])].map((arn) => {
      const [family, revision] = arn.split('/').pop()!.split(':');
      return [
        arn,
        {
          family: family!,
          revision: Number(revision),
          ...(sizes[arn] ?? { cpuUnits: 1024, memoryMib: 2048 }),
          image: opts.images?.[arn] ?? null,
        },
      ];
    }),
  );
  return {
    name,
    arn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:service/motir-core/${name}`,
    runningCount: running,
    desiredCount: desired,
    taskDefinitionArn: current,
    deployments,
    taskDefinitions,
  };
}

function reader(
  services: EcsServiceRead[] | Error,
  quota: number | Error = 16,
): EcsServicesReader & { cluster: string[] } {
  const cluster: string[] = [];
  return {
    cluster,
    async listServices(name) {
      cluster.push(name);
      if (services instanceof Error) throw services;
      return services;
    },
    async readFargateVcpuQuota() {
      if (quota instanceof Error) throw quota;
      return quota;
    },
  };
}

let seq = 0;
async function signInAs(role: 'support' | 'operator' | 'superadmin'): Promise<void> {
  const user = await createTestUser({ email: `ops+services-${role}-${++seq}@example.test` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
}

beforeEach(async () => {
  currentSession = null;
  delete process.env.MOTIR_ECS_CLUSTER;
  await truncateAuthTables();
  await adminDb.platformAwsRead.deleteMany();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.platformAwsRead.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('judgeService', () => {
  it('a steady service: one deployment, running = desired', () => {
    const row = judgeService(service('web'));
    expect(row).toMatchObject({
      name: 'web',
      family: 'web',
      revision: 4,
      tasks: 'full',
      vcpuPerTask: 1,
      memoryMib: 2048,
      vcpu: 2,
      uniformSize: true,
      notStarted: 0,
      deployment: { state: 'steady', fromRevision: null, toRevision: 4, oldRunning: 0 },
    });
    expect(row.deployment.startedAt).toBe('2026-11-09T08:00:00.000Z');
  });

  it('a rolling service counts both deployments’ tasks, each at its own size', () => {
    const row = judgeService(
      service('web', {
        running: 3,
        desired: 2,
        deployments: [
          dep({
            taskDefinitionArn: td('web', 4),
            rolloutState: 'IN_PROGRESS',
            runningCount: 1,
            desiredCount: 2,
          }),
          dep({
            status: 'ACTIVE',
            taskDefinitionArn: td('web', 3),
            runningCount: 2,
            desiredCount: 0,
          }),
        ],
        sizes: { [td('web', 3)]: { cpuUnits: 512, memoryMib: 1024 } },
      }),
    );
    expect(row.tasks).toBe('rolling');
    expect(row.vcpu).toBe(2); // 1 × 1 + 2 × 0.5
    expect(row.uniformSize).toBe(false);
    expect(row.deployment).toMatchObject({
      state: 'rolling',
      fromRevision: 3,
      toRevision: 4,
      newRunning: 1,
      newDesired: 2,
      oldRunning: 2,
    });
  });

  it('a PRIMARY rollout in progress alone is rolling too', () => {
    const row = judgeService(
      service('web', {
        deployments: [dep({ taskDefinitionArn: td('web', 4), rolloutState: 'IN_PROGRESS' })],
      }),
    );
    expect(row.deployment).toMatchObject({ state: 'rolling', fromRevision: null });
  });

  it('a failed rollout names the revision that stopped and the one still running', () => {
    const row = judgeService(
      service('web', {
        running: 2,
        desired: 2,
        deployments: [
          dep({
            taskDefinitionArn: td('web', 5),
            rolloutState: 'FAILED',
            runningCount: 0,
            desiredCount: 2,
          }),
          dep({
            status: 'ACTIVE',
            taskDefinitionArn: td('web', 4),
            runningCount: 2,
            desiredCount: 2,
          }),
        ],
        current: td('web', 5),
      }),
    );
    expect(row.deployment).toMatchObject({
      state: 'failed',
      fromRevision: 4,
      toRevision: 5,
      newRunning: 0,
      oldRunning: 2,
    });
    expect(row.tasks).toBe('full');
  });

  it('a failed rollout with nothing else deployed has no revision to name', () => {
    const row = judgeService(
      service('web', {
        running: 0,
        desired: 1,
        deployments: [
          dep({
            taskDefinitionArn: td('web', 4),
            rolloutState: 'FAILED',
            runningCount: 0,
            desiredCount: 1,
            createdAt: null,
          }),
        ],
      }),
    );
    expect(row.deployment).toMatchObject({ state: 'failed', fromRevision: null, startedAt: null });
    expect(row.tasks).toBe('short');
    expect(row.notStarted).toBe(1);
  });

  it('short of tasks and not rolling: never "Steady"', () => {
    const row = judgeService(service('worker', { running: 1, desired: 3 }));
    expect(row).toMatchObject({
      tasks: 'short',
      notStarted: 2,
      deployment: { state: 'notRolling' },
    });
  });

  it('scaled to 0 is not a failure', () => {
    const row = judgeService(service('batch', { running: 0, desired: 0 }));
    expect(row).toMatchObject({ tasks: 'scaledToZero', vcpu: 0, deployment: { state: 'steady' } });
  });

  it('a service ECS gave no deployments is judged from its own counts', () => {
    const row = judgeService({ ...service('web', { running: 1, desired: 1 }), deployments: [] });
    expect(row).toMatchObject({
      tasks: 'full',
      vcpu: 1,
      deployment: { state: 'steady', startedAt: null },
    });
  });

  it('a deployment list with no PRIMARY reads its first as the current one', () => {
    const row = judgeService(
      service('web', { deployments: [dep({ status: 'ACTIVE', taskDefinitionArn: td('web', 4) })] }),
    );
    expect(row.deployment).toMatchObject({ state: 'steady', toRevision: 4 });
  });

  it('a task definition with no size is not a size of 0: it fails the read', () => {
    expect(() =>
      judgeService(
        service('web', { sizes: { [td('web', 4)]: { cpuUnits: null, memoryMib: 2048 } } }),
      ),
    ).toThrow('no task-level size');
    expect(() => judgeService({ ...service('web'), taskDefinitions: {} })).toThrow(
      'no task-level size',
    );
  });
});

describe('judgeCluster', () => {
  it('sorts by name, sums every row, and counts the pills', () => {
    const judged = judgeCluster([
      service('worker', {
        running: 1,
        desired: 3,
        sizes: { [td('worker', 4)]: { cpuUnits: 256, memoryMib: 512 } },
      }),
      service('web'),
      service('batch', { running: 0, desired: 0 }),
      service('relay', {
        deployments: [dep({ taskDefinitionArn: td('relay', 4), rolloutState: 'FAILED' })],
      }),
      service('api', {
        deployments: [dep({ taskDefinitionArn: td('api', 4), rolloutState: 'IN_PROGRESS' })],
      }),
    ]);
    expect(judged.services.map((r) => r.name)).toEqual(['api', 'batch', 'relay', 'web', 'worker']);
    expect(judged.total).toEqual({ services: 5, running: 7, desired: 9, vcpu: 6.25 });
    expect(judged).toMatchObject({ rolling: 1, failed: 1, short: 1 });
  });
});

describe('judgeShare', () => {
  it.each([
    [4, 16, { percent: 25, verdict: 'under', headroom: 7.2, over: 0 }],
    [11.2, 16, { percent: 70, verdict: 'over70', headroom: 4.8, over: 0 }],
    [69.75, 100, { percent: 69, verdict: 'under', headroom: 0.25, over: 0 }],
    [99.6, 100, { percent: 99, verdict: 'over70', headroom: 0.4, over: 0 }],
    [16, 16, { percent: 100, verdict: 'atQuota', headroom: 0, over: 0 }],
    [18.5, 16, { percent: 115, verdict: 'atQuota', headroom: 0, over: 2.5 }],
    [0, 0, { percent: 100, verdict: 'atQuota', headroom: 0, over: 0 }],
    [1, 0, { percent: 100, verdict: 'atQuota', headroom: 0, over: 1 }],
  ] as const)('%s vCPU of %s', (vcpu, quota, expected) => {
    expect(judgeShare(vcpu, quota)).toEqual(expected);
  });
});

describe('accountOfArn and servicesCluster', () => {
  it('reads the account out of an ARN, and only a twelve-digit one', () => {
    expect(accountOfArn(td('web', 1))).toBe(ACCOUNT);
    expect(accountOfArn('arn:aws:ecs:eu-central-1::service/x')).toBeNull();
    expect(accountOfArn('not-an-arn')).toBeNull();
  });

  it('is motir-core unless the services stack names another', () => {
    expect(servicesCluster()).toBe('motir-core');
    process.env.MOTIR_ECS_CLUSTER = '  motir-staging ';
    expect(servicesCluster()).toBe('motir-staging');
    process.env.MOTIR_ECS_CLUSTER = ' ';
    expect(servicesCluster()).toBe('motir-core');
  });
});

describe('platformServicesService.read', () => {
  it.each(['support', 'operator'] as const)('refuses a %s before reading AWS', async (role) => {
    await signInAs(role);
    const fake = reader([service('web')]);
    await expect(platformServicesService.read({ reader: fake, now: NOW })).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(fake.cluster).toEqual([]);
  });

  it('a superadmin gets the cluster listed from ECS — an extra service is a row — and the share', async () => {
    await signInAs('superadmin');
    const fake = reader([service('web'), service('worker'), service('extra-one')], 16);
    const dto = await platformServicesService.read({ reader: fake, now: NOW });

    expect(fake.cluster).toEqual(['motir-core']);
    expect(dto).toMatchObject({
      cluster: 'motir-core',
      account: ACCOUNT,
      readAt: NOW.toISOString(),
      quota: { status: 'ok', vcpu: 16, readAt: NOW.toISOString() },
      share: { percent: 37, verdict: 'under' },
    });
    expect(dto.read.status === 'ok' && dto.read.services.map((r) => r.name)).toEqual([
      'extra-one',
      'web',
      'worker',
    ]);

    const audit = await adminDb.platformAuditLog.findMany({ where: { action: 'services.read' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetKind: 'platform', targetId: 'motir-core' });
    expect(audit[0]!.metadata).toEqual({
      cluster: 'motir-core',
      clusterRead: true,
      quotaRead: true,
    });
    const marks = await adminDb.platformAwsRead.findMany({ orderBy: { subject: 'asc' } });
    expect(marks).toEqual([
      { subject: 'ecs:motir-core', accountId: ACCOUNT, readAt: NOW },
      { subject: 'servicequotas:fargate/L-3032A538', accountId: null, readAt: NOW },
    ]);
  });

  it('at or over 70% and at the quota are the service’s verdicts', async () => {
    await signInAs('superadmin');
    const over = await platformServicesService.read({
      reader: reader([service('web', { running: 12, desired: 12 })], 16),
      now: NOW,
    });
    expect(over.share).toMatchObject({ verdict: 'over70', headroom: 4 });
    const at = await platformServicesService.read({
      reader: reader([service('web', { running: 17, desired: 17 })], 16),
      now: NOW,
    });
    expect(at.share).toMatchObject({ verdict: 'atQuota', over: 1 });
  });

  it('an unread quota is "not read" with no share — never a 0 — and names its last read', async () => {
    await signInAs('superadmin');
    await platformServicesService.read({ reader: reader([service('web')], 16), now: NOW });

    const later = new Date(NOW.getTime() + 3_600_000);
    const dto = await platformServicesService.read({
      reader: reader([service('web')], new Error('ThrottlingException')),
      now: later,
    });
    expect(dto.quota).toEqual({ status: 'notRead', lastReadAt: NOW.toISOString() });
    expect(dto.share).toBeNull();
    expect(dto.read.status).toBe('ok');
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('[admin] services quota read failed', {
      cluster: 'motir-core',
      error: 'Error',
    });
  });

  it('a failed ECS read shows no row and no total, and never-read when none is on record', async () => {
    await signInAs('superadmin');
    const dto = await platformServicesService.read({
      reader: reader(new Error('AccessDenied: arn:aws:iam::123456789012:role/x'), 16),
      now: NOW,
    });
    expect(dto.read).toEqual({ status: 'failed', lastReadAt: null });
    expect(dto.account).toBeNull();
    expect(dto.share).toBeNull();
    expect(dto.quota.status).toBe('ok');
    // The log names the error, never its message (it can carry ARNs).
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('AccessDenied');
    const audit = await adminDb.platformAuditLog.findFirst({ where: { action: 'services.read' } });
    expect(audit!.metadata).toEqual({ cluster: 'motir-core', clusterRead: false, quotaRead: true });
  });

  it('a failed ECS read after a good one names when it was last read, and keeps the account', async () => {
    await signInAs('superadmin');
    await platformServicesService.read({ reader: reader([service('web')], 16), now: NOW });
    const dto = await platformServicesService.read({
      reader: reader(new TypeError('fetch failed'), new Error('down')),
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(dto.read).toEqual({ status: 'failed', lastReadAt: NOW.toISOString() });
    expect(dto.quota).toEqual({ status: 'notRead', lastReadAt: NOW.toISOString() });
    expect(dto.account).toBe(ACCOUNT);
  });

  it('a task definition with no size fails the cluster read, not the page', async () => {
    await signInAs('superadmin');
    const dto = await platformServicesService.read({
      reader: reader([
        service('web', { sizes: { [td('web', 4)]: { cpuUnits: 1024, memoryMib: null } } }),
      ]),
      now: NOW,
    });
    expect(dto.read.status).toBe('failed');
    expect(dto.quota.status).toBe('ok');
  });

  it('an empty cluster keeps the account it was last read in, and logs a non-Error as unknown', async () => {
    await signInAs('superadmin');
    await platformServicesService.read({ reader: reader([service('web')]), now: NOW });
    const empty = await platformServicesService.read({ reader: reader([]), now: NOW });
    expect(empty.account).toBe(ACCOUNT);
    expect(empty.read).toMatchObject({ status: 'ok', total: { services: 0, vcpu: 0 } });

    const odd: EcsServicesReader = {
      listServices: () => Promise.reject('nope'),
      readFargateVcpuQuota: async () => 16,
    };
    await platformServicesService.read({ reader: odd, now: NOW });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('[admin] services cluster read failed', {
      cluster: 'motir-core',
      error: 'unknown',
    });
  });

  it('reads the cluster the environment names', async () => {
    await signInAs('superadmin');
    process.env.MOTIR_ECS_CLUSTER = 'motir-staging';
    const fake = reader([]);
    const dto = await platformServicesService.read({ reader: fake, now: NOW });
    expect(fake.cluster).toEqual(['motir-staging']);
    expect(dto.cluster).toBe('motir-staging');
  });

  it('with no reader handed in, reads AWS through the default chain, at the current time', async () => {
    await signInAs('superadmin');
    vi.spyOn(ECSClient.prototype, 'send').mockRejectedValue(
      new Error('CredentialsProviderError') as never,
    );
    vi.spyOn(ServiceQuotasClient.prototype, 'send').mockResolvedValue({
      Quota: { Value: 8 },
    } as never);
    const before = Date.now();
    const dto = await platformServicesService.read();
    expect(dto.read.status).toBe('failed');
    expect(dto.quota).toMatchObject({ status: 'ok', vcpu: 8 });
    expect(new Date(dto.readAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ── The deployed commit (MOTIR-11112, design MOTIR-11242) ────────────────────
// ECR and GitHub are fakes handed in as the version sources, so every state the
// version pill draws is reached, and the calls each read makes are counted.

const REGISTRY = '944842271421.dkr.ecr.us-east-1.amazonaws.com';
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (repository: string, c: string) => `${REGISTRY}/${repository}@${digest(c)}`;
const sha = (c: string) => c.repeat(40);
const HEADS: Record<string, DefaultBranchHead> = {
  'motir-core': { branch: 'main', sha: sha('a') },
  'motir-ai': { branch: 'main', sha: sha('b') },
  'motir-gateway': { branch: 'main', sha: sha('c') },
};

interface FakeSources extends ServiceVersionSources {
  calls: { tags: string[]; heads: string[]; compares: string[]; tokens: string[] };
}

function fakeSources(
  opts: {
    /** Tags by image digest; an Error is ECR refusing. */
    tags?: Record<string, string[] | Error>;
    /** Heads by repository name; an Error is GitHub refusing. */
    heads?: Record<string, DefaultBranchHead | Error>;
    /** Comparisons by `<repository>@<deployed sha>`; an Error is GitHub refusing. */
    compares?: Record<string, CommitComparison | Error>;
  } = {},
): FakeSources {
  const calls: FakeSources['calls'] = { tags: [], heads: [], compares: [], tokens: [] };
  const answer = <T>(value: T | Error | undefined, what: string): T => {
    if (value === undefined) throw new Error(`no fake for ${what}`);
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    ecr: {
      async tagsOf(address) {
        calls.tags.push(address.digest ?? address.tag!);
        return answer(opts.tags?.[address.digest ?? address.tag!], 'tags');
      },
    },
    github: {
      async defaultBranchHead(repo: RepoRef, token) {
        calls.heads.push(`${repo.name}:${token}`);
        return answer((opts.heads ?? HEADS)[repo.name], 'head');
      },
      async compare(repo: RepoRef, base, head, token) {
        calls.compares.push(`${repo.name}@${base}...${head}:${token}`);
        return answer(opts.compares?.[`${repo.name}@${base}`], 'compare');
      },
    },
    async token(owner) {
      calls.tokens.push(owner);
      return `token-${owner}`;
    },
  };
}

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

describe('IMAGE_SOURCE_REPOSITORIES', () => {
  it('maps every image repository the cluster runs to its source repository, edge to motir-gateway', () => {
    expect(IMAGE_SOURCE_REPOSITORIES).toEqual({
      'motir/motir-core': { owner: 'motir-co', name: 'motir-core' },
      'motir/motir-ai': { owner: 'motir-co', name: 'motir-ai' },
      'motir/motir-gateway': { owner: 'motir-co', name: 'motir-gateway' },
      'motir/edge': { owner: 'motir-co', name: 'motir-gateway' },
    });
  });
});

describe('judgeComparison', () => {
  const repo = { owner: 'motir-co', name: 'motir-ai' };
  const head = { branch: 'main', sha: sha('b') };

  it('identical is Latest; behind or diverged on GitHub’s side is Diverged', () => {
    const base = { aheadBy: 0, oldestAheadAt: null };
    expect(judgeComparison(repo, sha('e'), head, { ...base, relation: 'identical' }, NOW)).toEqual({
      state: 'latest',
    });
    expect(judgeComparison(repo, sha('e'), head, { ...base, relation: 'behind' }, NOW)).toEqual({
      state: 'diverged',
    });
    expect(
      judgeComparison(
        repo,
        sha('e'),
        head,
        { relation: 'diverged', aheadBy: 3, oldestAheadAt: minutesAgo(1) },
        NOW,
      ),
    ).toEqual({ state: 'diverged' });
  });

  it('ahead is N behind: fresh under 45 minutes, stale at 45 and after, with the compare link', () => {
    const behind = (age: number) =>
      judgeComparison(
        repo,
        sha('e'),
        head,
        { relation: 'ahead', aheadBy: 7, oldestAheadAt: minutesAgo(age) },
        NOW,
      );
    expect(behind(44)).toEqual({
      state: 'behind',
      count: 7,
      oldestUndeployedAt: minutesAgo(44),
      severity: 'fresh',
      compareUrl: `https://github.com/motir-co/motir-ai/compare/${sha('e')}...main`,
    });
    expect(STALE_AFTER_MS).toBe(45 * 60_000);
    expect(behind(45)).toMatchObject({ severity: 'stale' });
    expect(behind(180)).toMatchObject({ severity: 'stale' });
  });

  it('ahead with no oldest commit is not a judgement', () => {
    expect(() =>
      judgeComparison(
        repo,
        sha('e'),
        head,
        { relation: 'ahead', aheadBy: 1, oldestAheadAt: null },
        NOW,
      ),
    ).toThrow('no oldest undeployed commit');
  });
});

describe('createVersionReader', () => {
  it('reads the commit from the image’s SHA tag and is Latest at the head, with no compare', async () => {
    const fake = fakeSources({ tags: { [digest('1')]: ['main', sha('a')] } });
    const read = await createVersionReader(fake, NOW)(image('motir/motir-core', '1'));
    expect(read).toEqual({
      commit: {
        sha: sha('a'),
        repository: 'motir-core',
        url: `https://github.com/motir-co/motir-core/commit/${sha('a')}`,
      },
      judgement: { state: 'latest' },
    });
    expect(fake.calls).toEqual({
      tags: [digest('1')],
      heads: ['motir-core:token-motir-co'],
      compares: [],
      tokens: ['motir-co'],
    });
  });

  it('uses a reference BY its SHA tag directly, without reading ECR', async () => {
    const fake = fakeSources({
      compares: {
        [`motir-gateway@${sha('d')}`]: {
          relation: 'diverged',
          aheadBy: 2,
          oldestAheadAt: minutesAgo(5),
        },
      },
    });
    const read = await createVersionReader(fake, NOW)(`${REGISTRY}/motir/edge:${sha('d')}`);
    expect(read.commit).toMatchObject({ sha: sha('d'), repository: 'motir-gateway' });
    expect(read.judgement).toEqual({ state: 'diverged' });
    expect(fake.calls.tags).toEqual([]);
    expect(fake.calls.compares).toEqual([`motir-gateway@${sha('d')}...${sha('c')}:token-motir-co`]);
  });

  it('shares reads across rows: the three motir-core services cost one ECR read, one head and one compare', async () => {
    const fake = fakeSources({
      tags: { [digest('1')]: [sha('e')] },
      compares: {
        [`motir-core@${sha('e')}`]: {
          relation: 'ahead',
          aheadBy: 3,
          oldestAheadAt: minutesAgo(90),
        },
      },
    });
    const versionOf = createVersionReader(fake, NOW);
    const reads = await Promise.all(
      ['web', 'worker', 'relay'].map(() => versionOf(image('motir/motir-core', '1'))),
    );
    expect(reads.map((r) => r.judgement)).toEqual(
      Array(3).fill({
        state: 'behind',
        count: 3,
        oldestUndeployedAt: minutesAgo(90),
        severity: 'stale',
        compareUrl: `https://github.com/motir-co/motir-core/compare/${sha('e')}...main`,
      }),
    );
    expect(fake.calls.tags).toHaveLength(1);
    expect(fake.calls.heads).toHaveLength(1);
    expect(fake.calls.compares).toHaveLength(1);
    expect(fake.calls.tokens).toEqual(['motir-co']);
  });

  it('an image with no SHA tag, or no image at all, is Unknown · no_sha_tag with no commit', async () => {
    const fake = fakeSources({ tags: { [digest('1')]: ['main', 'v1.2.3'] } });
    const versionOf = createVersionReader(fake, NOW);
    expect(await versionOf(image('motir/motir-core', '1'))).toEqual({
      commit: null,
      judgement: { state: 'unknown', reason: 'no_sha_tag' },
    });
    expect(await versionOf(null)).toEqual({
      commit: null,
      judgement: { state: 'unknown', reason: 'no_sha_tag' },
    });
  });

  it('an ECR refusal is Unknown · ecr_not_read with no commit, logged by name only', async () => {
    const fake = fakeSources({
      tags: { [digest('1')]: new Error('AccessDeniedException: arn:x') },
    });
    expect(await createVersionReader(fake, NOW)(image('motir/motir-ai', '1'))).toEqual({
      commit: null,
      judgement: { state: 'unknown', reason: 'ecr_not_read' },
    });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('[admin] services version read failed', {
      repository: 'motir/motir-ai',
      reason: 'ecr_not_read',
      error: 'Error',
    });
  });

  it('an unmapped repository keeps its commit, unlinked; an image outside ECR has none', async () => {
    const fake = fakeSources({ tags: { [digest('1')]: [sha('5')] } });
    const versionOf = createVersionReader(fake, NOW);
    expect(await versionOf(image('motir/edge-cache', '1'))).toEqual({
      commit: { sha: sha('5'), repository: null, url: null },
      judgement: { state: 'unknown', reason: 'source_not_mapped' },
    });
    expect(await versionOf(`ghcr.io/motir-co/sidecar:${sha('5')}`)).toEqual({
      commit: null,
      judgement: { state: 'unknown', reason: 'source_not_mapped' },
    });
    expect(fake.calls.heads).toEqual([]);
  });

  it('a GitHub refusal — of the head or of the compare — is Unknown · github_not_read, the commit still linked', async () => {
    const headDown = fakeSources({
      tags: { [digest('1')]: [sha('e')] },
      heads: { 'motir-ai': new TypeError('fetch failed') },
    });
    const read = await createVersionReader(headDown, NOW)(image('motir/motir-ai', '1'));
    expect(read.judgement).toEqual({ state: 'unknown', reason: 'github_not_read' });
    expect(read.commit).toMatchObject({ sha: sha('e'), url: expect.stringContaining('/commit/') });

    const compareDown = fakeSources({ tags: { [digest('1')]: [sha('e')] } });
    compareDown.github.compare = () => Promise.reject('nope');
    expect(
      (await createVersionReader(compareDown, NOW)(image('motir/motir-ai', '1'))).judgement,
    ).toEqual({
      state: 'unknown',
      reason: 'github_not_read',
    });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('[admin] services version read failed', {
      repository: 'motir/motir-ai',
      reason: 'github_not_read',
      error: 'unknown',
    });

    const undated = fakeSources({
      tags: { [digest('1')]: [sha('e')] },
      compares: {
        [`motir-ai@${sha('e')}`]: { relation: 'ahead', aheadBy: 1, oldestAheadAt: null },
      },
    });
    expect(
      (await createVersionReader(undated, NOW)(image('motir/motir-ai', '1'))).judgement,
    ).toEqual({
      state: 'unknown',
      reason: 'github_not_read',
    });
  });

  it('a failure that is not a read failure is not swallowed', async () => {
    const fake = fakeSources();
    fake.ecr.tagsOf = () => Promise.resolve(null as unknown as string[]);
    await expect(createVersionReader(fake, NOW)(image('motir/motir-ai', '1'))).rejects.toThrow(
      TypeError,
    );
  });
});

describe('the version on the row and the header counts', () => {
  const latest: DeploymentVersionRead = {
    commit: { sha: sha('a'), repository: 'motir-core', url: 'u' },
    judgement: { state: 'latest' },
  };
  const behind = (severity: 'fresh' | 'stale'): DeploymentVersionRead => ({
    commit: latest.commit,
    judgement: {
      state: 'behind',
      count: 2,
      oldestUndeployedAt: minutesAgo(severity === 'stale' ? 60 : 5),
      severity,
      compareUrl: 'c',
    },
  });
  const unknown: DeploymentVersionRead = {
    commit: null,
    judgement: { state: 'unknown', reason: 'ecr_not_read' },
  };
  const rollingService = (name: string) =>
    service(name, {
      deployments: [dep({ taskDefinitionArn: td(name, 4), rolloutState: 'IN_PROGRESS' })],
    });

  it('a steady row carries its PRIMARY deployment’s commit and judgement; a rolling one says rolling', () => {
    expect(judgeService(service('web'), latest)).toMatchObject({
      commit: latest.commit,
      version: { state: 'latest' },
    });
    expect(judgeService(rollingService('web'), behind('stale')).version).toEqual({
      state: 'rolling',
      primary: behind('stale').judgement,
    });
    // A version never read is Unknown, never Latest.
    expect(judgeService(service('web')).version).toEqual({
      state: 'unknown',
      reason: 'ecr_not_read',
    });
  });

  it('the image read is the PRIMARY deployment’s, not the draining one’s', () => {
    const svc = service('web', {
      deployments: [
        dep({ taskDefinitionArn: td('web', 5), rolloutState: 'IN_PROGRESS' }),
        dep({ status: 'ACTIVE', taskDefinitionArn: td('web', 4) }),
      ],
      current: td('web', 5),
      images: {
        [td('web', 5)]: image('motir/motir-core', '5'),
        [td('web', 4)]: image('motir/motir-core', '4'),
      },
    });
    expect(primaryImageOf(svc)).toBe(image('motir/motir-core', '5'));
    expect(primaryImageOf({ ...svc, taskDefinitions: {} })).toBeNull();
  });

  it('counts stale-or-diverged rows, a rolling one by its primary, and never behind-fresh', () => {
    const versions = new Map<string, DeploymentVersionRead>([
      ['a', latest],
      ['b', behind('fresh')],
      ['c', behind('stale')],
      ['d', { commit: null, judgement: { state: 'diverged' } }],
      ['e', behind('stale')],
      ['f', unknown],
    ]);
    const judged = judgeCluster(
      [service('a'), service('b'), service('c'), service('d'), rollingService('e'), service('f')],
      versions,
    );
    expect(judged).toMatchObject({ staleOrDiverged: 3, versionsNotRead: false, rolling: 1 });
  });

  it('versions are "not read" only when there are rows and not one was judged', () => {
    expect(judgeCluster([service('a'), rollingService('b')])).toMatchObject({
      staleOrDiverged: 0,
      versionsNotRead: true,
    });
    expect(judgeCluster([])).toMatchObject({ staleOrDiverged: 0, versionsNotRead: false });
    expect(judgeCluster([service('a'), service('b')], new Map([['a', latest]]))).toMatchObject({
      versionsNotRead: false,
    });
  });
});

describe('platformServicesService.read — the deployed commits', () => {
  it('reads each service’s PRIMARY image and judges it, sharing the motir-core compare', async () => {
    await signInAs('superadmin');
    const core = image('motir/motir-core', '1');
    const services = ['motir-core-web', 'motir-core-worker', 'motir-core-relay'].map((name) =>
      service(name, { images: { [td(name, 4)]: core } }),
    );
    services.push(
      service('motir-ai-planning', {
        images: { [td('motir-ai-planning', 4)]: image('motir/motir-ai', '2') },
      }),
    );
    const fake = fakeSources({
      tags: { [digest('1')]: [sha('e')], [digest('2')]: [sha('b')] },
      compares: {
        [`motir-core@${sha('e')}`]: {
          relation: 'ahead',
          aheadBy: 2,
          oldestAheadAt: minutesAgo(10),
        },
      },
    });
    const dto = await platformServicesService.read({
      reader: reader(services),
      versionSources: fake,
      now: NOW,
    });
    expect(dto.read.status).toBe('ok');
    if (dto.read.status !== 'ok') return;
    expect(Object.fromEntries(dto.read.services.map((r) => [r.name, r.version.state]))).toEqual({
      'motir-ai-planning': 'latest',
      'motir-core-relay': 'behind',
      'motir-core-web': 'behind',
      'motir-core-worker': 'behind',
    });
    expect(dto.read).toMatchObject({ staleOrDiverged: 0, versionsNotRead: false });
    expect(fake.calls.compares).toHaveLength(1);
    expect(fake.calls.tags).toHaveLength(2);
  });

  it('with no version sources handed in, reads ECR and GitHub through the defaults, and a failure is the row’s', async () => {
    await signInAs('superadmin');
    vi.spyOn(ECRClient.prototype, 'send').mockRejectedValue(
      new Error('CredentialsProviderError') as never,
    );
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const dto = await platformServicesService.read({
        reader: reader([
          service('web', { images: { [td('web', 4)]: image('motir/motir-core', '1') } }),
          service('edge', { images: { [td('edge', 4)]: `${REGISTRY}/motir/edge:${sha('c')}` } }),
        ]),
        now: NOW,
      });
      expect(dto.read.status === 'ok' && dto.read.services.map((r) => r.version)).toEqual([
        { state: 'unknown', reason: 'github_not_read' },
        { state: 'unknown', reason: 'ecr_not_read' },
      ]);
      expect(fetch).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
