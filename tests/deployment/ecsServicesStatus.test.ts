import { readFileSync } from 'node:fs';
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_STATUS_TIMEOUT_MS } from '@/lib/deployment/deploymentStatus';
import {
  createEcsDeploymentStatusProvider,
  ecsDeploymentConfig,
  ecsDeploymentStatusProvider,
  foldServices,
  type DescribeServices,
  type EcsServiceRow,
} from '@/lib/deployment/adapters/ecs/ecsServicesStatus';

// THE DEPLOYMENT-STATUS PORT'S ECS ADAPTER (MOTIR-10952). The injected describe
// is the seam: each answer below is DescribeServices' own shape, trimmed to the
// fields the adapter reads — two of core's services in a shared cluster, each a
// task-definition family of its own.

const ARN = 'arn:aws:ecs:us-east-1:111122223333:task-definition';

function service(
  name: string,
  over: Partial<EcsServiceRow> & { revision?: number } = {},
): EcsServiceRow {
  const revision = over.revision ?? 7;
  return {
    serviceName: name,
    status: 'ACTIVE',
    runningCount: 2,
    pendingCount: 0,
    desiredCount: 2,
    deployments: [
      {
        status: 'PRIMARY',
        rolloutState: 'COMPLETED',
        taskDefinition: `${ARN}/${name}:${revision}`,
        createdAt: new Date('2026-11-10T09:00:00Z'),
      },
    ],
    ...over,
  };
}

function configure(services = 'motir-core-web,motir-core-worker', cluster = 'motir-core') {
  vi.stubEnv('MOTIR_ECS_CLUSTER', cluster);
  vi.stubEnv('MOTIR_DEPLOYMENT_ECS_SERVICES', services);
}

