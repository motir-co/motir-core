// The operator console's CAPACITY screen — Story MOTIR-9539 · MOTIR-9613.
//
// Each AI provider/model's usage against its limits, per lane, with the alert
// share and the alerts currently raised. Staff-facing only, and plain JSON
// throughout (ISO strings, no `Date`, no `BigInt`): the same object is a server
// component's prop and the polling route's body.
//
// ⚠️ NO IDENTIFIER AND NO CREDENTIAL, by construction: the mapper copies fixed
// field lists, so nothing a lower layer grows reaches the screen.

import type { CapacityLimitUnit, CapacityProvider } from '@/lib/capacity/alertKeys';
import type { GatewaySaturationState } from '@/lib/capacity/gatewaySaturation';
import type { CapacityLimitState } from '@/lib/capacity/threshold';
import type { CapacityLimit, CapacityLimitsEdit } from '@/lib/gateway/capacityClient';

export type PlatformCapacityLimitDTO = CapacityLimit;

/** One limit of one entry: its value, the usage judged against it, and the state. */
export interface PlatformCapacityLimitRowDTO {
  unit: CapacityLimitUnit;
  limit: PlatformCapacityLimitDTO;
  usage: { total: number; planning: number; agent: number } | null;
  /** Unrounded; `null` unless the limit is set above 0 and usage was read. */
  sharePercent: number | null;
  state: CapacityLimitState;
}

export interface PlatformCapacity429DTO {
  minute: number;
  day: number;
}

export interface PlatformCapacityEntryDTO {
  provider: CapacityProvider;
  model: string;
  tierNote: string;
  unknownNote: string;
  planningSharePercent: number;
  /** Six rows, in the contract's unit order. */
  limits: PlatformCapacityLimitRowDTO[];
  /** Shown, never judged: the contract has no 429 limit. */
  rateLimited429: { planning: PlatformCapacity429DTO | null; agent: PlatformCapacity429DTO | null };
}

/** An entry as a limit edit stored it: no usage, and when it was written. */
export interface PlatformCapacityStoredEntryDTO {
  provider: CapacityProvider;
  model: string;
  tierNote: string;
  unknownNote: string;
  planningSharePercent: number;
  limits: Array<{ unit: CapacityLimitUnit; limit: PlatformCapacityLimitDTO }>;
  updatedAt: string;
}

export interface PlatformCapacityRaisedDTO {
  provider: CapacityProvider;
  model: string;
  unit: CapacityLimitUnit;
  raisedAt: string;
  observedValue: number;
  limitValue: number;
  alertSharePercent: number;
}

export interface PlatformCapacityAlertShareDTO {
  percent: number;
  isDefault: boolean;
}

/** The design's two page error panels: the credential, or the gateway itself. */
export type PlatformCapacityUnavailableReason = 'credential' | 'unreachable';

export type PlatformCapacityReadDTO =
  | {
      outcome: 'answered';
      readAt: string;
      counterStore: { state: 'live' | 'unavailable'; scope: 'shared' | 'instance' };
      entries: PlatformCapacityEntryDTO[];
    }
  | { outcome: 'unavailable'; reason: PlatformCapacityUnavailableReason };

/**
 * The GATEWAY-SATURATION row (MOTIR-9675, design D6): connections in use over
 * created machines × hard limit. Every figure is `null` where it was not read —
 * never 0 — and `state` is the judge's.
 */
export interface PlatformGatewaySaturationDTO {
  state: GatewaySaturationState;
  /** Why the row is unavailable when the reader itself gave no figures. */
  unavailableReason: 'not_configured' | 'read_failed' | null;
  connectionsInUse: number | null;
  createdMachines: number | null;
  hardLimit: number | null;
  /** createdMachines × hardLimit. */
  capacityConnections: number | null;
  /** Unrounded; `null` unless the row was judged. */
  sharePercent: number | null;
  /** The share the series alerts at (70, design D6). */
  alertPercent: number;
  /** The raised alert, as it stood when raised; `null` when not raised. */
  raised: {
    raisedAt: string;
    observedValue: number;
    limitValue: number;
    alertSharePercent: number;
  } | null;
}

export interface PlatformCapacityViewDTO {
  alertShare: PlatformCapacityAlertShareDTO;
  /** `operator` and up: the screen hides Edit otherwise; the actions refuse anyway. */
  canEdit: boolean;
  raised: PlatformCapacityRaisedDTO[];
  capacity: PlatformCapacityReadDTO;
  saturation: PlatformGatewaySaturationDTO;
}

/** One provider/model's edit. An absent key is untouched; a `null` limit is "unknown". */
export type PlatformCapacityEditInput = CapacityLimitsEdit;
