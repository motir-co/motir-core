import type { GateResume, GateResumeSkipReason } from '@/generated/prisma/client';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import {
  HostedContinueRefusedError,
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
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import {
  dispatchRunRepository,
  type DispatchRunWithCards,
} from '@/lib/repositories/dispatchRunRepository';
import { gateResumeRepository } from '@/lib/repositories/gateResumeRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { GateResumeRequestedData } from '@/lib/services/gateResumeRequest';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A HOSTED RUN THAT STOPPED AT A GATE RESUMES ITSELF WHEN THE GATE IS APPROVED
// (Story MOTIR-7701 · MOTIR-7710).
//
// The hosted design auto re-run (`designAutoRerunService`, MOTIR-700) one decision
// over, and deliberately its shape: the job is asked AFTER the decision commits, so a
// start that fails never undoes an approval and a press never waits on a container;
// it starts as the person who started the run, with that run's model, through Run
// hosted's own path; any refusal is RECORDED and the run waits on To resume; and it is
// idempotent on the gate.
//
// THE RULES, in the handler's order — each "no" records a skip and starts nothing:
//   · the gate is approved now (a choice chosen, a direction confirmed and manual work
//     marked done all write `approved`);
//   · the run it held is its card's LATEST run and closed `gated` — anything newer is
//     a continue (`already_resumed`) or work that moved on (nothing at all);
//   · the run was HOSTED. A local or agent run is the person's to resume with
//     `motir continue`; that is not a failure, and writes NOTHING;
//   · the run's target is not on To fix — To fix wins over To resume (MOTIR-8011), and
//     an approval on a target whose pull requests are red starts and writes NOTHING;
//   · the dispatcher still exists and may still edit the project;
//   · then `hostedRunService.start` in `continue` mode — which takes the continue
//     claim, so a second approval racing the first answers `already_resumed`.

export type { GateResumeRequestedData } from '@/lib/services/gateResumeRequest';

/** What one attempt did — `not_a_candidate` writes nothing. */
export type GateResumeAttempt =
  | { outcome: 'not_a_candidate' }
  | { outcome: 'recorded'; record: GateResume };

/** The start path's refusals, each the reason the To resume entry will show. */
function skipReasonFor(err: unknown): GateResumeSkipReason | null {
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
  if (err instanceof HostedContinueRefusedError) {
    return err.reason === 'taken' ? 'already_resumed' : 'not_resumable';
  }
  return null;
}

export const gateResumeService = {
  async attempt(data: GateResumeRequestedData): Promise<GateResumeAttempt> {
    const { workspaceId, gateId } = data;

    // ── 1 · Is this approval a candidate, and has it already been answered? ──────
    type Candidate =
      | { record: GateResume }
      | { run: DispatchRunWithCards; target: { identifier: string } | null };
    const candidate = await withWorkspaceServiceContext(
      workspaceId,
      async (tx): Promise<Candidate | null> => {
        const gate = await approvalGateRepository.findById(gateId, tx);
        if (!gate || gate.workItemId === null || gate.state !== 'approved') return null;
        const existing = await gateResumeRepository.findByGateId(gateId, tx);
        if (existing) return { record: existing };

        const runIds = await dispatchRunHeldGateRepository.listRunIdsByWorkItemAndKind(
          gate.workItemId,
          gate.kind,
          tx,
        );
        for (const runId of runIds) {
          const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
          if (!run || run.status !== 'succeeded' || run.stopReason !== 'gated') continue;
          // The card the run was pointed at: its scope, or its one leg.
          // A run that held a gate recorded the leg the gate is on, so one is found.
          /* v8 ignore next */
          const targetId = run.scopeWorkItemId ?? run.cards[0]?.workItemId ?? null;
          /* v8 ignore next */
          if (targetId === null) continue;
          const latest = await dispatchRunRepository.findLatestForWorkItem(targetId, tx);
          /* v8 ignore next -- `run` is one of the target's runs, so it has a latest */
          if (!latest) continue;
          if (latest.id !== run.id) {
            // Something newer holds the card. A continue is somebody's resume of this
            // run (or of a later one) — recorded, so the entry can say so. Anything
            // else is work that moved on, and nothing waits any more.
            if (latest.command !== 'continue' || run.origin !== 'hosted') continue;
            return { run, target: null };
          }
          // Hosted only: a local or agent run is the person's to resume, and gets no
          // record — nothing was attempted (`agent-instance-run.md`: Motir starts no
          // run in a user's agent itself).
          if (run.origin !== 'hosted') return null;
          const target = await workItemRepository.findById(targetId, tx);
          /* v8 ignore next -- the run's own card, read in the same transaction */
          if (!target) continue;
          // TO FIX WINS OVER TO RESUME (MOTIR-8011): a target on To fix is not there to
          // resume — its pull requests come first — so the approval starts nothing.
          if (target.fixReason !== null) return null;
          return { run, target };
        }
        return null;
      },
    );
    if (!candidate) return { outcome: 'not_a_candidate' };
    if ('record' in candidate) return { outcome: 'recorded', record: candidate.record };

    const { run, target } = candidate;

    // ── 2 · The checks that need no start: newer work, the dispatcher, the model. ─
    let skipReason: GateResumeSkipReason | null = null;
    let resumedRunId: string | null = null;
    let detail: string | null = null;
    if (target === null) skipReason = 'already_resumed';
    else if (run.createdById === null) skipReason = 'dispatcher_gone';
    else if (run.model === null) skipReason = 'model_not_offered';
    else {
      // ── 3 · Continue hosted's own start, as the dispatcher, with their model. ──
      try {
        const started = await hostedRunService.start(
          {
            workItemKey: target.identifier,
            model: run.model,
            idempotencyKey: `gate-resume:${gateId}`,
            mode: 'continue',
          },
          { userId: run.createdById, workspaceId },
        );
        resumedRunId = started.dispatchRunId;
      } catch (err) {
        // A boot that failed AFTER the run opened still started a run: the entry
        // links to it, and the run's own record says how it ended.
        if (err instanceof HostedRunBootFailedError) {
          resumedRunId = err.dispatchRunId;
        } else {
          skipReason = skipReasonFor(err);
          if (err instanceof HostedRunRepositoryNotWritableError) {
            /* v8 ignore next -- the refusal always names at least one repository */
            detail = err.refusals[0]?.repository ?? null;
          } else if (err instanceof HostedContinueRefusedError && skipReason === 'not_resumable') {
            detail = err.reason;
          }
          // Anything else is not a refusal the entry can explain — let the job retry.
          if (skipReason === null) throw err;
        }
      }
    }

    // ── 4 · Record it — once per approval. ────────────────────────────────────
    const record = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const raced = await gateResumeRepository.findByGateId(gateId, tx);
      /* v8 ignore next -- race-only: a redelivery recorded between the start and here */
      if (raced) return raced;
      // WHAT THE LINE NAMES, captured now — a record of the moment.
      if (skipReason === 'no_project_access' && run.createdById) {
        /* v8 ignore next -- the dispatcher was read a moment ago, when the start refused */
        detail = (await userRepository.findById(run.createdById, tx))?.name ?? null;
      } else if (skipReason === 'model_not_offered' || skipReason === 'no_capacity') {
        detail = run.model;
      }
      return gateResumeRepository.create(
        {
          workspaceId,
          gateId,
          runId: run.id,
          resumedRunId: skipReason === null ? resumedRunId : null,
          outcome: skipReason === null ? 'started' : 'skipped',
          skipReason,
          detail,
        },
        tx,
      );
    });
    return { outcome: 'recorded', record };
  },
};
