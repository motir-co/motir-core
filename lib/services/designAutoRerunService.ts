import type { DesignAutoRerun, DesignAutoRerunSkipReason } from '@/generated/prisma/client';
import { DESIGN_AUTO_RERUN_CAP } from '@/lib/approvalGates/designAutoRerunCap';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import {
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedRunBootFailedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunNoCapacityError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
} from '@/lib/hostedRuns/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { designAutoRerunRepository } from '@/lib/repositories/designAutoRerunRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A HOSTED DESIGN SENT BACK IS RE-RUN ON ITS OWN (Story MOTIR-693 · MOTIR-700;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1).
//
// Called by the `design/auto-rerun.requested` job, which the design handler's Revise
// enqueues AFTER the deciding transaction commits (§1g) — so a start that fails never
// undoes a refusal a person made, and the reviewer's press never waits on a container
// boot.
//
// THE RULES, each one the record's:
//   · §1a — only a Motir-pressed Revise, and only when the card's LATEST dispatch run
//     was hosted. A BYOK or hand-run card is never moved onto the hosted agent, and
//     gets no record at all: nothing was attempted.
//   · §1b — as the person who started that run, with that run's model, through
//     `hostedRunService.start` — Run hosted's own path and every one of its
//     pre-flights. `run` mode, the design card alone.
//   · §1d — any refusal skips it and the card says why. A model is NEVER substituted.
//   · §1e — at most three, counted from Motir-pressed Revise refusals, never reset.
//   · §1f — the reason reaches the run through MOTIR-6070's dispatch prompt; nothing
//     here copies it.
//
// IDEMPOTENT on the refusal: the record is unique on the gate, and the start carries
// an idempotency key derived from the gate, so a redelivered event — or a retry
// that died between the start and the record — starts at most one run.

/** How many automatic re-runs one card may have (§1e) — re-exported from its home. */
export { DESIGN_AUTO_RERUN_CAP };

/** The `design/auto-rerun.requested` event payload. */
export interface DesignAutoRerunRequestedData {
  workspaceId: string;
  /** The `changes_requested` + `revise` design gate. */
  gateId: string;
  /** The gate id — the job's dedup key. */
  idempotencyKey: string;
}

/** What one attempt did — `not_a_candidate` writes nothing (§1a). */
export type DesignAutoRerunAttempt =
  | { outcome: 'not_a_candidate' }
  | { outcome: 'recorded'; record: DesignAutoRerun };

/** The start path's refusals, each the reason the card will show. */
function skipReasonFor(err: unknown): DesignAutoRerunSkipReason | null {
  if (err instanceof ProjectNotFoundError || err instanceof PermissionDeniedError) {
    return 'no_project_access';
  }
  if (err instanceof CiCreditsExhaustedError) return 'ci_credits_exhausted';
  if (err instanceof HostedModelNotOfferedError) return 'model_not_offered';
  if (err instanceof HostedModelsUnavailableError) return 'models_unavailable';
  if (err instanceof HostedRunOutOfCreditsError) return 'out_of_credits';
  // No agent-run capacity right now (MOTIR-9633): recorded, never retried or queued.
  if (err instanceof HostedRunNoCapacityError) return 'no_capacity';
  if (err instanceof HostedRunCreditsUnavailableError) return 'credits_unavailable';
  if (err instanceof HostedRunRepositoryNotWritableError) return 'repository_not_writable';
  if (err instanceof HostedRunCardNotReadyError) return 'card_not_ready';
  return null;
}

