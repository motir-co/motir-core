/**
 * The AWS calls the core deploy script makes (Story MOTIR-9709 · MOTIR-9927),
 * behind one port so the whole ordering is testable with a recording fake and a
 * fake clock. `awsSdkPorts` is the thin production adapter: no logic, one SDK
 * command per method.
 *
 * ⚠️ DEFAULT CREDENTIAL CHAIN ONLY. No client is given a `credentials` option and
 * nothing here reads a key variable: CI hands the script the deploy role it
 * assumed through GitHub OIDC, in its environment.
 */
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeImagesCommand, ECRClient, ImageNotFoundException } from '@aws-sdk/client-ecr';
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListServicesCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  UpdateServiceCommand,
  type RegisterTaskDefinitionCommandInput,
  type RunTaskCommandInput,
  type Service,
  type Task,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Every action the deploy role grants the script (motir-infra's
 * `coreDeployStatements`, less `ecr:BatchGetImage`, which only ECS uses, and
 * `iam:PassRole`, which ECS checks when a task definition names a role).
 */
export const GRANTED_ACTIONS = [
  'ecr:DescribeImages',
  'ssm:GetParameter',
  'ssm:PutParameter',
  'ecs:RegisterTaskDefinition',
  'ecs:DescribeTaskDefinition',
  'ecs:RunTask',
  'ecs:DescribeTasks',
  'ecs:StopTask',
  'ecs:ListServices',
  'ecs:DescribeServices',
  'ecs:UpdateService',
  'logs:GetLogEvents',
] as const;

export type GrantedAction = (typeof GRANTED_ACTIONS)[number];

export type RegisterTaskDefinitionInput = RegisterTaskDefinitionCommandInput;

/** One method per AWS call the script makes, plus the clock it waits on. */
export interface DeployAws {
  getParameter(name: string): Promise<string | undefined>;
  putParameter(name: string, value: string): Promise<void>;
  /** Whether the repository holds an image with this digest. */
  imageExists(repositoryName: string, digest: string): Promise<boolean>;
  describeTaskDefinition(familyOrArn: string): Promise<TaskDefinition>;
  /** Registers a revision and returns its ARN. */
  registerTaskDefinition(input: RegisterTaskDefinitionInput): Promise<string>;
  /** Starts one task and returns its ARN; throws when ECS reports a failure. */
  runTask(input: RunTaskCommandInput): Promise<string>;
  describeTask(cluster: string, taskArn: string): Promise<Task | undefined>;
  stopTask(cluster: string, taskArn: string, reason: string): Promise<void>;
  listServices(cluster: string): Promise<string[]>;
  describeServices(cluster: string, services: string[]): Promise<Service[]>;
  updateService(cluster: string, service: string, taskDefinition: string): Promise<void>;
  /** The last `limit` lines of a log stream, oldest first. */
  tailLog(group: string, stream: string, limit: number): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The action each port method issues, for the test that holds them to the grant. */
export const ACTION_OF: Record<Exclude<keyof DeployAws, 'sleep' | 'now'>, GrantedAction> = {
  getParameter: 'ssm:GetParameter',
  putParameter: 'ssm:PutParameter',
  imageExists: 'ecr:DescribeImages',
  describeTaskDefinition: 'ecs:DescribeTaskDefinition',
  registerTaskDefinition: 'ecs:RegisterTaskDefinition',
  runTask: 'ecs:RunTask',
  describeTask: 'ecs:DescribeTasks',
  stopTask: 'ecs:StopTask',
  listServices: 'ecs:ListServices',
  describeServices: 'ecs:DescribeServices',
  updateService: 'ecs:UpdateService',
  tailLog: 'logs:GetLogEvents',
};

/** DescribeServices takes at most this many services per call. */
const DESCRIBE_SERVICES_BATCH = 10;

/** The production adapter, on the SDK's default credential chain. */
export function awsSdkPorts(region: string): DeployAws {
  const ecs = new ECSClient({ region });
  const ssm = new SSMClient({ region });
  const ecr = new ECRClient({ region });
  const logs = new CloudWatchLogsClient({ region });
  return {
    async getParameter(name) {
      const out = await ssm.send(new GetParameterCommand({ Name: name }));
      return out.Parameter?.Value;
    },
    async putParameter(name, value) {
      await ssm.send(new PutParameterCommand({ Name: name, Value: value, Overwrite: true }));
    },
    async imageExists(repositoryName, digest) {
      try {
        const out = await ecr.send(
          new DescribeImagesCommand({ repositoryName, imageIds: [{ imageDigest: digest }] }),
        );
        return (out.imageDetails ?? []).length > 0;
      } catch (err) {
        if (err instanceof ImageNotFoundException) return false;
        throw err;
      }
    },
    async describeTaskDefinition(familyOrArn) {
      const out = await ecs.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: familyOrArn }),
      );
      if (!out.taskDefinition) throw new Error(`no task definition ${familyOrArn}`);
      return out.taskDefinition;
    },
    async registerTaskDefinition(input) {
      const out = await ecs.send(new RegisterTaskDefinitionCommand(input));
      const arn = out.taskDefinition?.taskDefinitionArn;
      if (!arn) throw new Error(`registering ${input.family} returned no ARN`);
      return arn;
    },
    async runTask(input) {
      const out = await ecs.send(new RunTaskCommand(input));
      const arn = out.tasks?.[0]?.taskArn;
      if (!arn) {
        const reasons = (out.failures ?? []).map((f) => f.reason ?? 'unknown').join(', ');
        throw new Error(`RunTask started no task: ${reasons || 'no reason given'}`);
      }
      return arn;
    },
    async describeTask(cluster, taskArn) {
      const out = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
      return out.tasks?.[0];
    },
    async stopTask(cluster, taskArn, reason) {
      await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason }));
    },
    async listServices(cluster) {
      const arns: string[] = [];
      let nextToken: string | undefined;
      do {
        const out = await ecs.send(new ListServicesCommand({ cluster, nextToken }));
        arns.push(...(out.serviceArns ?? []));
        nextToken = out.nextToken;
      } while (nextToken);
      return arns;
    },
    async describeServices(cluster, services) {
      const found: Service[] = [];
      for (let i = 0; i < services.length; i += DESCRIBE_SERVICES_BATCH) {
        const batch = services.slice(i, i + DESCRIBE_SERVICES_BATCH);
        const out = await ecs.send(new DescribeServicesCommand({ cluster, services: batch }));
        found.push(...(out.services ?? []));
      }
      return found;
    },
    async updateService(cluster, service, taskDefinition) {
      await ecs.send(new UpdateServiceCommand({ cluster, service, taskDefinition }));
    },
    async tailLog(group, stream, limit) {
      const out = await logs.send(
        new GetLogEventsCommand({
          logGroupName: group,
          logStreamName: stream,
          limit,
          startFromHead: false,
        }),
      );
      return (out.events ?? []).map((e) => e.message ?? '');
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
