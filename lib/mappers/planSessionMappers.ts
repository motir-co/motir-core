import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import { isPlanWalkPhase, type PlanStatusDto } from '@/lib/dto/plans';
import {
  PLAN_SESSION_SEED_GATE_KINDS,
  type PlanSessionEndReasonDto,
  type PlanSessionRowDto,
  type PlanSessionSeedDto,
  type PlanSessionSeedGateKindDto,
  type PlanSessionStateDto,
} from '@/lib/dto/planSessions';
import type { PlanSessionListRow } from '@/lib/repositories/planChangeSessionRepository';

function isSeedGateKind(kind: string | null): kind is PlanSessionSeedGateKindDto {
  return (PLAN_SESSION_SEED_GATE_KINDS as readonly (string | null)[]).includes(kind);
}

/**
 * The row's SEED (MOTIR-6209), or null.
 *
 * ⚠️ THE BROWSE CHECK IS THE LIST'S OWN ACCESS SCOPE. The list is gated on
 * browsing the session's project (`planSessionsService.listSessions`), and a
 * work item is browsable exactly when its project is (`workItemsService
 * .getWorkItem`). So a seed resolves only when the gate's work item is still in
 * the SESSION's project — the one this viewer was already cleared for. A work
 * item that has left the project is treated as unbrowsable, never checked
 * against a second project here, so the seed can never name a key the viewer
 * could not open. The gate row gone (`SetNull`) reads the same: no seed.
 */
function seedOf(row: PlanSessionListRow): PlanSessionSeedDto | null {
  // A GUIDE seed (MOTIR-8697) — Confirm on a guide's re-plan offer. The same
  // browse rule as a gate seed: the guided card resolves only while it is in the
  // SESSION's project, so its key is never shown to a viewer who could not open
  // it. It has no gate, so no gate kind and no chosen label.
  if (row.seedGuideTurnId) {
    if (!row.seedGuideCardInProject || !row.seedGuideCardKey) return null;
    return { cardKey: row.seedGuideCardKey, gateKind: null, origin: 'guide', chosenLabel: null };
  }
  if (!row.seedGateId || !row.seedCardInProject || !row.seedCardKey) return null;
  if (!isSeedGateKind(row.seedGateKind)) return null;
  // A PICK (MOTIR-6434): an approved choice with its stamped label. Anything else a
  // seed can come from is a refusal.
  const pick =
    row.seedGateKind === 'decision_choice' &&
    row.seedGateState === 'approved' &&
    typeof row.seedChosenLabel === 'string' &&
    row.seedChosenLabel !== '';
  return {
    cardKey: row.seedCardKey,
    gateKind: row.seedGateKind,
    origin: pick ? 'pick' : 'refusal',
    chosenLabel: pick ? row.seedChosenLabel : null,
  };
}

/**
 * The session's first turn, as THIS viewer may read it.
 *
 * ⚠️ PRIVACY (MOTIR-6209, the MOTIR-6206 design's flag). A seeded session's first
 * turn opens with the refused work item's `{key} · {title}` (MOTIR-6208's
 * composer), and the Plans list shows every session of the project to every
 * member who can browse it — it is NOT per member. So when the session was
 * seeded but its work item is out of this viewer's reach, the turn is withheld
 * and the row is known by its plan instead, exactly as a turn-less session is.
 */
function firstTurnOf(row: PlanSessionListRow): string | null {
  if (row.seedGateId && !row.seedCardInProject) return null;
  // A guide-seeded session's first turn is the guide's re-plan request about the
  // GUIDED card (MOTIR-8697) — withheld by the same rule, for the same reason.
  if (row.seedGuideTurnId && !row.seedGuideCardInProject) return null;
  return row.firstTurn?.trim() || null;
}

/**
 * One raw session-list row → the row DTO (MOTIR-6025). The latest plan's title
 * falls back to its summary, so an agent plan that named itself only in prose
 * still reads as something; an empty string is no title.
 */
export function toPlanSessionRowDto(row: PlanSessionListRow): PlanSessionRowDto {
  return {
    id: row.id,
    origin: row.origin as PlanSessionOriginDto,
    targetKeys: row.targetKeys,
    lastActivityAt: row.lastActivityAt.toISOString(),
    startedBy:
      row.starterId && row.starterName ? { id: row.starterId, name: row.starterName } : null,
    firstTurn: firstTurnOf(row),
    latestPlan: row.planId
      ? {
          id: row.planId,
          status: row.planStatus as PlanStatusDto,
          title: row.planTitle?.trim() || row.planSummary?.trim() || null,
        }
      : null,
    planCount: row.planCount,
    state: row.state as PlanSessionStateDto,
    failure:
      row.failedAt && row.failureReason
        ? {
            failedAt: row.failedAt.toISOString(),
            reason: row.failureReason,
            stopPhase: isPlanWalkPhase(row.failureStopPhase) ? row.failureStopPhase : null,
            stopTitle: row.failureStopTitle ?? null,
            notPlannedYet: row.failureNotPlannedYet ?? [],
          }
        : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endReason: (row.endReason as PlanSessionEndReasonDto | null) ?? null,
    endedBy: row.endedById && row.endedByName ? { id: row.endedById, name: row.endedByName } : null,
    copiedFrom: row.copiedFromId
      ? { id: row.copiedFromId, endedAt: row.copiedFromEndedAt?.toISOString() ?? null }
      : null,
    seed: seedOf(row),
  };
}
