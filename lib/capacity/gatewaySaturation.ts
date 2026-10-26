import type { GatewaySaturationRaisedAlertDTO } from '@/lib/dto/capacityAlerts';
import type { GatewaySaturationReading } from '@/lib/gateway/gatewaySaturationReader';
import { NEAR_LIMIT_BAND_POINTS } from './threshold';

// THE GATEWAY-SATURATION JUDGE (MOTIR-9675, design D6 of MOTIR-9667's gateway
// design). The gateway reaching its own hard limit is a defect, so the capacity
// alert carries one series beside the provider limits: connections in use over
// (created machines × per-machine hard limit).
//
// ⚠️ CREATED machines, not running ones: a stopped machine is capacity Fly's
// proxy starts on demand. 700 connections with 12 created and 1 running is 7.8 %
// of 9,000, not 93 % of 750.
//
// Pure, and integer cross-multiplication only, as `judgeSetLimit` is: 70 %
// exactly is over. A missing input, or a capacity of 0, is `unavailable` — never
// a share of 0.

/** The share at which the series alerts — a fixed value of design D6, not the
 *  editable provider alert share. */
export const GATEWAY_SATURATION_ALERT_PERCENT = 70;

export type GatewaySaturationState = 'normal' | 'near_limit' | 'over_share' | 'unavailable';

export interface GatewaySaturationInput {
  connectionsInUse: number | null;
  createdMachines: number | null;
  hardLimit: number | null;
}

export interface GatewaySaturationJudgement {
  state: GatewaySaturationState;
  /** `connectionsInUse / capacityConnections × 100`, unrounded; `null` when unavailable. */
  sharePercent: number | null;
  /** `createdMachines × hardLimit`; `null` when either is missing. */
  capacityConnections: number | null;
}

function known(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0;
}

export function judgeGatewaySaturation(
  input: GatewaySaturationInput,
  alertPercent: number = GATEWAY_SATURATION_ALERT_PERCENT,
): GatewaySaturationJudgement {
  const { connectionsInUse, createdMachines, hardLimit } = input;
  if (!known(connectionsInUse) || !known(createdMachines) || !known(hardLimit)) {
    return {
      state: 'unavailable',
      sharePercent: null,
      capacityConnections:
        known(createdMachines) && known(hardLimit) ? createdMachines * hardLimit : null,
    };
  }
  const capacity = createdMachines * hardLimit;
  if (capacity === 0) return { state: 'unavailable', sharePercent: null, capacityConnections: 0 };
  const sharePercent = (connectionsInUse / capacity) * 100;
  let state: GatewaySaturationState = 'normal';
  if (connectionsInUse * 100 >= alertPercent * capacity) state = 'over_share';
  else if (connectionsInUse * 100 >= Math.max(0, alertPercent - NEAR_LIMIT_BAND_POINTS) * capacity)
    state = 'near_limit';
  return { state, sharePercent, capacityConnections: capacity };
}

/** The series as one evaluation judged it, and its raised alert after that
 *  evaluation's write (`capacityAlertEvaluationService`). */
export interface GatewaySaturationEvaluation {
  reading: GatewaySaturationReading;
  judgement: GatewaySaturationJudgement;
  alertPercent: number;
  raised: GatewaySaturationRaisedAlertDTO | null;
}
