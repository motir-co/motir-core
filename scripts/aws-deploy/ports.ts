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
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
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
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

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
  // The image pins only (MOTIR-10883, `imagePins.ts`); motir-infra grants them on
  // those secrets alone, with the secrets key through Secrets Manager.
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  // The services stack only (motir-infra's `ReadServicesStack`): the roll waits
  // for an update of it to finish after the migrate (MOTIR-11235), as
  // `deploy-gate.sh` does before the deploy starts (MOTIR-10436).
  'cloudformation:DescribeStacks',
] as const;

export type GrantedAction = (typeof GRANTED_ACTIONS)[number];

export type RegisterTaskDefinitionInput = RegisterTaskDefinitionCommandInput;

/**
 * A secret's current value, or that the role may not read it. `value` is
 * undefined for a secret with no current version.
 */
export type SecretRead = { state: 'granted'; value: string | undefined } | { state: 'not_granted' };

/**
 * An SSM parameter's current value, or that the role may not read it. `value`
 * is undefined for a parameter that does not exist. The image pin the deploy
 * writes as a parameter reads it this way (MOTIR-10986); `getParameter` stays
 * the strict read the deploy target and the digest need.
 */
export type ParameterRead = SecretRead;

/**
 * A stack's status (`UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE`, …), or that the
 * role may not read it. `value` is undefined for a stack that does not exist.
 */
export type StackRead = SecretRead;

/** One method per AWS call the script makes, plus the clock it waits on. */
export interface DeployAws {
  getParameter(name: string): Promise<string | undefined>;
  putParameter(name: string, value: string): Promise<void>;
  /** A parameter's current string; `not_granted` when the role is refused it. */
  readParameter(name: string): Promise<ParameterRead>;
  /**
   * The tags ECR holds for the image with this digest — `[]` for an image with
   * none (an index's platform child, MOTIR-11274) — or `null` when the
   * repository holds no image with this digest.
   */
  imageTags(repositoryName: string, digest: string): Promise<string[] | null>;
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
  /** A secret's current string; `not_granted` when the role is refused it. */
  getSecretValue(secretId: string): Promise<SecretRead>;
  /** Make `value` the secret's current version. */
  putSecretValue(secretId: string, value: string): Promise<void>;
  /** A stack's current status; `not_granted` when the role is refused it. */
  stackStatus(stackName: string): Promise<StackRead>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The action each port method issues, for the test that holds them to the grant. */
export const ACTION_OF: Record<Exclude<keyof DeployAws, 'sleep' | 'now'>, GrantedAction> = {
  getParameter: 'ssm:GetParameter',
  putParameter: 'ssm:PutParameter',
  readParameter: 'ssm:GetParameter',
  imageTags: 'ecr:DescribeImages',
  describeTaskDefinition: 'ecs:DescribeTaskDefinition',
  registerTaskDefinition: 'ecs:RegisterTaskDefinition',
  runTask: 'ecs:RunTask',
  describeTask: 'ecs:DescribeTasks',
  stopTask: 'ecs:StopTask',
  listServices: 'ecs:ListServices',
  describeServices: 'ecs:DescribeServices',
  updateService: 'ecs:UpdateService',
  tailLog: 'logs:GetLogEvents',
  getSecretValue: 'secretsmanager:GetSecretValue',
  putSecretValue: 'secretsmanager:PutSecretValue',
  stackStatus: 'cloudformation:DescribeStacks',
};

/** DescribeServices takes at most this many services per call. */
const DESCRIBE_SERVICES_BATCH = 10;

/** The production adapter, on the SDK's default credential chain. */
export function awsSdkPorts(region: string): DeployAws {
  const ecs = new ECSClient({ region });
  const ssm = new SSMClient({ region });
  const ecr = new ECRClient({ region });
  const logs = new CloudWatchLogsClient({ region });
  const secrets = new SecretsManagerClient({ region });
  const cloudformation = new CloudFormationClient({ region });
  return {
    async getParameter(name) {
      const out = await ssm.send(new GetParameterCommand({ Name: name }));
      return out.Parameter?.Value;
    },
    async putParameter(name, value) {
      // No `Type`: the parameter exists (motir-infra creates it as a `String`),
      // and an overwrite keeps its type, tier and allowed pattern.
      await ssm.send(new PutParameterCommand({ Name: name, Value: value, Overwrite: true }));
    },
    async readParameter(name) {
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: name }));
        return { state: 'granted', value: out.Parameter?.Value };
      } catch (err) {
        if (err instanceof ParameterNotFound) return { state: 'granted', value: undefined };
        if (err instanceof Error && err.name === 'AccessDeniedException') {
          return { state: 'not_granted' };
        }
        throw err;
      }
    },
    async imageTags(repositoryName, digest) {
      try {
        const out = await ecr.send(
          new DescribeImagesCommand({ repositoryName, imageIds: [{ imageDigest: digest }] }),
        );
        const image = out.imageDetails?.[0];
        return image ? (image.imageTags ?? []) : null;
      } catch (err) {
        if (err instanceof ImageNotFoundException) return null;
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
    async getSecretValue(secretId) {
      try {
        const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
        return { state: 'granted', value: out.SecretString };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return { state: 'granted', value: undefined };
        // A refusal by IAM or by the key arrives as this name, from either service.
        if (err instanceof Error && err.name === 'AccessDeniedException') {
          return { state: 'not_granted' };
        }
        throw err;
      }
    },
    async putSecretValue(secretId, value) {
      await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
    async stackStatus(stackName) {
      try {
        const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
        return { state: 'granted', value: out.Stacks?.[0]?.StackStatus };
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        // CloudFormation answers a stack that does not exist with this name.
        if (err.name === 'ValidationError' && /does not exist/.test(err.message)) {
          return { state: 'granted', value: undefined };
        }
        if (err.name === 'AccessDenied' || err.name === 'AccessDeniedException') {
          return { state: 'not_granted' };
        }
        throw err;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
