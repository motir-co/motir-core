import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

/**
 * Which half of a PLAN RUN is in flight (MOTIR-8203): `conversation` while
 * PART 1 settles the target, the entry and the requirement (and may still come
 * back with a question), `planning` once the run's `target_settled` frame has
 * arrived, and `null` when no plan run is in flight. The ONE definition of the
 * boundary: the hand-off bubble reads it, and so does anything else that shows
 * only during the conversation phase.
 *
 * Two viewers see a run. The LIVE one streams it (`streaming` with a plan id);
 * a REOPENED one watches the `generating` plan a Motir run is writing, and
 * settles from the replay of that run's frames ({@link reopenedPlanJobId}).
 * Both answer from the same `settledJobId`, so they agree.
 */
export type PlanRunPhase = 'conversation' | 'planning';

type PlanRunState = Pick<
  PlanChangeConversationState,
  'phase' | 'planId' | 'jobId' | 'settledJobId' | 'liveReview' | 'session'
>;

export function planRunPhase(state: PlanRunState): PlanRunPhase | null {
  const job = planRunJobId(state);
  if (job === undefined) return null;
  return job !== null && (state.settledJobId ?? null) === job ? 'planning' : 'conversation';
}

/** The job the plan run on screen is — live or reopened — or `undefined` when none. */
function planRunJobId(state: PlanRunState): string | null | undefined {
  if (state.phase !== 'streaming') return reopenedPlanJobId(state);
  return state.planId !== null ? state.jobId : undefined;
}

/**
 * The quick reply the conversation-phase bubble draws (MOTIR-10738): the
 * `conversation_ack` text of the run ON SCREEN, while that run is still in its
 * conversation phase. `null` before the frame arrives, when it never does (an older
 * job, a failed model call), when the stored reply belongs to another job, and once
 * the run has settled — the bubble then falls back to its keyed line, or is gone.
 */
export function conversationAckFor(
  state: PlanRunState & Pick<PlanChangeConversationState, 'conversationAck'>,
): string | null {
  const ack = state.conversationAck ?? null;
  if (ack === null || planRunPhase(state) !== 'conversation') return null;
  return planRunJobId(state) === ack.jobId ? ack.text : null;
}

/**
 * The job a REOPENED viewer is watching (MOTIR-8203): the session's latest job,
 * while the plan on screen is a `generating` plan Motir itself is writing.
 * `undefined` when there is no such run — an agent writing over MCP has no job
 * and no conversation phase.
 */
export function reopenedPlanJobId(
  state: Pick<PlanChangeConversationState, 'phase' | 'planId' | 'liveReview' | 'session'>,
): string | undefined {
  if (state.phase === 'streaming') return undefined;
  const live = state.liveReview;
  if (!live || live.status !== 'generating' || live.authorSource !== 'native') return undefined;
  if (state.planId !== null && live.id !== state.planId) return undefined;
  return state.session?.lastJobId ?? undefined;
}
