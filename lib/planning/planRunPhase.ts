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
 * The quick reply an ASK turn's job wrote (MOTIR-11797), while this screen streams that
 * turn and it is not a plan run: the rail draws it as the turn's first assistant bubble,
 * above the progress notes, until the answer lands — the settle ends the stream and
 * clears the job, and the bubble with it. `null` before the frame arrives, when it never
 * does, when the stored reply belongs to another job, and whenever a plan run is on
 * screen: its conversation bubble draws the reply itself (`conversationAckFor`), which
 * is where an ask's reply carries on when the turn hands off to one.
 */
export function askAckFor(
  state: PlanRunState & Pick<PlanChangeConversationState, 'conversationAck'>,
): string | null {
  const ack = state.conversationAck ?? null;
  if (ack === null || state.phase !== 'streaming' || state.jobId !== ack.jobId) return null;
  return planRunPhase(state) === null ? ack.text : null;
}

/**
 * The ask job of an UNANSWERED conversation turn a REOPENED viewer is looking at
 * (MOTIR-11797): the thread's last person turn, read by an `ask_project` job whose answer
 * is not on the thread yet. `null` while this screen streams a turn of its own (it draws
 * that one live), on an ended session, when the last turn is answered, ran as a plan
 * change, or was typed mid-run (a mid-run question draws its own answering row).
 * The hook replays that job's frames for its `conversation_ack`, so the reply the person
 * missed is drawn under their turn, above its notes, until the answer lands.
 */
export function reopenedAskJobId(
  state: Pick<PlanChangeConversationState, 'phase' | 'session'>,
): string | null {
  if (state.phase === 'streaming') return null;
  const session = state.session;
  if (!session || session.endedAt) return null;
  const last = [...session.turns].reverse().find((t) => t.role === 'user');
  if (!last?.jobId || last.intent === 'plan_change' || last.runJobId) return null;
  const answered = session.turns.some((t) => t.role === 'assistant' && t.jobId === last.jobId);
  return answered ? null : last.jobId;
}

/**
 * The quick reply drawn under an unanswered turn on a REOPENED thread (MOTIR-11797): the
 * replayed `conversation_ack` of `jobId`, while that turn is still the one
 * {@link reopenedAskJobId} names. `null` otherwise.
 */
export function reopenedAskAckFor(
  state: Pick<PlanChangeConversationState, 'phase' | 'session' | 'conversationAck'>,
  jobId: string | null | undefined,
): string | null {
  const ack = state.conversationAck ?? null;
  if (ack === null || !jobId || ack.jobId !== jobId) return null;
  return reopenedAskJobId(state) === jobId ? ack.text : null;
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
