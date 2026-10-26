import 'server-only';

import { type CapacityAlertKey, GATEWAY_SATURATION_ALERT_KEY } from '@/lib/capacity/alertKeys';
import {
  CapacityLimitOverShareError,
  GatewaySaturationOverShareError,
} from '@/lib/capacity/errors';
import {
  GATEWAY_SATURATION_ALERT_PERCENT,
  type GatewaySaturationEvaluation,
  judgeGatewaySaturation,
} from '@/lib/capacity/gatewaySaturation';
import {
  type CapacityEvaluation,
  type CapacityLimitEvaluation,
  evaluateCapacityRead,
} from '@/lib/capacity/threshold';
import type { CapacityRaisedAlertDTO } from '@/lib/dto/capacityAlerts';
import type { CapacityRead, CapacityUnavailableReason } from '@/lib/gateway/capacityClient';
import { gatewayCapacityClient } from '@/lib/gateway/capacityProvider';
import {
  type GatewaySaturationReading,
  gatewaySaturationReader,
} from '@/lib/gateway/gatewaySaturationReader';
import {
  alertCapacityLimitOverShare,
  alertGatewaySaturationOverShare,
} from '@/lib/monitoring/capacityLimitAlert';
import { capacityAlertStateService } from '@/lib/services/capacityAlertStateService';

/**
 * The capacity ALERT EVALUATION — Story MOTIR-9539 · MOTIR-9611.
 *
 * The one place that turns the threshold function's states into raised and
 * cleared alerts. The scheduled job and the screen load both call `evaluate()`,
 * and nothing else, so they cannot disagree about whether a limit is over.
 *
 *  - over the share → `raise`; the Sentry alert goes out ONLY when the raise
 *    answered `newlyRaised: true`, so a limit that stays over alerts once, and of
 *    two evaluations racing exactly one alerts;
 *  - normal or near → `clear` (a raised `rpm` / `tpm` only from a read at second
 *    30 or later of its minute, see below);
 *  - unavailable (a slow entry) → left as it is: a missing number is not
 *    evidence that a limit fell;
 *  - unknown, not applicable, usage not reported, or an entry the answered read
 *    no longer carries → cleared, so an alert never outlives its number.
 *
 * A read that is `unavailable`, or whose counter store is down, neither raises
 * nor clears.
 *
 * THE GATEWAY-SATURATION SERIES (MOTIR-9675, design D6) is judged beside the
 * provider limits from its own reading, whatever the capacity read answered:
 * over 70 % of created machines × hard limit → raise (Sentry once); normal or
 * near → clear; unavailable → left as it is. It is a live connection count, not a
 * per-minute window, so it has no second-30 clear gate.
 */

/**
 * The gateway's per-minute counters are FIXED clock-minute windows (contract §3
 * *Lanes*), so a read early in a minute sees a near-empty window. A raised `rpm`
 * or `tpm` alert is cleared only by a read at this second of its minute or later;
 * an earlier read may raise it but leaves it raised. Without this a screen load
 * at :05 would clear what the job raised at :45, and the job would re-alert
 * every minute.
 */
export const CLEAR_MIN_SECOND_OF_MINUTE = 30;
const PER_MINUTE_UNITS = new Set(['rpm', 'tpm']);

export type { GatewaySaturationEvaluation };

export type CapacityEvaluationResult =
  | {
      outcome: 'evaluated';
      evaluation: CapacityEvaluation;
      raised: CapacityRaisedAlertDTO[];
      saturation: GatewaySaturationEvaluation;
    }
  | {
      outcome: 'unavailable';
      reason: CapacityUnavailableReason | 'counter_store_unavailable';
      raised: CapacityRaisedAlertDTO[];
      saturation: GatewaySaturationEvaluation;
    };

function keyName(key: CapacityAlertKey): string {
  return `${key.provider}\u0000${key.model}\u0000${key.limitUnit}`;
}

function mayClear(row: CapacityLimitEvaluation, readAt: Date): boolean {
  if (row.state === 'normal' || row.state === 'near_limit') {
    return !PER_MINUTE_UNITS.has(row.unit) || readAt.getUTCSeconds() >= CLEAR_MIN_SECOND_OF_MINUTE;
  }
  return (
    row.state === 'unknown_limit' ||
    row.state === 'not_applicable' ||
    row.state === 'usage_not_reported'
  );
}

