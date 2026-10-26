import * as Sentry from '@sentry/nextjs';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';

/** How much of the organisation's reason rides on the alert. */
const REASON_EXTRA_MAX = 500;

/** A Host organisation asked for more capacity on one of its own accounts. */
export class FleetCapacityRequestedError extends Error {
  constructor(readonly request: FleetCapacityRequestDTO) {
    super(
      `Organisation ${request.organizationId} asked for ${request.desiredVcpu} vCPU ` +
        `(${request.quotaCode}) on AWS account ${request.awsAccountId} (${request.fleetKind}). ` +
        `File the raise, then: fleet-admin capacity-request-link ${request.id} <quota request>.`,
    );
    this.name = 'FleetCapacityRequestedError';
  }
}

/**
 * Tell the platform admin a Host organisation asked for more capacity
 * (MOTIR-9583), so they talk to AWS and file the raise.
 *
 * ⚠️ FINGERPRINTED PER REQUEST: a repeat capture of the same request is one issue.
 * Tags carry ids only; the reason is free text, so it goes in truncated `extra`
 * and never into the fingerprint.
 *
 * NEVER THROWS: called after the request committed, and an alert is not allowed
 * to fail or roll back the ask that raised it.
 */
export function alertFleetCapacityRequest(request: FleetCapacityRequestDTO): void {
  try {
    Sentry.captureException(new FleetCapacityRequestedError(request), {
      level: 'warning',
      tags: {
        organization_id: request.organizationId,
        fleet_kind: request.fleetKind,
        aws_account_id: request.awsAccountId,
        fleet_alert: 'FleetCapacityRequestedError',
      },
      fingerprint: ['fleet-capacity-request', request.id],
      extra: { reason: request.reasonMd.slice(0, REASON_EXTRA_MAX), requestId: request.id },
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}