export const designAutoRerunService = {
  async attempt(data: DesignAutoRerunRequestedData): Promise<DesignAutoRerunAttempt> {
    const { workspaceId, gateId } = data;

    // ── 1 · Is this refusal a candidate, and has it already been answered? ──────
    const candidate = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const gate = await approvalGateRepository.findById(gateId, tx);
      if (
        !gate ||
        gate.workItemId === null ||
        gate.kind !== 'design_result' ||
        gate.state !== 'changes_requested' ||
        gate.refusalVerdict !== 'revise' ||
        gate.decidedAt === null ||
        gate.decisionSource === null ||
        !(['ui', 'api', 'mcp'] as const).includes(gate.decisionSource as 'ui' | 'api' | 'mcp')
      ) {
        return null;
      }
      const existing = await designAutoRerunRepository.findByGateId(gateId, tx);
      if (existing) return { existing };

      const lane = await dispatchRunRepository.findLatestLaneForWorkItem(gate.workItemId, tx);
      // Hosted only: an automatic re-run never targets a developer's own agent
      // (`agent-instance-run.md` — Motir starts no run in a user's agent itself).
      if (!lane || lane.origin !== 'hosted') return null;

      const item = await workItemRepository.findById(gate.workItemId, tx);
      if (!item) return null;
      const ordinal = await approvalGateRepository.countPressedRevisesUpTo(
        gate.workItemId,
        gate.decidedAt,
        tx,
      );
      return {
        existing: null,
        workItemId: item.id,
        identifier: item.identifier,
        lane,
        ordinal,
      };
    });
    if (!candidate) return { outcome: 'not_a_candidate' };
    if (candidate.existing) return { outcome: 'recorded', record: candidate.existing };

    const { workItemId, identifier, lane, ordinal } = candidate;

    // ── 2 · The checks that need no start: the cap, the dispatcher, the model. ────
    let skipReason: DesignAutoRerunSkipReason | null = null;
    let dispatchRunId: string | null = null;
    let refusedRepository: string | null = null;
    if (ordinal > DESIGN_AUTO_RERUN_CAP) skipReason = 'cap_reached';
    else if (lane.createdById === null) skipReason = 'dispatcher_gone';
    else if (lane.model === null) skipReason = 'model_not_offered';
    else {
      // ── 3 · Run hosted's own start, as the dispatcher, with their model. ─────
      try {
        const started = await hostedRunService.start(
          {
            workItemKey: identifier,
            model: lane.model,
            idempotencyKey: `design-auto-rerun:${gateId}`,
          },
          { userId: lane.createdById, workspaceId },
        );
        dispatchRunId = started.dispatchRunId;
      } catch (err) {
        // A boot that failed AFTER the run opened still started a run: the card
        // links to it, and the run's own record says how it ended.
        if (err instanceof HostedRunBootFailedError) {
          dispatchRunId = err.dispatchRunId;
        } else {
          skipReason = skipReasonFor(err);
          if (err instanceof HostedRunRepositoryNotWritableError) {
            refusedRepository = err.refusals[0]?.repository ?? null;
          }
          // Anything else is not a refusal the card can explain — let the job retry.
          if (skipReason === null) throw err;
        }
      }
    }

    // ── 4 · Record it — once per refusal. ─────────────────────────────────────
    const record = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const raced = await designAutoRerunRepository.findByGateId(gateId, tx);
      if (raced) return raced;
      // WHAT THE LINE NAMES (MOTIR-702), captured now — a record of the moment.
      let detail: string | null = null;
      if (skipReason === 'no_project_access' && lane.createdById) {
        detail = (await userRepository.findById(lane.createdById, tx))?.name ?? null;
      } else if (skipReason === 'model_not_offered' || skipReason === 'no_capacity') {
        detail = lane.model;
      } else if (skipReason === 'repository_not_writable') {
        detail = refusedRepository;
      }
      return designAutoRerunRepository.create(
        {
          workspaceId,
          workItemId,
          gateId,
          outcome: skipReason === null ? 'started' : 'skipped',
          skipReason,
          dispatchRunId: skipReason === null ? dispatchRunId : null,
          ordinal,
          detail,
        },
        tx,
      );
    });
    return { outcome: 'recorded', record };
  },

  /** A card's attempts, newest first — what the design card's line reads (MOTIR-702). */
  async listForWorkItem(workItemId: string, workspaceId: string): Promise<DesignAutoRerun[]> {
    return withWorkspaceServiceContext(workspaceId, (tx) =>
      designAutoRerunRepository.listByWorkItem(workItemId, tx),
    );
  },
};
