import {
  CLOUDWATCH_LOG_LIMITS,
  cloudWatchLogsUnavailable,
  cloudWatchSliceReader,
} from '../../../hosting/cloudWatchLogs';
import { LogsUnavailableError } from '../../../hosting/errors';
import type { LogSliceReader, LogWindowLimits } from '../../../hosting/logWindow';
import type { ReleaseLogStream } from '../../../hosting/types';
import type { TenantLogs } from './clients';
import { TenantRoleUnavailableError } from './errors';

// A tenant account's LOG READS (MOTIR-12104): a release's CloudWatch Logs group
// read through the shared newest-first window, under the tenant deploy role.

/** The AWS target's window bounds: CloudWatch's. */
export const AWS_LOG_LIMITS: LogWindowLimits = CLOUDWATCH_LOG_LIMITS;

const awsLogsUnavailable = cloudWatchLogsUnavailable('aws');

/** A failed log read as `LogsUnavailableError`: AWS's refusal by its service
 *  and code, the deploy role that could not be assumed by its code; anything
 *  else is thrown as it is. */
export function tenantLogsUnavailable(error: unknown): never {
  if (error instanceof TenantRoleUnavailableError) {
    throw new LogsUnavailableError(
      'aws',
      `the tenant deploy role could not be assumed (${error.awsCode})`,
    );
  }
  return awsLogsUnavailable(error);
}

/** The slice reader over one of the tenant account's log groups. */
export function tenantSliceReader(
  logs: TenantLogs,
  group: string,
  streamOf: (message: string) => ReleaseLogStream,
  filterPattern?: string | null,
): LogSliceReader {
  return cloudWatchSliceReader({
    target: 'aws',
    filter: (input) => logs.filterLogEvents(group, input),
    streamOf,
    filterPattern: filterPattern ?? null,
    unavailable: tenantLogsUnavailable,
  });
}
