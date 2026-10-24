import { OrchestratorApiError, OrchestratorCapacityError } from '../../errors';
import type { OrchestratorCapacityReason } from '../../errors';
import { Ec2ApiError } from './ec2Client';

// WHICH EC2 refusals mean "the account is full" (Story MOTIR-9270 · MOTIR-9277).
//
// Admission (MOTIR-8968) tells FULL from BROKEN by the error's type: a capacity
// refusal moves the job to another account of the pool or defers it, any other
// refusal ends it as `provision_failed`. So the table is matched on the EXACT
// AWS error code — never on message text, which AWS may reword and which can
// echo user-data — and an unmapped code (an invalid AMI, bad user-data, a gone
// subnet) stays a plain `OrchestratorApiError`.
//
// Codes per the EC2 error-codes reference,
// https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
// (read 2026-10-24), plus `Throttling` / `ThrottlingException`, the AWS-wide
// throttling codes of https://docs.aws.amazon.com/AWSEC2/latest/APIReference/CommonErrors.html.
// Spot's capacity codes are out of scope: the fleet launches on-demand only.

/** The account's vCPU or instance quota is spent — account-wide. */
export const AWS_QUOTA_CODES: readonly string[] = ['VcpuLimitExceeded', 'InstanceLimitExceeded'];

/** The zone has no capacity of the instance type — zone-local. */
export const AWS_OUT_OF_STOCK_CODES: readonly string[] = ['InsufficientInstanceCapacity'];

/** The API is rate-limiting the account — account-wide. */
export const AWS_THROTTLED_CODES: readonly string[] = [
  'RequestLimitExceeded',
  'Throttling',
  'ThrottlingException',
];

const REASON_BY_CODE: ReadonlyMap<string, OrchestratorCapacityReason> = new Map([
  ...AWS_QUOTA_CODES.map((code) => [code, 'quota_exceeded'] as const),
  ...AWS_OUT_OF_STOCK_CODES.map((code) => [code, 'out_of_stock'] as const),
  ...AWS_THROTTLED_CODES.map((code) => [code, 'throttled'] as const),
]);

/** The capacity reason an EC2 refusal means, or null when it means something else. */
export function awsCapacityReason(err: unknown): OrchestratorCapacityReason | null {
  return err instanceof Ec2ApiError ? (REASON_BY_CODE.get(err.code) ?? null) : null;
}

/** Any EC2 failure as the port's typed error: the provider, the status and the
 *  AWS error CODE — never AWS's message, which can echo user-data. */
export function awsApiError(err: unknown): OrchestratorApiError {
  if (err instanceof Ec2ApiError) return new OrchestratorApiError('aws', err.httpStatus, err.code);
  return new OrchestratorApiError('aws', null, 'UnknownError');
}

/**
 * A RunInstances failure in `zone` as the port's error: an
 * `OrchestratorCapacityError` for a mapped code (the AWS code as `providerCode`),
 * the plain `OrchestratorApiError` otherwise.
 */
export function classifyAwsLaunchError(err: unknown, zone: string | null): OrchestratorApiError {
  const reason = awsCapacityReason(err);
  if (reason && err instanceof Ec2ApiError) {
    return new OrchestratorCapacityError('aws', err.httpStatus, reason, zone, err.code);
  }
  return awsApiError(err);
}