/** A describe that answers from a fixed set of rows, recording what it was asked. */
function describeFrom(rows: EcsServiceRow[], failures: { arn?: string; reason?: string }[] = []) {
  return vi.fn<DescribeServices>(async ({ services }) => ({
    services: rows.filter((row) => services.includes(row.serviceName ?? '')),
    failures,
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ecsDeploymentStatusProvider.read — over an injected describe', () => {
  it('reports every service at its desired count, each with its own release', async () => {
    configure();
    const describe = describeFrom([
      service('motir-core-web', { revision: 41 }),
      service('motir-core-worker', {
        runningCount: 1,
        desiredCount: 1,
        revision: 17,
        deployments: [
          {
            status: 'PRIMARY',
            rolloutState: 'COMPLETED',
            taskDefinition: `${ARN}/motir-core-worker:17`,
          },
        ],
      }),
    ]);

    const status = await createEcsDeploymentStatusProvider(describe).read();

    expect(status).toEqual({
      groups: [
        {
          name: 'motir-core-web',
          started: 2,
          total: 2,
          expected: 2,
          release: 'motir-core-web:41',
          rolling: false,
        },
        {
          name: 'motir-core-worker',
          started: 1,
          total: 1,
          expected: 1,
          release: 'motir-core-worker:17',
          rolling: false,
        },
      ],
    });
    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe.mock.calls[0]![0]).toMatchObject({
      cluster: 'motir-core',
      services: ['motir-core-web', 'motir-core-worker'],
    });
    expect(describe.mock.calls[0]![0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('reports a service short of its desired count, counting its pending tasks in the total', async () => {
    configure();
    const describe = describeFrom([
      service('motir-core-web'),
      service('motir-core-worker', { runningCount: 0, pendingCount: 1, desiredCount: 1 }),
    ]);

    const status = await createEcsDeploymentStatusProvider(describe).read();

    expect(status.groups[1]).toMatchObject({
      name: 'motir-core-worker',
      started: 0,
      total: 1,
      expected: 1,
      rolling: false,
    });
  });

  it('marks a service with two deployments in play as rolling, on its PRIMARY release', async () => {
    configure('motir-core-web');
    const describe = describeFrom([
      service('motir-core-web', {
        deployments: [
          {
            status: 'ACTIVE',
            rolloutState: 'COMPLETED',
            taskDefinition: `${ARN}/motir-core-web:41`,
            createdAt: new Date('2026-11-10T09:00:00Z'),
          },
          {
            status: 'PRIMARY',
            rolloutState: 'IN_PROGRESS',
            taskDefinition: `${ARN}/motir-core-web:42`,
            createdAt: new Date('2026-11-12T09:00:00Z'),
          },
        ],
      }),
    ]);

    const [web] = (await createEcsDeploymentStatusProvider(describe).read()).groups;

    expect(web).toMatchObject({ release: 'motir-core-web:42', rolling: true });
  });

  it('marks a service whose single rollout FAILED as rolling', async () => {
    configure('motir-core-web');
    const describe = describeFrom([
      service('motir-core-web', {
        deployments: [
          { status: 'PRIMARY', rolloutState: 'FAILED', taskDefinition: `${ARN}/motir-core-web:9` },
        ],
      }),
    ]);

    const [web] = (await createEcsDeploymentStatusProvider(describe).read()).groups;

    expect(web).toMatchObject({ release: 'motir-core-web:9', rolling: true });
  });

  it('throws, naming the service, when a requested service is absent from the answer', async () => {
    configure();
    const describe = describeFrom([service('motir-core-web')]);

    await expect(createEcsDeploymentStatusProvider(describe).read()).rejects.toThrow(
      /motir-core-worker/,
    );
  });

  it('throws, naming the service, when the answer carries a failures entry', async () => {
    configure();
    const describe = describeFrom(
      [service('motir-core-web')],
      [
        {
          arn: 'arn:aws:ecs:us-east-1:111122223333:service/motir-core/motir-core-worker',
          reason: 'MISSING',
        },
      ],
    );

    await expect(createEcsDeploymentStatusProvider(describe).read()).rejects.toThrow(
      /motir-core-worker \(MISSING\)/,
    );
  });

  it('propagates a rejected read rather than reporting an empty fleet', async () => {
    configure();
    const describe = vi.fn<DescribeServices>(async () => {
      throw new Error('AccessDeniedException');
    });

    await expect(createEcsDeploymentStatusProvider(describe).read()).rejects.toThrow(
      'AccessDeniedException',
    );
  });

  it('describes more than ten services in batches of at most ten, keeping the requested order', async () => {
    const names = Array.from({ length: 23 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
    configure(names.join(','));
    const describe = describeFrom(names.map((name) => service(name)));

    const status = await createEcsDeploymentStatusProvider(describe).read();

    expect(describe.mock.calls.map(([input]) => input.services.length)).toEqual([10, 10, 3]);
    expect(status.groups.map((g) => g.name)).toEqual(names);
  });

  it('throws without a describe call when the configuration is missing', async () => {
    configure('');
    const describe = describeFrom([]);

    await expect(createEcsDeploymentStatusProvider(describe).read()).rejects.toThrow(
      /MOTIR_ECS_CLUSTER or MOTIR_DEPLOYMENT_ECS_SERVICES unset/,
    );
    expect(describe).not.toHaveBeenCalled();
  });
});

describe('configured() and ecsDeploymentConfig()', () => {
  it('is configured with a cluster and at least one service name', () => {
    configure(' motir-core-web , motir-core-worker,,motir-core-web ');
    expect(ecsDeploymentStatusProvider.configured()).toBe(true);
    expect(ecsDeploymentConfig()).toEqual({
      cluster: 'motir-core',
      services: ['motir-core-web', 'motir-core-worker'],
    });
  });

  it('is not configured when MOTIR_ECS_CLUSTER is absent — there is no default cluster', () => {
    vi.stubEnv('MOTIR_ECS_CLUSTER', '');
    vi.stubEnv('MOTIR_DEPLOYMENT_ECS_SERVICES', 'motir-core-web');
    expect(ecsDeploymentStatusProvider.configured()).toBe(false);
    vi.stubEnv('MOTIR_ECS_CLUSTER', undefined as unknown as string);
    expect(ecsDeploymentConfig()).toBeNull();
  });

  it('is not configured when MOTIR_DEPLOYMENT_ECS_SERVICES is absent or names nothing', () => {
    configure(' , ');
    expect(ecsDeploymentStatusProvider.configured()).toBe(false);
    vi.stubEnv('MOTIR_DEPLOYMENT_ECS_SERVICES', undefined as unknown as string);
    expect(ecsDeploymentConfig()).toBeNull();
  });
});

describe('foldServices', () => {
  it('reports a service at zero desired and zero running as a zero-of-zero group', () => {
    const status = foldServices(
      [service('motir-core-relay', { runningCount: 0, desiredCount: 0 })],
      ['motir-core-relay'],
    );
    expect(status.groups).toEqual([
      {
        name: 'motir-core-relay',
        started: 0,
        total: 0,
        expected: 0,
        release: 'motir-core-relay:7',
        rolling: false,
      },
    ]);
  });

  it('takes the NEWEST deployment as the release when none is marked PRIMARY', () => {
    const [group] = foldServices(
      [
        service('svc', {
          deployments: [
            { status: 'ACTIVE', taskDefinition: `${ARN}/svc:1`, createdAt: new Date(1) },
            { status: 'ACTIVE', taskDefinition: `${ARN}/svc:2`, createdAt: new Date(2) },
          ],
        }),
      ],
      ['svc'],
    ).groups;
    expect(group).toMatchObject({ release: 'svc:2', rolling: true });
  });

  it('answers a null release when no deployment carries a task definition, and defaults missing counts to zero', () => {
    const [group] = foldServices(
      [{ serviceName: 'svc', status: 'ACTIVE', deployments: [{ status: 'PRIMARY' }] }],
      ['svc'],
    ).groups;
    expect(group).toEqual({
      name: 'svc',
      started: 0,
      total: 0,
      expected: 0,
      release: null,
      rolling: false,
    });
    expect(
      foldServices([{ serviceName: 'bare', status: 'ACTIVE' }], ['bare']).groups[0],
    ).toMatchObject({
      release: null,
      rolling: false,
    });
  });

  it('keeps a release that is not an ARN as it was given, and ignores a row with no name', () => {
    const status = foldServices(
      [
        {},
        service('svc', {
          deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: 'svc:3' }],
        }),
      ],
      ['svc'],
    );
    expect(status.groups[0]?.release).toBe('svc:3');
  });

  it.each(['DRAINING', 'INACTIVE'])(
    'throws, naming the service and its status, when a requested service is %s — a deleted service is not a steady 0/0',
    (state) => {
      const deleted = service('motir-core-worker', {
        status: state,
        runningCount: 0,
        desiredCount: 0,
      });
      expect(() =>
        foldServices([service('motir-core-web'), deleted], ['motir-core-web', 'motir-core-worker']),
      ).toThrow(`deployment status: ECS service motir-core-worker is ${state}`);
    },
  );

  it('throws when a requested service carries no status at all, rather than assuming it is ACTIVE', () => {
    expect(() => foldServices([{ serviceName: 'svc' }], ['svc'])).toThrow(
      'deployment status: ECS service svc is of unknown status',
    );
  });

  it('names an unnamed failure and a failure with no reason rather than dropping them', () => {
    expect(() => foldServices([], [], [{}])).toThrow(/\(unnamed\) \(no reason\)/);
  });
});

describe('the real binding', () => {
  it('sends one DescribeServicesCommand per batch through an ECSClient, bounded by the timeout', async () => {
    configure('motir-core-web');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const send = vi.spyOn(ECSClient.prototype, 'send').mockImplementation((async (
      command: unknown,
    ) => {
      expect(command).toBeInstanceOf(DescribeServicesCommand);
      expect((command as DescribeServicesCommand).input).toEqual({
        cluster: 'motir-core',
        services: ['motir-core-web'],
      });
      return { services: [service('motir-core-web')], failures: [] };
    }) as never);

    const status = await ecsDeploymentStatusProvider.read();

    expect(status.groups).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ abortSignal: expect.any(AbortSignal) });
    expect(timeout).toHaveBeenCalledWith(DEPLOYMENT_STATUS_TIMEOUT_MS);
  });

  it('imports and sends no ECS command but DescribeServices', () => {
    // The module's own source is the evidence the PR quotes: the one action
    // motir-infra's ServicesReadDescribe statement allows, and no other.
    const source = readFileSync('lib/deployment/adapters/ecs/ecsServicesStatus.ts', 'utf8');
    const commands = [...source.matchAll(/\b([A-Z][A-Za-z]+Command)\b/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(['DescribeServicesCommand']));
  });
});
