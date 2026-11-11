import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';

// THE SERVICES PAGE'S AWS READ (MOTIR-10890) — with `ec2VcpuQuotaReader.ts` (the
// Fleet status page's EC2 quota, MOTIR-10887), the ONLY code in motir-core that
// talks to ECS and Service Quotas about core's OWN account, the way
// `lib/ses/sesClient.ts` is the only one that talks to SES
// (`tests/ciFleet/awsSdkBoundary.test.ts` registers the directory). It answers in
// plain objects, so `platformServicesService` judges what it read with no SDK
// type in sight and its tests drive it with a fake.
//
// ⚠️ NO CREDENTIALS ARE PASSED, DELIBERATELY. The clients resolve them, and the
// region, through the SDK's DEFAULT CHAIN, which on ECS is the web task's role
// served by the container credentials endpoint and the `AWS_REGION` ECS sets.
// Off AWS (a laptop, a self-hosted install) the chain finds nothing and the read
// fails, which the page renders as "ECS did not answer" — never as an empty
// cluster.
//
// ⚠️ READS ONLY. ListServices, DescribeServices, DescribeTaskDefinition and
// GetServiceQuota; the task role is granted exactly these (motir-infra's
// services stack).

/** Fargate On-Demand vCPU resource count — Service Quotas `fargate` / `L-3032A538`. */
export const FARGATE_ON_DEMAND_VCPU_QUOTA = { serviceCode: 'fargate', quotaCode: 'L-3032A538' };

/** DescribeServices takes at most ten services per call. */
const DESCRIBE_BATCH = 10;

/** One deployment of a service, as ECS reports it. */
export interface EcsDeploymentRead {
  /** `PRIMARY` (the newest) or `ACTIVE` (one being drained). */
  status: string;
  /** `IN_PROGRESS` · `COMPLETED` · `FAILED`, or `null` where ECS gives none. */
  rolloutState: string | null;
  createdAt: Date | null;
  runningCount: number;
  desiredCount: number;
  taskDefinitionArn: string;
}

/** A task definition's size — Fargate's task-level `cpu` (units) and `memory` (MiB). */
export interface EcsTaskSizeRead {
  family: string;
  revision: number;
  cpuUnits: number | null;
  memoryMib: number | null;
}

/** One ECS service, with the size of every task definition its deployments run. */
export interface EcsServiceRead {
  name: string;
  arn: string;
  runningCount: number;
  desiredCount: number;
  /** The service's current task definition (the PRIMARY deployment's). */
  taskDefinitionArn: string;
  deployments: EcsDeploymentRead[];
  /** Keyed by task-definition ARN — every one a deployment above runs. */
  taskDefinitions: Record<string, EcsTaskSizeRead>;
}

/** What the page reads from AWS. Each call throws when AWS does not answer. */
export interface EcsServicesReader {
  /** Every service in the cluster, listed from it (never a fixed list). */
  listServices(cluster: string): Promise<EcsServiceRead[]>;
  /** The Fargate On-Demand vCPU quota of this account and region. */
  readFargateVcpuQuota(): Promise<number>;
}

function size(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function listServiceArns(client: ECSClient, cluster: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new ListServicesCommand({ cluster, nextToken, maxResults: 100 }),
    );
    arns.push(...(page.serviceArns ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return arns;
}

async function describeTaskSize(client: ECSClient, arn: string): Promise<EcsTaskSizeRead> {
  const { taskDefinition } = await client.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: arn }),
  );
  if (!taskDefinition?.family || taskDefinition.revision === undefined) {
    throw new Error(`ECS described no task definition for ${arn}`);
  }
  return {
    family: taskDefinition.family,
    revision: taskDefinition.revision,
    cpuUnits: size(taskDefinition.cpu),
    memoryMib: size(taskDefinition.memory),
  };
}

async function describeServices(
  client: ECSClient,
  cluster: string,
  arns: string[],
): Promise<Omit<EcsServiceRead, 'taskDefinitions'>[]> {
  const out: Omit<EcsServiceRead, 'taskDefinitions'>[] = [];
  for (let i = 0; i < arns.length; i += DESCRIBE_BATCH) {
    const { services = [], failures = [] } = await client.send(
      new DescribeServicesCommand({ cluster, services: arns.slice(i, i + DESCRIBE_BATCH) }),
    );
    // A service deleted between ListServices and DescribeServices answers
    // `MISSING`: it is no longer in the cluster, so the cluster without it is
    // the truth. Any OTHER failure is a listed service ECS could not describe —
    // an unread service — and a cluster read missing one is not the cluster:
    // fail the read.
    const unread = failures.filter((f) => f.reason !== 'MISSING');
    if (unread.length > 0) {
      throw new Error(`ECS could not describe ${unread.length} service(s) in ${cluster}`);
    }
    for (const service of services) {
      if (!service.serviceName || !service.serviceArn || !service.taskDefinition) {
        throw new Error(`ECS described a service in ${cluster} with no name or task definition`);
      }
      out.push({
        name: service.serviceName,
        arn: service.serviceArn,
        runningCount: service.runningCount ?? 0,
        desiredCount: service.desiredCount ?? 0,
        taskDefinitionArn: service.taskDefinition,
        deployments: (service.deployments ?? []).map((d) => ({
          status: d.status ?? 'ACTIVE',
          rolloutState: d.rolloutState ?? null,
          createdAt: d.createdAt ?? null,
          runningCount: d.runningCount ?? 0,
          desiredCount: d.desiredCount ?? 0,
          taskDefinitionArn: d.taskDefinition ?? service.taskDefinition!,
        })),
      });
    }
  }
  return out;
}

/** The reader over the default credential chain and region. One attempt per call
 *  beyond the SDK's standard retry: a page load is the retry layer. */
export function createEcsServicesReader(): EcsServicesReader {
  const ecs = new ECSClient({});
  const quotas = new ServiceQuotasClient({});
  return {
    async listServices(cluster) {
      const described = await describeServices(ecs, cluster, await listServiceArns(ecs, cluster));
      const arnsOf = (s: (typeof described)[number]) => [
        ...new Set([s.taskDefinitionArn, ...s.deployments.map((d) => d.taskDefinitionArn)]),
      ];
      // Each task definition is described once, however many services run it.
      const arns = [...new Set(described.flatMap(arnsOf))];
      const sizes = await Promise.all(arns.map((arn) => describeTaskSize(ecs, arn)));
      const byArn = new Map(arns.map((arn, i) => [arn, sizes[i]!]));
      return described.map((service) => ({
        ...service,
        taskDefinitions: Object.fromEntries(arnsOf(service).map((arn) => [arn, byArn.get(arn)!])),
      }));
    },
    async readFargateVcpuQuota() {
      const { Quota } = await quotas.send(
        new GetServiceQuotaCommand({
          ServiceCode: FARGATE_ON_DEMAND_VCPU_QUOTA.serviceCode,
          QuotaCode: FARGATE_ON_DEMAND_VCPU_QUOTA.quotaCode,
        }),
      );
      if (Quota?.Value === undefined) throw new Error('Service Quotas returned no value');
      return Quota.Value;
    },
  };
}
