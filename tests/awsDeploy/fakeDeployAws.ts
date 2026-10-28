import type { ContainerDefinition, Service, Task, TaskDefinition } from '@aws-sdk/client-ecs';
import type { DeployAws, RegisterTaskDefinitionInput } from '@/scripts/aws-deploy/ports';
import { ACTION_OF } from '@/scripts/aws-deploy/ports';

// MOTIR-9927 — a recording DeployAws: every call lands in `calls` (method name
// first), the clock only moves through `sleep`, and the migrate task and each
// service's rollout follow scripts a test sets.

export const ACCOUNT = '111122223333';
export const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
export const CORE_REPO = `${REGISTRY}/motir-prod/motir-core`;
export const OTHER_REPO = `${REGISTRY}/motir-prod/motir-ai`;
export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const OLD_DIGEST = `sha256:${'0'.repeat(64)}`;
export const PREFIX = 'motir-prod';
export const CLUSTER = 'motir-prod-core';
export const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:motir-prod/core/database-owner-AbCdEf`;
export const DATABASE_URL = 'postgresql://owner:hunter2@db.internal:5432/motir_core';

export const TARGET = {
  cluster: CLUSTER,
  subnets: ['subnet-1', 'subnet-2'],
  securityGroups: ['sg-1'],
  migrateFamily: 'motir-prod-core-migrate',
  migrateContainer: 'migrate',
  region: 'us-east-1',
};

const tdArn = (family: string, revision: number) =>
  `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${family}:${String(revision)}`;

/** A realistic DescribeTaskDefinition result: read-only fields, secrets, logging. */
export function taskDefinition(
  family: string,
  revision: number,
  containers: ContainerDefinition[],
): TaskDefinition {
  return {
    taskDefinitionArn: tdArn(family, revision),
    family,
    revision,
    status: 'ACTIVE',
    taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/${family}-task`,
    executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/${family}-exec`,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    compatibilities: ['EC2', 'FARGATE'],
    requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.logging-driver.awslogs' }],
    cpu: '512',
    memory: '1024',
    registeredAt: new Date('2026-10-27T10:00:00Z'),
    registeredBy: `arn:aws:sts::${ACCOUNT}:assumed-role/cdk-deploy/session`,
    containerDefinitions: containers,
  };
}

export function container(name: string, image: string): ContainerDefinition {
  return {
    name,
    image,
    essential: true,
    secrets: [{ name: 'MOTIR_DB_PASSWORD', valueFrom: `${SECRET_ARN}:password::` }],
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': `/motir-prod/core/${name}`,
        'awslogs-stream-prefix': name,
        'awslogs-region': 'us-east-1',
      },
    },
  };
}

export type MigrateScript = (poll: number) => Task | undefined;
export type RolloutScript = (
  poll: number,
  rolledTo: string,
  previous: string,
) => { primary: string; state: string };

export const migrateExits =
  (exitCode: number, afterPolls = 1): MigrateScript =>
  (poll) =>
    poll < afterPolls
      ? { lastStatus: 'RUNNING' }
      : { lastStatus: 'STOPPED', containers: [{ name: 'migrate', exitCode }] };

export const completesAfter =
  (polls: number): RolloutScript =>
  (poll, rolledTo) => ({ primary: rolledTo, state: poll < polls ? 'IN_PROGRESS' : 'COMPLETED' });

export class FakeDeployAws implements DeployAws {
  readonly calls: string[][] = [];
  readonly registered: RegisterTaskDefinitionInput[] = [];
  readonly params = new Map<string, string>();
  readonly images = new Set<string>([`motir-prod/motir-core|${DIGEST}`]);
  readonly logLines: string[] = [];
  migrate: MigrateScript = migrateExits(0);
  rollouts = new Map<string, RolloutScript>();
  /** name → current task definition ARN */
  readonly services = new Map<string, string>();
  private readonly definitions = new Map<string, TaskDefinition>();
  private readonly rolledTo = new Map<string, string>();
  private readonly polls = new Map<string, number>();
  private clock = 0;
  migratePolls = 0;
  failUpdateOf: string | null = null;

  constructor() {
    this.params.set(`/${PREFIX}/core/deploy-target`, JSON.stringify(TARGET));
    this.params.set(`/${PREFIX}/core/image-digest`, OLD_DIGEST);
    this.addDefinition(
      taskDefinition(TARGET.migrateFamily, 3, [container('migrate', `${CORE_REPO}@${OLD_DIGEST}`)]),
    );
  }

  addDefinition(definition: TaskDefinition): string {
    const arn = definition.taskDefinitionArn ?? '';
    this.definitions.set(arn, definition);
    this.definitions.set(definition.family ?? '', definition);
    return arn;
  }

  /** A service running one container from `repository`. */
  addService(name: string, repository: string, rollout: RolloutScript = completesAfter(1)) {
    const arn = this.addDefinition(
      taskDefinition(`motir-prod-core-${name}`, 7, [
        container(name, `${repository}@${OLD_DIGEST}`),
      ]),
    );
    this.services.set(name, arn);
    this.rollouts.set(name, rollout);
    return arn;
  }

  /** The AWS action names issued, in order. */
  actions(): string[] {
    return this.calls.map(([method]) => ACTION_OF[method as keyof typeof ACTION_OF] ?? method);
  }

  methods(): string[] {
    return this.calls.map(([method]) => method ?? '');
  }

  private record(method: string, ...args: string[]) {
    this.calls.push([method, ...args]);
  }

  getParameter(name: string) {
    this.record('getParameter', name);
    return Promise.resolve(this.params.get(name));
  }

  putParameter(name: string, value: string) {
    this.record('putParameter', name, value);
    this.params.set(name, value);
    return Promise.resolve();
  }

  imageExists(repositoryName: string, digest: string) {
    this.record('imageExists', repositoryName, digest);
    return Promise.resolve(this.images.has(`${repositoryName}|${digest}`));
  }

  describeTaskDefinition(familyOrArn: string) {
    this.record('describeTaskDefinition', familyOrArn);
    const found = this.definitions.get(familyOrArn);
    return found ? Promise.resolve(structuredClone(found)) : Promise.reject(new Error('no such'));
  }

  registerTaskDefinition(input: RegisterTaskDefinitionInput) {
    this.record('registerTaskDefinition', input.family ?? '');
    this.registered.push(structuredClone(input));
    const latest = this.definitions.get(input.family ?? '');
    const revision = (latest?.revision ?? 0) + 1;
    return Promise.resolve(
      this.addDefinition({
        ...input,
        revision,
        taskDefinitionArn: tdArn(input.family ?? '', revision),
      }),
    );
  }

  runTask(input: Parameters<DeployAws['runTask']>[0]) {
    this.record('runTask', JSON.stringify(input));
    return Promise.resolve(`arn:aws:ecs:us-east-1:${ACCOUNT}:task/${CLUSTER}/abc123`);
  }

  describeTask(cluster: string, taskArn: string) {
    this.record('describeTask', cluster, taskArn);
    return Promise.resolve(this.migrate(this.migratePolls++));
  }

  stopTask(cluster: string, taskArn: string, reason: string) {
    this.record('stopTask', cluster, taskArn, reason);
    return Promise.resolve();
  }

  listServices(cluster: string) {
    this.record('listServices', cluster);
    return Promise.resolve(
      [...this.services.keys()].map(
        (n) => `arn:aws:ecs:us-east-1:${ACCOUNT}:service/${cluster}/${n}`,
      ),
    );
  }

  describeServices(cluster: string, services: string[]) {
    this.record('describeServices', cluster, ...services);
    return Promise.resolve(
      services.map((s): Service => {
        const name = s.slice(s.lastIndexOf('/') + 1);
        const current = this.services.get(name) ?? '';
        const rolledTo = this.rolledTo.get(name);
        if (!rolledTo) return { serviceName: name, taskDefinition: current };
        const poll = this.polls.get(name) ?? 0;
        this.polls.set(name, poll + 1);
        const script = this.rollouts.get(name) ?? completesAfter(1);
        const { primary, state } = script(poll, rolledTo, current);
        return {
          serviceName: name,
          taskDefinition: primary,
          deployments: [
            { status: 'PRIMARY', taskDefinition: primary, rolloutState: state as never },
          ],
        };
      }),
    );
  }

  updateService(cluster: string, service: string, taskDefinition: string) {
    this.record('updateService', cluster, service, taskDefinition);
    if (this.failUpdateOf === service)
      return Promise.reject(new Error(`update ${service} refused`));
    if (this.rolledTo.has(service)) {
      // A rollback: the service is back on the revision it is given.
      this.rolledTo.delete(service);
      this.services.set(service, taskDefinition);
    } else {
      this.rolledTo.set(service, taskDefinition);
    }
    return Promise.resolve();
  }

  tailLog(group: string, stream: string, limit: number) {
    this.record('tailLog', group, stream, String(limit));
    return Promise.resolve(this.logLines.slice(-limit));
  }

  sleep(ms: number) {
    this.clock += ms;
    return Promise.resolve();
  }

  now() {
    return this.clock;
  }
}
