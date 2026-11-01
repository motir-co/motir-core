import type { TenantCloudFormation, TenantStack } from './clients';
import {
  StackFailedError,
  StackNameRefusedError,
  StackTagsRequiredError,
  StackWaitTimeoutError,
} from './errors';

// THE IDEMPOTENT STACK RUNNER (MOTIR-10004). Every AWS resource the hosting
// adapter makes in a tenant account is a CloudFormation stack applied through
// here, and the runner LOOKS BEFORE IT ACTS, so a repeated call, or one replayed
// after being cut off at any step, ends in the same single stack:
//
//   no stack                      → create, wait
//   in progress                   → wait for it, then look again (resume)
//   ROLLBACK_COMPLETE             → a failed create: delete, re-create — once
//   complete, same body/params/tags → no change, no call
//   complete, anything differs    → update ("No updates" is a no change), wait
//   any other failed state        → StackFailedError naming the status
//
// It refuses, before any call, a name outside `motir-` (the prefix the deploy
// role's CloudFormation rights are scoped to), a stack missing either tag, and
// `motir:repository=shared` on any stack but the account's network.

export const TAG_ORGANIZATION = 'motir:organization';
export const TAG_REPOSITORY = 'motir:repository';
/** The one stack that belongs to no repository. */
export const NETWORK_STACK_NAME = 'motir-network';
export const SHARED_REPOSITORY_TAG = 'shared';

/** Long enough for an Aurora cluster or a first Fargate rollout. */
export const STACK_WAIT_TIMEOUT_MS = 60 * 60_000;
const STACK_POLL_MS = 10_000;

const HEALTHY = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);
const inProgress = (status: string) =>
  status.endsWith('_IN_PROGRESS') && status !== 'REVIEW_IN_PROGRESS';

export interface ApplyStackInput {
  readonly stackName: string;
  readonly template: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

export interface ApplyStackResult {
  readonly outcome: 'created' | 'updated' | 'no_change';
  readonly outputs: Readonly<Record<string, string>>;
}

export interface DescribedStack {
  readonly status: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  /** When it was created, when known — where a release's usage starts. */
  readonly createdAt?: Date;
}

export interface StackRunner {
  applyStack(input: ApplyStackInput): Promise<ApplyStackResult>;
  /** Delete the stack and wait for it to go; nothing to do when it is absent. */
  deleteStack(stackName: string): Promise<void>;
  /** The stack's status and outputs, or null when there is none. */
  describeStack(stackName: string): Promise<DescribedStack | null>;
}

export interface StackRunnerOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/** The refusals, before any CloudFormation call. */
export function checkStackRequest(stackName: string, tags: Readonly<Record<string, string>>): void {
  if (!stackName.startsWith('motir-')) {
    throw new StackNameRefusedError(stackName, 'a stack name must begin motir-');
  }
  const missing = [TAG_ORGANIZATION, TAG_REPOSITORY].filter((key) => !tags[key]);
  if (missing.length > 0) throw new StackTagsRequiredError(stackName, missing);
  if (tags[TAG_REPOSITORY] === SHARED_REPOSITORY_TAG && stackName !== NETWORK_STACK_NAME) {
    throw new StackNameRefusedError(
      stackName,
      `only ${NETWORK_STACK_NAME} may carry ${TAG_REPOSITORY}=${SHARED_REPOSITORY_TAG}`,
    );
  }
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

export function createStackRunner(
  cfn: TenantCloudFormation,
  options: StackRunnerOptions = {},
): StackRunner {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? STACK_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? STACK_POLL_MS;

  /** Poll until the stack leaves every in-progress state; null once it is gone. */
  async function settle(stackName: string): Promise<TenantStack | null> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const stack = await cfn.describeStack(stackName);
      if (!stack || stack.status === 'DELETE_COMPLETE') return null;
      if (!inProgress(stack.status)) return stack;
      if (now() >= deadline) throw new StackWaitTimeoutError(stackName, stack.status);
      await sleep(pollMs);
    }
  }

  async function applyStack(input: ApplyStackInput): Promise<ApplyStackResult> {
    const { stackName: name, template, parameters, tags } = input;
    checkStackRequest(name, tags);
    const write = { name, templateBody: template, parameters, tags };
    let recreated = false;
    for (;;) {
      const stack = await settle(name);
      if (!stack) {
        await cfn.createStack(write);
        const created = await settle(name);
        if (created?.status === 'CREATE_COMPLETE') {
          return { outcome: 'created', outputs: created.outputs };
        }
        throw new StackFailedError(name, created?.status ?? 'DELETE_COMPLETE');
      }
      if (stack.status === 'ROLLBACK_COMPLETE' && !recreated) {
        // A create that failed leaves a stack that can only be deleted.
        recreated = true;
        await cfn.deleteStack(name);
        await settle(name);
        continue;
      }
      if (!HEALTHY.has(stack.status)) throw new StackFailedError(name, stack.status);
      if (
        sameRecord(stack.parameters, parameters) &&
        sameRecord(stack.tags, tags) &&
        (await cfn.getTemplateBody(name)) === template
      ) {
        return { outcome: 'no_change', outputs: stack.outputs };
      }
      if ((await cfn.updateStack(write)) === 'no_change') {
        return { outcome: 'no_change', outputs: stack.outputs };
      }
      const updated = await settle(name);
      if (updated?.status === 'UPDATE_COMPLETE') {
        return { outcome: 'updated', outputs: updated.outputs };
      }
      throw new StackFailedError(name, updated?.status ?? 'DELETE_COMPLETE');
    }
  }

  return {
    applyStack,

    async deleteStack(stackName) {
      const stack = await settle(stackName);
      if (!stack) return;
      await cfn.deleteStack(stackName);
      const left = await settle(stackName);
      if (left) throw new StackFailedError(stackName, left.status);
    },

    async describeStack(stackName) {
      const stack = await cfn.describeStack(stackName);
      if (!stack || stack.status === 'DELETE_COMPLETE') return null;
      return {
        status: stack.status,
        parameters: stack.parameters,
        outputs: stack.outputs,
        ...(stack.createdAt ? { createdAt: stack.createdAt } : {}),
      };
    },
  };
}
