import * as Sentry from '@sentry/nextjs';
import type {
  CapacityLimitOverShareError,
  GatewaySaturationOverShareError,
} from '@/lib/capacity/errors';

/**
 * Tell the platform admins a provider model's limit is at or over the alert share
 * (Story MOTIR-9539 · MOTIR-9611). The same discipline as
 * `fleetShardHeadroomAlert.ts`, in its own module so capacity alerts keep their
 * own Sentry issues and tags.
 *
 * ⚠️ FINGERPRINTED PER (PROVIDER, MODEL, LIMIT), so one limit that stays over is
 * one issue. What stops a second event on every poll is the evaluation calling
 * this only when the raise answered `newlyRaised: true`.
 *
 * NEVER THROWS: an alert is not allowed to stop the evaluation that raised it.
 */
export function alertCapacityLimitOverShare(error: CapacityLimitOverShareError): void {
  try {
    Sentry.captureException(error, {
      level: 'warning',
      tags: {
        capacity_provider: error.provider,
        capacity_model: error.model,
        capacity_limit: error.unit,
        capacity_share:
          error.sharePercent === null ? 'limit_zero' : String(Math.round(error.sharePercent)),
      },
      fingerprint: ['capacity-limit-share', error.provider, error.model, error.unit],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}

/**
 * Tell the platform admins the gateway reached its saturation share (MOTIR-9675,
 * design D6). One fingerprint for the series, so a gateway that stays over is one
 * issue; the evaluation calls this only on `newlyRaised: true`. Never throws.
 */
export function alertGatewaySaturationOverShare(error: GatewaySaturationOverShareError): void {
  try {
    Sentry.captureException(error, {
      level: 'warning',
      tags: {
        capacity_series: 'gateway_saturation',
        capacity_share: String(Math.round(error.sharePercent)),
      },
      fingerprint: ['capacity-gateway-saturation'],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}
