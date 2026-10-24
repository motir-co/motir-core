import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import type { GrowthKindNotAwsError } from '@/lib/ciFleet/errors';
import type { FleetGrowthOutcomeDTO } from '@/lib/dto/fleetPools';

// THE POOL-GROWTH POLICY (Story MOTIR-9362 · MOTIR-9461) — when one fleet kind's
// pool grows, and what one growth pass answers. The decision and the run are
// `fleetPoolGrowthService`; this file is the arithmetic and the vocabulary.

/** The trigger in tenths: 70% is `inUse * 10 >= granted * 7`. Derived from the
 *  headroom reading's own fraction, so the two can never disagree. */
const TRIGGER_TENTHS = Math.round(HEADROOM_ALERT_FRACTION * 10);

/**
 * Does an account using `inUse` vCPU of a live granted `granted` trigger a
 * growth? On integers, so exactly 70% triggers and 69% does not, with no float
 * rounding either way. `inUse` is rounded UP first: a fractional reading never
 * slips under the line.
 */
export function crossesGrowthThreshold(inUse: number, granted: number): boolean {
  return Math.ceil(inUse) * 10 >= granted * TRIGGER_TENTHS;
}

/**
 * How long a growth CLAIM — the event row a pass writes before its AWS call —
 * holds the kind. A claim younger than this keeps a second pass out; an older
 * one is taken as abandoned (the pass that wrote it crashed), so a crash cannot
 * block a kind for ever. The unattended add-shard resumes by the account's
 * derived name, so the pass after a crash finishes it rather than duplicating.
 */
export const GROWTH_CLAIM_STALE_MS = 15 * 60_000;

/** An account the decision could not compare, and why — reported, never
 *  compared against a stored or default quota. */
export interface GrowthSkip {
  shardId: string;
  reason: string;
}

/** The figures a growth was decided on. */
export interface GrowthTrigger {
  triggeringShardId: string;
  vcpuInUse: number;
  grantedQuota: number;
}

/** What one `growKind` call did. Carries ids and figures only, never a
 *  credential. */
export type GrowthResult =
  | { result: 'not_aws'; fleetKind: string; error: GrowthKindNotAwsError }
  | { result: 'below_threshold'; fleetKind: string; skipped: GrowthSkip[] }
  | {
      result: 'in_flight';
      fleetKind: string;
      /** The unfinished growth holding the kind; null when another pass holds
       *  the kind's lock at this instant. */
      eventId: string | null;
      skipped: GrowthSkip[];
    }
  | (GrowthTrigger & {
      result: 'grown';
      fleetKind: string;
      outcome: Exclude<FleetGrowthOutcomeDTO, 'refused'>;
      eventId: string;
      promotedSpareId: string | null;
      newShardId: string;
      quotaRequestId: string | null;
      skipped: GrowthSkip[];
    })
  | (GrowthTrigger & {
      result: 'refused';
      fleetKind: string;
      /** AWS's reason, or the refusal's own text — never a credential. */
      reason: string;
      /** A spare promoted before the create was refused: the promotion stands. */
      promotedSpareId: string | null;
      skipped: GrowthSkip[];
    });

/** What one `settleGrantedSpares` call did. */
export interface SettleSparesResult {
  fleetKind: string;
  /** The kind's lock was held by another pass; nothing was read. */
  locked: boolean;
  /** Spares a waiting growth created, now in the shared pool. */
  joined: Array<{ shardId: string; eventId: string }>;
  /** Replacement spares whose raise was granted, now the kind's ready spare. */
  readied: string[];
}
