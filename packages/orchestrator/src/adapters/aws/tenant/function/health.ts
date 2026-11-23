import {
  LAMBDA_HEALTH_WINDOW_MS,
  LAMBDA_RUNTIME_LINES,
  lambdaRuntimeHealth,
  lambdaStreamOf,
  lastLambdaInvocationBefore,
  readLambdaRuntimeSignals,
} from '../../../../hosting/lambdaRuntime';
import type { ReleaseRuntimeHealth } from '../../../../hosting/types';
import { AWS_LOG_LIMITS, tenantSliceReader } from '../logs';
import type { TenantAccountContext } from '../network';

// THE FUNCTION SHAPE'S RUNTIME HEALTH (MOTIR-12104): the `live` version's state
// from Lambda, its provisioned concurrency (always-on), and the runtime's own
// lines in the function's log group — read exactly as the serverless target
// reads its functions (`hosting/lambdaRuntime`).

/** The function's own log group (`aws-tenant-stacks/function-release.yaml`);
 *  its front door's `-front-door` group is not the app's output. */
export function functionLogGroup(appRef: string): string {
  return `/aws/lambda/${appRef}`;
}

export interface FunctionHealthInput {
  readonly account: TenantAccountContext;
  readonly appRef: string;
  /** The alias the release serves from. */
  readonly alias: string;
  /** When the release stack was created, for a function with no `live` yet. */
  readonly stackCreatedAt: Date | null;
  readonly now: Date;
}

/** A function release's runtime state, by `lambdaRuntimeHealth`'s order. */
export async function readFunctionHealth(
  input: FunctionHealthInput,
): Promise<ReleaseRuntimeHealth> {
  const { account, appRef, alias, now } = input;
  const { lambda, logs } = account.clients;
  const liveVersion = await lambda.getAlias(appRef, alias);
  const version = liveVersion ? await lambda.getFunctionVersion(appRef, liveVersion) : null;
  // No `live` yet, or the version it names not there yet: the stack is still
  // publishing it.
  if (!liveVersion || !version) {
    return { state: 'deploying', since: input.stackCreatedAt ?? now };
  }
  const provisioned = await lambda.getProvisionedConcurrency(appRef, alias);
  const group = functionLogGroup(appRef);
  const windowStart = new Date(now.getTime() - LAMBDA_HEALTH_WINDOW_MS);
  const recent = await readLambdaRuntimeSignals(
    'aws',
    tenantSliceReader(logs, group, lambdaStreamOf, LAMBDA_RUNTIME_LINES),
    windowStart,
    now,
    AWS_LOG_LIMITS,
  );
  const lastInvocation = recent.some((s) => s.kind === 'invocation')
    ? null
    : await lastLambdaInvocationBefore(
        'aws',
        group,
        tenantSliceReader(logs, group, lambdaStreamOf, 'REPORT'),
        windowStart,
        version.lastModified,
        AWS_LOG_LIMITS,
      );
  return lambdaRuntimeHealth({
    function: {
      state: version.state,
      lastUpdateStatus: version.lastUpdateStatus,
      lastModified: version.lastModified,
    },
    liveVersion,
    provisioned,
    recent,
    lastInvocation,
    windowStart,
  });
}
