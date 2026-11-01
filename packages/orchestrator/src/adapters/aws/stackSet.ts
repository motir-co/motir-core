import { createHash } from 'node:crypto';

// THE STACKSET HALF'S DECISIONS (MOTIR-9844) — pure, so the port in
// `management.ts` only sends commands: which operation id a call carries, whether
// an instance already holds the wanted parameters, and what a stack instance's
// status means for a caller waiting on it.
//
// API references, read 2026-10-27:
//   https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateStackInstances.html
//   (OperationId is the idempotency token), API_DescribeStackInstance.html,
//   API_StackInstanceComprehensiveStatus.html, API_DescribeStackSetOperation.html

/** The stack instance one pool account holds in one region. */
export interface AwsStackInstanceTarget {
  readonly stackSetName: string;
  readonly accountId: string;
  readonly region: string;
}

/** A stack instance as `DescribeStackInstance` answers it, reduced to what is decided on. */
export interface AwsStackInstanceState {
  /** `CURRENT`, `OUTDATED` or `INOPERABLE`. */
  readonly status: string;
  /** `StackInstanceStatus.DetailedStatus`: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, … */
  readonly detailedStatus: string | null;
  readonly statusReason: string | null;
  readonly stackId: string | null;
  readonly parameterOverrides: Readonly<Record<string, string>>;
  /** `StackInstance.LastOperationId`: the operation that last created or updated
   *  the instance, when AWS names one (MOTIR-10204). */
  readonly lastOperationId?: string | null;
}

/** The instance ended in a state no wait gets it out of. */
export class AwsStackInstanceFailedError extends Error {
  readonly code = 'AWS_STACK_INSTANCE_FAILED';
  constructor(
    readonly target: AwsStackInstanceTarget,
    /** The instance's status (or the operation's), and its detailed status when there is one. */
    readonly status: string,
    /** AWS's `StatusReason` for the instance or the operation, when it gave one. */
    readonly statusReason: string | null,
  ) {
    super(
      `The ${target.stackSetName} stack instance in ${target.accountId} (${target.region}) is ${status}` +
        (statusReason ? `: ${statusReason}` : ''),
    );
    this.name = 'AwsStackInstanceFailedError';
  }
}

/** There is no instance, stack or output list to write a shard row from. */
export class AwsStackOutputsMissingError extends Error {
  readonly code = 'AWS_STACK_OUTPUTS_MISSING';
  constructor(
    readonly target: AwsStackInstanceTarget,
    /** What is missing: `stack instance`, `stack id`, `stack` or `outputs`. */
    readonly missing: string,
  ) {
    super(
      `The ${target.stackSetName} stack instance in ${target.accountId} (${target.region}) has no ${missing}`,
    );
    this.name = 'AwsStackOutputsMissingError';
  }
}

/**
 * The operation id a create or update of this instance with these overrides
 * carries: the same inputs always give the same id, so a repeated call attaches
 * to the operation already filed rather than starting a second one. At most 128
 * characters of `[a-zA-Z0-9-]`, starting with a letter.
 *
 * `after` is the operation the update follows — the instance's
 * `LastOperationId` (MOTIR-10204). An operation id is spent once AWS has filed
 * it, so an update that re-applies an instance whose last operation FAILED needs
 * an id that operation never had: a re-run reading the same failed state still
 * derives the same id (and attaches to its own filing), and a later failure gives
 * the next re-apply a new one. Without `after` the id is the inputs' alone.
 */
export function awsStackSetOperationId(
  action: 'create' | 'update',
  target: AwsStackInstanceTarget,
  parameterOverrides: Readonly<Record<string, string>>,
  after?: string | null,
): string {
  const overrides = Object.keys(parameterOverrides)
    .sort()
    .map((key) => [key, parameterOverrides[key]]);
  const inputs: unknown[] = [
    action,
    target.stackSetName,
    target.accountId,
    target.region,
    overrides,
  ];
  if (after) inputs.push(after);
  const digest = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  return `motir-${action}-${digest.slice(0, 48)}`;
}

/** Whether the instance's overrides are exactly the wanted ones. */
export function sameParameterOverrides(
  current: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(wanted);
  return (
    Object.keys(current).length === keys.length && keys.every((key) => current[key] === wanted[key])
  );
}

/** `DescribeStackInstance`'s `ParameterOverrides`, as key to value. */
export function parameterOverridesOf(
  overrides: readonly { ParameterKey?: string; ParameterValue?: string }[] | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { ParameterKey: key, ParameterValue: value } of overrides ?? []) {
    if (key) record[key] = value ?? '';
  }
  return record;
}

/** The overrides as `ParameterOverrides`, in key order. */
export function parameterOverridesFor(
  overrides: Readonly<Record<string, string>>,
): { ParameterKey: string; ParameterValue: string }[] {
  return Object.keys(overrides)
    .sort()
    .map((key) => ({ ParameterKey: key, ParameterValue: overrides[key] ?? '' }));
}

/** The detailed statuses no wait gets an instance out of. */
const TERMINAL = [
  'FAILED',
  'CANCELLED',
  'INOPERABLE',
  'FAILED_IMPORT',
  'SKIPPED_SUSPENDED_ACCOUNT',
];

/** The detailed statuses an `UpdateStackInstances` gets an OUTDATED instance out
 *  of: its last operation failed or was stopped on it, or finished and left it
 *  behind the stack set. Every other one is in flight (`PENDING`, `RUNNING`, or
 *  none yet) or past what an update can repair (`INOPERABLE`, `FAILED_IMPORT`,
 *  `SKIPPED_SUSPENDED_ACCOUNT`). */
const REAPPLIABLE = ['FAILED', 'CANCELLED', 'SUCCEEDED'];

/**
 * Whether the instance must be applied again before it can become CURRENT
 * (MOTIR-10204): it is `OUTDATED` and nothing is still working on it — its last
 * operation failed, was cancelled, or ended without bringing it up to date. Such
 * an instance stays where it is until someone files an `UpdateStackInstances`;
 * waiting on it only reads the same failure again. Pure.
 */
export function stackInstanceNeedsReapply(instance: AwsStackInstanceState): boolean {
  return (
    instance.status === 'OUTDATED' &&
    instance.detailedStatus !== null &&
    REAPPLIABLE.includes(instance.detailedStatus)
  );
}

/**
 * What the instance's status means to a caller waiting on it: `current`, or
 * `waiting` while a create or update is in flight (an `OUTDATED` instance whose
 * detailed status is `PENDING`, `RUNNING` or not yet terminal). A failed, cancelled or
 * inoperable instance throws `AwsStackInstanceFailedError`.
 */
export function stackInstanceOutcome(
  target: AwsStackInstanceTarget,
  instance: AwsStackInstanceState,
): 'current' | 'waiting' {
  if (instance.status === 'CURRENT') return 'current';
  const detailed = instance.detailedStatus;
  if (instance.status === 'INOPERABLE' || (detailed !== null && TERMINAL.includes(detailed))) {
    throw new AwsStackInstanceFailedError(
      target,
      detailed ? `${instance.status}/${detailed}` : instance.status,
      instance.statusReason,
    );
  }
  return 'waiting';
}

/** The operation statuses a StackSet operation is still running in. */
export const AWS_STACK_SET_OPERATION_RUNNING = ['QUEUED', 'RUNNING', 'STOPPING'] as const;
