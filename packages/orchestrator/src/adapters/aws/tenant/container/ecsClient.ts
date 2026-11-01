// The container shape's CLIENT INTERFACES (MOTIR-10009): provider-neutral
// slices of ECS, Elastic Load Balancing (v2) and SSM Parameter Store. No AWS SDK
// type appears here; the seam's `sdk.ts` implements them (the one file of the
// tenant directory that imports the SDK), and `fake.ts` fakes them with the same
// Nth-call fault injection. Secret values go through the seam's
// `TenantSecretsManager`.

/** One deployment of a service, as ECS reports it. */
export interface TenantEcsDeployment {
  readonly taskDefinition: string;
  /** `PRIMARY` (the one being rolled out) or `ACTIVE` (the one it replaces). */
  readonly status: string;
  readonly rolloutState: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
}

export interface TenantEcsService {
  readonly taskDefinition: string;
  readonly desiredCount: number;
  readonly runningCount: number;
  readonly deployments: readonly TenantEcsDeployment[];
}

/** A task, with the times its billed life runs between. */
export interface TenantEcsTask {
  readonly taskArn: string;
  readonly taskDefinition: string;
  /** `PROVISIONING` … `RUNNING` … `STOPPED`. */
  readonly lastStatus: string;
  /** When its image pull started (Fargate bills from here), else when it started. */
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  /** Fargate CPU units (1024 is one vCPU) and memory in MiB. */
  readonly cpu: number;
  readonly memory: number;
}

export interface TenantEcs {
  /** The service, or null when it (or its cluster) does not exist. */
  describeService(cluster: string, service: string): Promise<TenantEcsService | null>;
  /** Move the service onto a task definition revision. */
  updateService(cluster: string, service: string, taskDefinition: string): Promise<void>;
  /** Every ACTIVE revision of the family, by ARN. */
  listTaskDefinitions(family: string): Promise<string[]>;
  /** Retire a revision; nothing to do when it is already inactive. */
  deregisterTaskDefinition(taskDefinition: string): Promise<void>;
  /** The service's tasks still listed, running and stopped; none for a cluster
   *  that does not exist. */
  listTasks(cluster: string, service: string): Promise<TenantEcsTask[]>;
}

/** A target's health, as the target group reports it. */
export type TenantTargetHealth =
  | 'initial'
  | 'healthy'
  | 'unhealthy'
  | 'unused'
  | 'draining'
  | 'unavailable';

export interface TenantElb {
  describeTargetHealth(targetGroupArn: string): Promise<TenantTargetHealth[]>;
  /** The priorities of the listener's rules (its default rule has none). */
  listRulePriorities(listenerArn: string): Promise<number[]>;
}

export interface TenantSsm {
  /** The parameter's value, or null when there is none. */
  getParameter(name: string): Promise<string | null>;
  /** Write the value (creating or overwriting) and tag the parameter. */
  putParameter(name: string, value: string, tags: Readonly<Record<string, string>>): Promise<void>;
  /** Nothing to do when it is absent. */
  deleteParameter(name: string): Promise<void>;
}
