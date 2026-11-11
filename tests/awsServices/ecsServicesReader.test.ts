import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import {
  createEcsServicesReader,
  FARGATE_ON_DEMAND_VCPU_QUOTA,
} from '@/lib/awsServices/ecsServicesReader';

// THE SERVICES PAGE'S AWS READ (MOTIR-10890). The SDK clients are driven at
// their `send` — the one seam every command goes through — so what is asserted
// is the commands the reader sends and the plain objects it answers with.

const ACCOUNT = '123456789012';
const arn = (kind: string, rest: string) => `arn:aws:ecs:eu-central-1:${ACCOUNT}:${kind}/${rest}`;
const td = (family: string, revision: number) => arn('task-definition', `${family}:${revision}`);

type Sent = ListServicesCommand | DescribeServicesCommand | DescribeTaskDefinitionCommand;

function ecsAnswering(answer: (command: Sent) => unknown) {
  return vi
    .spyOn(ECSClient.prototype, 'send')
    .mockImplementation((async (command: Sent) => answer(command)) as never);
}

const sizes: Record<string, { cpu?: string; memory?: string }> = {
  [td('web', 3)]: { cpu: '1024', memory: '2048' },
  [td('web', 4)]: { cpu: '1024', memory: '2048' },
  [td('worker', 7)]: { cpu: '256', memory: '512' },
};