async function raiseOver(
  key: CapacityAlertKey,
  row: CapacityLimitEvaluation,
  alertSharePercent: number,
): Promise<void> {
  if (row.usage === null || row.limit.status !== 'set') return;
  const { newlyRaised } = await capacityAlertStateService.raise(key, {
    observedValue: row.usage.total,
    limitValue: row.limit.value,
    alertSharePercent,
  });
  if (!newlyRaised) return;
  alertCapacityLimitOverShare(
    new CapacityLimitOverShareError(
      key.provider,
      key.model,
      key.limitUnit,
      row.sharePercent,
      alertSharePercent,
    ),
  );
}

/** Apply one evaluation's raises and clears. */
async function applyEvaluation(
  evaluation: CapacityEvaluation,
  raisedBefore: readonly CapacityRaisedAlertDTO[],
): Promise<void> {
  const raised = new Set(raisedBefore.map((r) => keyName(r)));
  const seen = new Set<string>();
  for (const entry of evaluation.entries) {
    for (const row of entry.limits) {
      const key: CapacityAlertKey = {
        provider: entry.provider,
        model: entry.model,
        limitUnit: row.unit,
      };
      seen.add(keyName(key));
      if (row.state === 'over_share') {
        await raiseOver(key, row, evaluation.alertSharePercent);
      } else if (raised.has(keyName(key)) && mayClear(row, evaluation.readAt)) {
        await capacityAlertStateService.clear(key);
      }
    }
  }
  // An entry the answered read no longer carries: its alert has no number left.
  for (const gone of raisedBefore.filter((r) => !seen.has(keyName(r)))) {
    await capacityAlertStateService.clear(gone);
  }
}

/** Judge the saturation reading, then raise or clear its one key. */
async function evaluateSaturation(
  reading: GatewaySaturationReading,
): Promise<GatewaySaturationEvaluation> {
  const alertPercent = GATEWAY_SATURATION_ALERT_PERCENT;
  const judgement = judgeGatewaySaturation(
    reading.outcome === 'answered'
      ? reading
      : { connectionsInUse: null, createdMachines: null, hardLimit: null },
    alertPercent,
  );
  if (
    judgement.state === 'over_share' &&
    reading.outcome === 'answered' &&
    reading.connectionsInUse !== null &&
    judgement.capacityConnections !== null &&
    judgement.sharePercent !== null
  ) {
    const { newlyRaised } = await capacityAlertStateService.raise(GATEWAY_SATURATION_ALERT_KEY, {
      observedValue: reading.connectionsInUse,
      limitValue: judgement.capacityConnections,
      alertSharePercent: alertPercent,
    });
    if (newlyRaised) {
      alertGatewaySaturationOverShare(
        new GatewaySaturationOverShareError(
          reading.connectionsInUse,
          judgement.capacityConnections,
          judgement.sharePercent,
          alertPercent,
        ),
      );
    }
  } else if (judgement.state === 'normal' || judgement.state === 'near_limit') {
    await capacityAlertStateService.clear(GATEWAY_SATURATION_ALERT_KEY);
  }
  return {
    reading,
    judgement,
    alertPercent,
    raised: await capacityAlertStateService.getSaturationRaised(),
  };
}

export const capacityAlertEvaluationService = {
  /**
   * Read (or take the read the caller already has), judge, raise and clear.
   * Returns the evaluation and the raised list AFTER the writes — what the
   * screen's raised-alerts banner shows.
   */
  async evaluate(
    options: { read?: CapacityRead; saturation?: GatewaySaturationReading } = {},
  ): Promise<CapacityEvaluationResult> {
    const share = await capacityAlertStateService.getAlertShare();
    const read = options.read ?? (await gatewayCapacityClient().read());
    const saturation = await evaluateSaturation(
      options.saturation ?? (await gatewaySaturationReader()()),
    );
    if (read.outcome === 'unavailable') {
      return {
        outcome: 'unavailable',
        reason: read.reason,
        raised: await capacityAlertStateService.listRaised(),
        saturation,
      };
    }
    if (read.counterStore.state === 'unavailable') {
      return {
        outcome: 'unavailable',
        reason: 'counter_store_unavailable',
        raised: await capacityAlertStateService.listRaised(),
        saturation,
      };
    }
    const evaluation = evaluateCapacityRead(read, share.percent);
    await applyEvaluation(evaluation, await capacityAlertStateService.listRaised());
    return {
      outcome: 'evaluated',
      evaluation,
      raised: await capacityAlertStateService.listRaised(),
      saturation,
    };
  },
};
