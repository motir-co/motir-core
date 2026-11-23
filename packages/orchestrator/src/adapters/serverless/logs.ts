import {
  CLOUDWATCH_LOG_LIMITS,
  cloudWatchLogsUnavailable,
  cloudWatchSliceReader,
} from '../../hosting/cloudWatchLogs';
import {
  LAMBDA_HEALTH_WINDOW_MS,
  LAMBDA_RUNTIME_LINES,
  lambdaRuntimeHealth,
  lambdaStreamOf,
  type LambdaRuntimeFacts,
} from '../../hosting/lambdaRuntime';
import type { LogSliceReader, LogWindowLimits } from '../../hosting/logWindow';
import type { ReleaseRuntimeHealth } from '../../hosting/types';
import type { LambdaFunctionView, ServerlessAwsApi } from './client';

// THE SERVERLESS TARGET'S RUNTIME READS (MOTIR-12103): a Lambda function's log
// group read as the shared newest-first window (`hosting/cloudWatchLogs`), and
// its runtime state read from Lambda's own lines (`hosting/lambdaRuntime`) —
// the parts the AWS target's function shape reads the same way. What is the
// serverless target's own: its names for those bounds, and its client.

/** The serverless window's bounds: CloudWatch's. */
export const SERVERLESS_LOG_LIMITS: LogWindowLimits = CLOUDWATCH_LOG_LIMITS;

/** How far back `readHealth` reads Lambda's reports. */
export const SERVERLESS_HEALTH_WINDOW_MS = LAMBDA_HEALTH_WINDOW_MS;

/** The CloudWatch filter pattern for the lines health reads. */
export const SERVERLESS_RUNTIME_LINES = LAMBDA_RUNTIME_LINES;

/** Lambda's own line, or the app's output? */
export const serverlessStreamOf = lambdaStreamOf;

/** A failure of a log read as `LogsUnavailableError`; anything not AWS's is
 *  thrown as it is. */
export const logsUnavailable = cloudWatchLogsUnavailable('serverless');

/** The slice reader over one of the serverless account's log groups. */
export function serverlessSliceReader(
  api: ServerlessAwsApi,
  group: string,
  filterPattern?: string,
): LogSliceReader {
  return cloudWatchSliceReader({
    target: 'serverless',
    filter: (input) => api.filterLogEvents(group, input),
    streamOf: lambdaStreamOf,
    filterPattern: filterPattern ?? null,
    unavailable: logsUnavailable,
  });
}

/** What `readHealth` read about a serverless release. */
export interface ServerlessRuntimeFacts extends Omit<LambdaRuntimeFacts, 'function'> {
  readonly fn: LambdaFunctionView;
}

/** A serverless release's runtime state: `lambdaRuntimeHealth` over its function. */
export function serverlessRuntimeHealth(facts: ServerlessRuntimeFacts): ReleaseRuntimeHealth {
  const { fn, ...rest } = facts;
  return lambdaRuntimeHealth({ ...rest, function: fn });
}
