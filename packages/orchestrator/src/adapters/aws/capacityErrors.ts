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
//
// A SPOT launch (MOTIR-11716) reads its refusals through the separate table at
// the end of this file: a Spot refusal is never handed to admission as a
// capacity error, because the adapter answers it itself — by trying the next
// zone or type, or by launching on-demand.

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

// ── SPOT (MOTIR-11716) ───────────────────────────────────────────────────────
//
// What a refused SPOT `RunInstances` means for the CI runner's type walk. Matched
// on the EXACT code, as above. Codes per the EC2 error-codes reference,
// https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
// (read 2026-11-18):
//
//   - `InsufficientInstanceCapacity` — "There is not enough capacity to fulfill
//     your request." For a Spot launch it means the zone has no SPARE capacity of
//     the type: zone-local, so the walk tries the next zone, then the next type.
//   - `UnfulfillableCapacity` — "At this time there isn't enough spare capacity
//     to fulfill your request for Spot Instances." The same, said of Spot.
//   - `MaxSpotInstanceCountExceeded` — "You've reached the limit on the number of
//     Spot Instances that you can launch." The account's Spot quota, which covers
//     every type the walk may try (all 2 vCPU / 8 GiB general purpose): the walk
//     stops and the runner launches on-demand.
//
// Throttling is the account's, whichever market asked: a throttled Spot attempt
// is the on-demand launch's `throttled` capacity error (above), never a reason to
// send one more call on-demand. Any OTHER Spot refusal — a missing Spot
// service-linked role, `SpotMaxPriceTooLow` (no MaxPrice is ever sent), an
// unknown code — also launches on-demand: a runner never fails because Spot was
// asked for.

/** No spare capacity of the type in the zone — zone-local. */
export const AWS_SPOT_OUT_OF_STOCK_CODES: readonly string[] = [
  'InsufficientInstanceCapacity',
  'UnfulfillableCapacity',
];

/** The account's Spot Instance limit is reached — account-wide, every type. */
export const AWS_SPOT_LIMIT_CODES: readonly string[] = ['MaxSpotInstanceCountExceeded'];

/**
 * What one refused Spot launch tells the walk to do:
 *
 *   - `next_zone` — try the next zone, then the next type;
 *   - `throttled` — stop the launch: the account is being rate-limited;
 *   - `spot_limit` — stop the Spot walk and launch on-demand: the account's Spot
 *     limit holds for every type;
 *   - `not_capacity` — stop the Spot walk and launch on-demand: the refusal is
 *     no capacity code at all.
 */
export type AwsSpotRefusal = 'next_zone' | 'throttled' | 'spot_limit' | 'not_capacity';

/** The walk's move for a refused Spot launch's EXACT AWS error code. */
export function awsSpotRefusal(code: string): AwsSpotRefusal {
  if (AWS_SPOT_OUT_OF_STOCK_CODES.includes(code)) return 'next_zone';
  if (AWS_THROTTLED_CODES.includes(code)) return 'throttled';
  if (AWS_SPOT_LIMIT_CODES.includes(code)) return 'spot_limit';
  return 'not_capacity';
}

/** Whether `code` is a capacity refusal of either market — never resent with
 *  the same token: the zone walk, or the Spot type walk, answers it. */
export function isAwsCapacityCode(code: string): boolean {
  return REASON_BY_CODE.has(code) || awsSpotRefusal(code) !== 'not_capacity';
}