function describeTaskDefinition(command: DescribeTaskDefinitionCommand) {
  const id = command.input.taskDefinition!;
  const [, familyRevision] = id.split('/');
  const [family, revision] = familyRevision!.split(':');
  return {
    taskDefinition: { family, revision: Number(revision), ...sizes[id] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listServices', () => {
  it('pages the list, describes in batches of ten, and sizes each task definition once', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
    const send = ecsAnswering((command) => {
      if (command instanceof ListServicesCommand) {
        return command.input.nextToken
          ? { serviceArns: names.slice(6).map((n) => arn('service', `motir-core/${n}`)) }
          : {
              serviceArns: names.slice(0, 6).map((n) => arn('service', `motir-core/${n}`)),
              nextToken: 'page-2',
            };
      }
      if (command instanceof DescribeServicesCommand) {
        return {
          services: command.input.services!.map((serviceArn) => {
            const name = serviceArn.split('/').pop()!;
            const rolling = name === 'svc-00';
            return {
              serviceName: name,
              serviceArn,
              runningCount: 2,
              desiredCount: 2,
              taskDefinition: td('web', 4),
              deployments: rolling
                ? [
                    {
                      status: 'PRIMARY',
                      rolloutState: 'IN_PROGRESS',
                      createdAt: new Date('2026-11-10T10:00:00Z'),
                      runningCount: 1,
                      desiredCount: 2,
                      taskDefinition: td('web', 4),
                    },
                    {
                      status: 'ACTIVE',
                      runningCount: 1,
                      desiredCount: 0,
                      taskDefinition: td('web', 3),
                    },
                  ]
                : [{ status: 'PRIMARY', runningCount: 2, desiredCount: 2 }],
            };
          }),
          failures: [],
        };
      }
      return describeTaskDefinition(command);
    });

    const services = await createEcsServicesReader().listServices('motir-core');

    expect(services.map((s) => s.name)).toEqual(names);
    const describes = send.mock.calls
      .map(([c]) => c)
      .filter((c) => c instanceof DescribeServicesCommand) as DescribeServicesCommand[];
    expect(describes.map((c) => c.input.services!.length)).toEqual([10, 2]);
    expect(describes.every((c) => c.input.cluster === 'motir-core')).toBe(true);
    const sized = send.mock.calls
      .map(([c]) => c)
      .filter((c) => c instanceof DescribeTaskDefinitionCommand) as DescribeTaskDefinitionCommand[];
    expect(sized.map((c) => c.input.taskDefinition).sort()).toEqual([td('web', 3), td('web', 4)]);

    const rolling = services[0]!;
    expect(rolling.deployments[0]).toMatchObject({
      status: 'PRIMARY',
      rolloutState: 'IN_PROGRESS',
      runningCount: 1,
      desiredCount: 2,
    });
    expect(rolling.deployments[1]).toMatchObject({
      status: 'ACTIVE',
      rolloutState: null,
      createdAt: null,
    });
    expect(Object.keys(rolling.taskDefinitions).sort()).toEqual([td('web', 3), td('web', 4)]);
    // A deployment ECS gave no task definition runs the service's own.
    const steady = services[1]!;
    expect(steady.deployments[0]!.taskDefinitionArn).toBe(td('web', 4));
    expect(steady.taskDefinitions).toEqual({
      [td('web', 4)]: { family: 'web', revision: 4, cpuUnits: 1024, memoryMib: 2048 },
    });
  });

  it('answers an empty cluster with no service and no describe call', async () => {
    const send = ecsAnswering(() => ({}));
    await expect(createEcsServicesReader().listServices('motir-core')).resolves.toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('defaults counts ECS left out to 0, and a size it left out or set to nonsense to null', async () => {
    ecsAnswering((command) => {
      if (command instanceof ListServicesCommand) {
        return { serviceArns: [arn('service', 'motir-core/worker')] };
      }
      if (command instanceof DescribeServicesCommand) {
        return {
          services: [
            {
              serviceName: 'worker',
              serviceArn: arn('service', 'motir-core/worker'),
              taskDefinition: td('worker', 7),
              deployments: [{ taskDefinition: td('worker', 7) }],
            },
          ],
        };
      }
      return { taskDefinition: { family: 'worker', revision: 7, cpu: 'lots' } };
    });
    const [worker] = await createEcsServicesReader().listServices('motir-core');
    expect(worker).toMatchObject({ runningCount: 0, desiredCount: 0 });
    expect(worker!.deployments).toEqual([
      {
        status: 'ACTIVE',
        rolloutState: null,
        createdAt: null,
        runningCount: 0,
        desiredCount: 0,
        taskDefinitionArn: td('worker', 7),
      },
    ]);
    expect(worker!.taskDefinitions[td('worker', 7)]).toEqual({
      family: 'worker',
      revision: 7,
      cpuUnits: null,
      memoryMib: null,
    });
  });

  it('fails the read when ECS cannot describe a listed service', async () => {
    ecsAnswering((command) =>
      command instanceof ListServicesCommand
        ? { serviceArns: [arn('service', 'motir-core/odd')] }
        : {
            services: [],
            failures: [{ arn: arn('service', 'motir-core/odd'), reason: 'INTERNAL_ERROR' }],
          },
    );
    await expect(createEcsServicesReader().listServices('motir-core')).rejects.toThrow(
      'could not describe 1 service(s)',
    );
  });

  it('drops a service deleted between the list and the describe (MISSING), and reads the rest', async () => {
    ecsAnswering((command) =>
      command instanceof ListServicesCommand
        ? { serviceArns: [arn('service', 'motir-core/gone')] }
        : {
            services: [],
            failures: [{ arn: arn('service', 'motir-core/gone'), reason: 'MISSING' }],
          },
    );
    await expect(createEcsServicesReader().listServices('motir-core')).resolves.toEqual([]);
  });

  it('fails the read on a described service with no name or task definition', async () => {
    ecsAnswering((command) =>
      command instanceof ListServicesCommand
        ? { serviceArns: [arn('service', 'motir-core/odd')] }
        : { services: [{ serviceArn: arn('service', 'motir-core/odd') }] },
    );
    await expect(createEcsServicesReader().listServices('motir-core')).rejects.toThrow(
      'no name or task definition',
    );
  });

  it('fails the read on a task definition ECS does not describe', async () => {
    ecsAnswering((command) => {
      if (command instanceof ListServicesCommand)
        return { serviceArns: [arn('service', 'motir-core/web')] };
      if (command instanceof DescribeServicesCommand) {
        return {
          services: [
            {
              serviceName: 'web',
              serviceArn: arn('service', 'motir-core/web'),
              taskDefinition: td('web', 4),
            },
          ],
        };
      }
      return {};
    });
    await expect(createEcsServicesReader().listServices('motir-core')).rejects.toThrow(
      'described no task definition',
    );
  });

  it('lets an AWS error through, so the page says ECS did not answer', async () => {
    vi.spyOn(ECSClient.prototype, 'send').mockRejectedValue(new Error('AccessDenied') as never);
    await expect(createEcsServicesReader().listServices('motir-core')).rejects.toThrow(
      'AccessDenied',
    );
  });
});

describe('readFargateVcpuQuota', () => {
  it('reads Fargate On-Demand vCPU, L-3032A538', async () => {
    const send = vi
      .spyOn(ServiceQuotasClient.prototype, 'send')
      .mockResolvedValue({ Quota: { Value: 16 } } as never);
    await expect(createEcsServicesReader().readFargateVcpuQuota()).resolves.toBe(16);
    const [command] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(GetServiceQuotaCommand);
    expect((command as GetServiceQuotaCommand).input).toEqual({
      ServiceCode: FARGATE_ON_DEMAND_VCPU_QUOTA.serviceCode,
      QuotaCode: 'L-3032A538',
    });
  });

  it('fails when Service Quotas returns no value — never a 0', async () => {
    vi.spyOn(ServiceQuotasClient.prototype, 'send').mockResolvedValue({ Quota: {} } as never);
    await expect(createEcsServicesReader().readFargateVcpuQuota()).rejects.toThrow('no value');
  });
});
