import type { CapacityAlertShareDTO, CapacityRaisedAlertDTO } from '@/lib/dto/capacityAlerts';
import type {
  PlatformCapacity429DTO,
  PlatformCapacityAlertShareDTO,
  PlatformCapacityEntryDTO,
  PlatformCapacityLimitDTO,
  PlatformCapacityLimitRowDTO,
  PlatformCapacityRaisedDTO,
  PlatformCapacityReadDTO,
  PlatformCapacityStoredEntryDTO,
  PlatformCapacityUnavailableReason,
  PlatformCapacityViewDTO,
  PlatformGatewaySaturationDTO,
} from '@/lib/dto/platformCapacity';
import { CAPACITY_LIMIT_UNITS } from '@/lib/capacity/alertKeys';
import type { CapacityEvaluation, CapacityLimitEvaluation } from '@/lib/capacity/threshold';
import type { GatewaySaturationEvaluation } from '@/lib/capacity/gatewaySaturation';
import type {
  CapacityEntry,
  CapacityLimit,
  CapacityRead,
  CapacityUnavailableReason,
  LaneUsage,
  StoredCapacityRow,
} from '@/lib/gateway/capacityClient';

// THE CAPACITY SCREEN'S VIEW MODEL (Story MOTIR-9539 · MOTIR-9613).
//
// ⚠️ FIXED FIELD LISTS ONLY — no spread of a gateway, store or evaluation object.
// That is what keeps the access token, a principal's id or email, the row's
// `updatedByUserId` and any tenant identifier off the screen even if a lower
// layer grows such a field later.

const CREDENTIAL_REASONS: ReadonlySet<CapacityUnavailableReason> = new Set([
  'not_configured',
  'auth_refused',
]);

export function toPlatformCapacityUnavailableReason(
  reason: CapacityUnavailableReason,
): PlatformCapacityUnavailableReason {
  return CREDENTIAL_REASONS.has(reason) ? 'credential' : 'unreachable';
}

function toLimitDTO(limit: CapacityLimit): PlatformCapacityLimitDTO {
  return limit.status === 'set' ? { status: 'set', value: limit.value } : { status: limit.status };
}

function toRowDTO(row: CapacityLimitEvaluation): PlatformCapacityLimitRowDTO {
  return {
    unit: row.unit,
    limit: toLimitDTO(row.limit),
    usage: row.usage
      ? { total: row.usage.total, planning: row.usage.planning, agent: row.usage.agent }
      : null,
    sharePercent: row.sharePercent,
    state: row.state,
  };
}

function to429DTO(lane: LaneUsage | null): PlatformCapacity429DTO | null {
  return lane ? { minute: lane.rateLimited429.minute, day: lane.rateLimited429.day } : null;
}

function toEntryDTO(
  entry: CapacityEntry,
  evaluation: CapacityEvaluation,
): PlatformCapacityEntryDTO {
  const judged = evaluation.entries.find(
    (e) => e.provider === entry.provider && e.model === entry.model,
  );
  const rows = CAPACITY_LIMIT_UNITS.map((unit) => judged?.limits.find((r) => r.unit === unit))
    .filter((row): row is CapacityLimitEvaluation => row !== undefined)
    .map(toRowDTO);
  return {
    provider: entry.provider,
    model: entry.model,
    tierNote: entry.tierNote,
    unknownNote: entry.unknownNote,
    planningSharePercent: entry.planningSharePercent,
    limits: rows,
    rateLimited429: {
      planning: to429DTO(entry.lanes.planning),
      agent: to429DTO(entry.lanes.agent),
    },
  };
}

export function toPlatformCapacityRaisedDTO(
  raised: CapacityRaisedAlertDTO,
): PlatformCapacityRaisedDTO {
  return {
    provider: raised.provider,
    model: raised.model,
    unit: raised.limitUnit,
    raisedAt: raised.raisedAt.toISOString(),
    observedValue: raised.observedValue,
    limitValue: raised.limitValue,
    alertSharePercent: raised.alertSharePercent,
  };
}

export function toPlatformCapacityAlertShareDTO(
  share: CapacityAlertShareDTO,
): PlatformCapacityAlertShareDTO {
  return { percent: share.percent, isDefault: share.isDefault };
}

function toReadDTO(
  read: CapacityRead,
  evaluation: CapacityEvaluation | null,
): PlatformCapacityReadDTO {
  if (read.outcome === 'unavailable' || evaluation === null) {
    const reason = read.outcome === 'unavailable' ? read.reason : 'bad_response';
    return { outcome: 'unavailable', reason: toPlatformCapacityUnavailableReason(reason) };
  }
  return {
    outcome: 'answered',
    readAt: read.readAt.toISOString(),
    counterStore: { state: read.counterStore.state, scope: read.counterStore.scope },
    entries: read.entries.map((entry) => toEntryDTO(entry, evaluation)),
  };
}

/** The gateway-saturation row (MOTIR-9675), fixed fields only. */
export function toPlatformGatewaySaturationDTO(
  saturation: GatewaySaturationEvaluation,
): PlatformGatewaySaturationDTO {
  const { reading, judgement, raised } = saturation;
  const figures =
    reading.outcome === 'answered'
      ? reading
      : { connectionsInUse: null, createdMachines: null, hardLimit: null };
  return {
    state: judgement.state,
    unavailableReason: reading.outcome === 'unavailable' ? reading.reason : null,
    connectionsInUse: figures.connectionsInUse,
    createdMachines: figures.createdMachines,
    hardLimit: figures.hardLimit,
    capacityConnections: judgement.capacityConnections,
    sharePercent: judgement.sharePercent,
    alertPercent: saturation.alertPercent,
    raised: raised
      ? {
          raisedAt: raised.raisedAt.toISOString(),
          observedValue: raised.observedValue,
          limitValue: raised.limitValue,
          alertSharePercent: raised.alertSharePercent,
        }
      : null,
  };
}

/** The whole screen, from one read and the evaluation of that same read. */
export function toPlatformCapacityViewDTO(input: {
  read: CapacityRead;
  evaluation: CapacityEvaluation | null;
  raised: CapacityRaisedAlertDTO[];
  alertShare: CapacityAlertShareDTO;
  canEdit: boolean;
  saturation: GatewaySaturationEvaluation;
}): PlatformCapacityViewDTO {
  return {
    alertShare: toPlatformCapacityAlertShareDTO(input.alertShare),
    canEdit: input.canEdit,
    raised: input.raised.map(toPlatformCapacityRaisedDTO),
    capacity: toReadDTO(input.read, input.evaluation),
    saturation: toPlatformGatewaySaturationDTO(input.saturation),
  };
}

/** The row a limit edit stored, shaped like an entry without usage. */
export function toPlatformCapacityStoredEntryDTO(
  row: StoredCapacityRow,
): PlatformCapacityStoredEntryDTO {
  return {
    provider: row.provider,
    model: row.model,
    tierNote: row.tierNote,
    unknownNote: row.unknownNote,
    planningSharePercent: row.planningSharePercent,
    limits: CAPACITY_LIMIT_UNITS.map((unit) => ({ unit, limit: toLimitDTO(row.limits[unit]) })),
    updatedAt: row.updatedAt.toISOString(),
  };
}
