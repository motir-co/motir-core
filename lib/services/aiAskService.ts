import type { ProjectContext } from '@/lib/projects';
import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { turnSubmitKey } from '@/lib/ai/turnSubmitKey';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import { resolvePlanningCodeContext } from '@/lib/ai/codeContext';
import { planRunContextService, type RunContext } from '@/lib/services/planRunContextService';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import { planChangeLateChangeService } from '@/lib/services/planChangeLateChangeService';
import { plansService } from '@/lib/services/plansService';
import type { MailboxDeliveryDto } from '@/lib/dto/planChangeMailbox';
import type {
  AskConversationTurn,
  CarriedAnswers,
  JobContextBag,
  JobStreamEvent,
} from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  planChangeSessionsService,
  carriedAnswersFor,
} from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { readAskOutcome } from '@/lib/planning/askResult';
import { planOfferService, type PendingPlanOfferStatement } from '@/lib/services/planOfferService';
import { logBugOfferService } from '@/lib/services/logBugOfferService';
import { debugLandingService } from '@/lib/services/debugLandingService';
import { readCodeUnreadable } from '@/lib/planning/codeUnreadable';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { pendingPlanOfferOf } from '@/lib/planChange/planOffer';
import type { AskOfferReply } from '@/lib/planning/askResult';
import {
  planOfferStartService,
  type PlanOfferStartResult,
} from '@/lib/services/planOfferStartService';
import {
  AskAnchorNotAvailableError,
  DebugAnchorNotTriageBugError,
  DebugTargetChangedError,
  DebugTargetNotAvailableError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeFlipNotOfferedError,
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanChangeTurnNotFoundError,
  PlanOfferNotOpenError,
  PlanOfferStartRefusedError,
  PlanSessionEndedError,
  PlanTargetLockedError,
  TurnFilesGuideOnlyError,
} from '@/lib/planChange/errors';
import { PROJECT_SCOPE, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { pendingQuestion } from '@/lib/planning/planChangeThread';
import { aiGuideService, type GuideTurnResult } from '@/lib/services/aiGuideService';
import { guideLandingService, type GuideSettleResult } from '@/lib/services/guideLandingService';

// The ASK seam (Story MOTIR-1343 · MOTIR-1819) — the motir-core side of "Ask
// about this project".
//
// ⚠️ IT IS THE COMPOSER'S ONE DOOR, not an "ask-only" endpoint the client picks
// when it already knows. `docs/decisions/conversation-turn-intent.md` §1/§2
// (decided by MOTIR-1816): the client posts the TEXT and never an intent, and
// what the turn turns out to be is the JOB'S answer, not the caller's claim.
// Every user turn is submitted as `ask_project` and READ (AMENDMENT 5 · MOTIR-9216):
// outside a planning run motir-ai answers every turn — no classifier, no redirect.
// Inside one its router may still hand a turn back as `intent: 'plan_change'`, and
// {@link aiAskService.settle} forwards it; a stored `plan_change` turn from before
// the amendment still re-runs through the SHIPPED plan-change submit.
//
// ── WHY THE SETTLE IS A SEPARATE CALL ────────────────────────────────────────
// Nothing in core observes a motir-ai job finishing: the run is watched by the
// BROWSER's SSE subscription, and motir-ai calls no webhook back. So the client
// that saw the stream settle is the one that tells the server to go read the
// result and file it — exactly the shape `recordPlannerTurn` already takes for
// the planner's own turn. That makes the call REPLAYABLE by construction (a
// reload, a second tab, a retried settle), which is why the answer append is
// keyed on the job id and the user turn is keyed on it too.
//
// ── SIDE EFFECTS OUTSIDE THE TRANSACTION (CLAUDE.md) ─────────────────────────
// Submitting and reading a job are network calls; appending a turn is a DB
// write. They never share a transaction — the turn is appended, then the job is
// submitted, then the turn is bound to it. A submit that fails therefore leaves
// the person's words ON the thread rather than dropping them: the thread is the
// record, the rail's shipped error state is recoverable in place, and
// {@link aiAskService.resubmit} re-runs the SAME turn without appending a second.
//
// ── SCOPE: THE PROJECT-WIDE THREAD, DELIBERATELY ─────────────────────────────
// Every call here works the project's ONE conversation (`scopeKey = ''`), not an
// item-ANCHORED thread. The shipped contextual path (7.12.3 · MOTIR-909) is
// untouched and keeps its own submit; the intent decision settled how a turn is
// CLASSIFIED, and said nothing about anchoring an ask at a work-item set, so
// widening this to anchored threads would be deciding that here rather than
// where it belongs. An anchored ask is a follow-up, not an omission.
//
// ── THE ANCHOR (MOTIR-7047 · the ADR's AMENDMENT 1, A1.2) ────────────────────
// A turn MAY name ONE work item it is about (`anchorKey`) — usually the triage
// bug the person just reported. It does NOT move the turn off the project-wide
// thread; it is DATA the job reads: the classifier is told the turn is anchored
// there and reads it first. The key is resolved through the KEYED read
// (`workItemsService.getWorkItemByIdentifier`, which includes triage rows — only
// LIST reads exclude them) and browse-gated, pinned to the active project.
//
// ── NO DEBUG ARM, NO NEW-SESSION ARM (AMENDMENT 5 · MOTIR-9231) ──────────────
// A defect report and "plan something else" are answered like any other turn, so
// core submits no `debug_bug` job and writes no new-session confirm any more. The
// turns stored under those intents stay readable, landings and confirms included;
// a retry of one re-runs it as an ordinary ask.

/** What a submitted ask turn tells the caller: the job to stream, and the turn
 *  the settle will key on. The session comes back too, so the rail renders the
 *  new turn from the server's copy rather than an optimistic guess. */
export interface AskSubmitResult {
  jobId: string;
  turnId: string;
  session: PlanChangeSessionDto;
}

/**
 * What a settled ask turn produced. Exactly one of five states, and they are
 * kept apart deliberately because the rail renders each differently:
 *
 *  * `answered` — an `assistant` turn is on the thread, with its citations.
 *  * `redirected` — the turn was a plan change; `jobId` / `planId` name the
 *    plan-edit job now running, and the shipped diff + confirm chrome takes over.
 *  * `silent` — the job ran and said nothing at all. Core persists NOTHING for
 *    this: an assistant turn needs a body, and inventing one would mean motir-core
 *    writing the assistant's words. (An honest "I could not find that" is prose
 *    the handler DOES return, and lands as an ordinary answer with no citations —
 *    that is `answered`, not this.)
 */
/** A turn that did NOT open an ask job: it went straight to the shipped
 *  plan-change submit, and `jobId` / `planId` name the plan-edit job now
 *  running. Both entrances can produce it — {@link aiAskService.submitTurn} when
 *  the turn answers a pending question, and {@link aiAskService.resubmit} when
 *  the handler hands a turn back. */
export interface AskRedirectResult {
  outcome: 'redirected';
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

export type AskSettleResult =
  | { outcome: 'answered'; session: PlanChangeSessionDto }
  | { outcome: 'redirected'; jobId: string; planId: string; session: PlanChangeSessionDto }
  | { outcome: 'silent'; session: PlanChangeSessionDto }
  // A MID-RUN turn (MOTIR-7996) the answering session read as a CHANGE: its words
  // went down the running job's mailbox, `delivery` being the mailbox as it stands.
  | { outcome: 'forwarded'; delivery: MailboxDeliveryDto; session: PlanChangeSessionDto }
  // …or would have, but the run is over. The person's turn stays on the thread as
  // an `ask`; `text` is the words to hand back to the composer. `jobStatus` names
  // how the run ended. `code` is why the words were not revised into the plan
  // (MOTIR-7997): a late-change refusal code, or the mailbox's own mismatch code.
  | {
      outcome: 'forward_refused';
      code: string;
      jobStatus: string;
      text: string;
      session: PlanChangeSessionDto;
    }
  // …or the run's WALK was over but its plan not yet decided (MOTIR-7997): the
  // change became ONE REVISE_PLAN revision of that same plan, and the user turn is
  // recorded `plan_change` with the revision job. Not `forward_refused`: nothing
  // went back to the person.
  | {
      outcome: 'revised_late';
      planId: string;
      revisionJobId: string;
      text: string;
      session: PlanChangeSessionDto;
    }
  // A guide conversation's settle (MOTIR-7470), handed to the guide landing.
  | GuideSettleResult;

function tenantFor(
  ctx: ProjectContext,
  organizationId: string,
  isMeta: boolean,
  internalBilling: boolean,
  // The two languages (MOTIR-8742): the org's content language and the language
  // of the person who typed the turn.
  languages: Awaited<ReturnType<typeof resolveTenantLanguages>>,
) {
  return {
    organizationId,
    isMeta,
    internalBilling,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
    contentLanguage: languages.contentLanguage,
    personLanguage: languages.personLanguage,
  };
}

/** The most earlier turns an `ask_project` submit carries. */
export const ASK_CONVERSATION_TURNS_MAX = 20;

/**
 * The conversation's earlier turns as `ask_project` reads them (MOTIR-9442): a person
 * turn is its body, a Motir turn its answer text; system turns and blank ones are
 * dropped, and only the last {@link ASK_CONVERSATION_TURNS_MAX} stay, oldest first.
 * Pass the turns BEFORE the one being answered.
 */
export function conversationTurnsOf(
  turns: readonly Pick<PlanChangeTurnDto, 'role' | 'body'>[],
): AskConversationTurn[] {
  const out: AskConversationTurn[] = [];
  for (const t of turns) {
    if (t.role === 'system') continue;
    const text = t.body.trim();
    if (text) out.push({ role: t.role === 'user' ? 'person' : 'motir', text });
  }
  return out.slice(-ASK_CONVERSATION_TURNS_MAX);
}

/** What a conversation turn tells the answering session about the conversation so far. */
interface AskConversation {
  turns: AskConversationTurn[];
  carriedAnswers?: CarriedAnswers;
}

/** Submit ONE conversation job — always `ask_project` (MOTIR-9231). The gate + tenant resolution are the shipped ones
 *  (`aiChatService.submitDiscoveryTurn`'s shape); nothing about metering or
 *  availability is re-implemented here — an out-of-credits org surfaces as the
 *  client's typed `MotirAiOutOfCreditsError`. */
async function submitAsk(
  prompt: string,
  anchorKey: string | null,
  ctx: ProjectContext,
  /** MID-RUN (MOTIR-7996): the run snapshot, `ask_project` only. */
  run?: RunContext,
  /** The turn this job answers, and the job it held before (MOTIR-9255): the
   *  submit is keyed on that attempt, so a re-send never runs it twice. */
  keyedOn?: TurnAttempt,
  /** NO RUN only (MOTIR-9290): the offer standing when the person spoke, read before
   *  their turn was appended; undefined when none is, so the key is not sent. */
  pendingPlanOffer?: PendingPlanOfferStatement,
  /** The earlier turns, and the Grill me answers on a no-run turn (MOTIR-9442). */
  conversation?: AskConversation,
): Promise<{ jobId: string }> {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const languages = await resolveTenantLanguages({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  // The CODE half (MOTIR-7922): the same planning producer the plan-edit submits
  // use (`aiPlanEditsService`). motir-ai offers its code-graph tools only when
  // `context.code.repos[]` names a repository, so without it every question ran
  // code-blind on a fully indexed project. `undefined` means
  // "no connected repo", and the key is then OMITTED, never sent empty.
  const code = await resolvePlanningCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
  });
  const context: JobContextBag = {
    prompt,
    ...(anchorKey ? { anchorKey } : {}),
    ...(run ? { run } : {}),
    // One carrier per fact: with a run, the snapshot's own `pendingOffer` states it.
    ...(!run && pendingPlanOffer ? { pendingPlanOffer } : {}),
    ...(code ? { code } : {}),
    ...(conversation && conversation.turns.length > 0
      ? { conversationTurns: conversation.turns }
      : {}),
    ...(conversation?.carriedAnswers ? { carriedAnswers: conversation.carriedAnswers } : {}),
  };
  return submitJob(
    'ask_project',
    tenantFor(ctx, organizationId, isMeta, internalBilling, languages),
    context,
    { userId: ctx.userId },
    keyedOn
      ? { idempotencyKey: turnSubmitKey(keyedOn.turnId, 'ask_project', keyedOn.attempt) }
      : {},
  );
}

/** A turn's submit attempt (MOTIR-9255): the turn, and the job it held before
 *  this submit — null for its first. */
interface TurnAttempt {
  turnId: string;
  attempt: string | null;
}

/** `{ carriedAnswers }` when the conversation settled any, else nothing to spread. */
async function carriedAnswersOrNone(
  session: Pick<PlanChangeSessionDto, 'id' | 'origin'>,
  ctx: ProjectContext,
): Promise<{ carriedAnswers?: CarriedAnswers }> {
  const carriedAnswers = await carriedAnswersFor(session, ctx);
  return carriedAnswers ? { carriedAnswers } : {};
}

function attemptOf(turn: PlanChangeTurnDto): TurnAttempt {
  return { turnId: turn.id, attempt: turn.jobId ?? null };
}

/**
 * The turn the answering session last OFFERED to forward, still unconfirmed
 * (MOTIR-7996): the thread's latest `assistant` turn, when it carries a
 * `forwardOffer` and no user turn after it was forwarded. ANY newer answer
 * supersedes an older offer (it is no longer the latest assistant turn), and a
 * forward that already happened retires it. Read from CORE's own thread, never
 * from anything a client or the model sent.
 */
function pendingOfferOf(turns: readonly PlanChangeTurnDto[]): { turnText: string } | null {
  let latest = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'assistant') {
      latest = i;
      break;
    }
  }
  if (latest < 0) return null;
  const offer = turns[latest]!.forwardOffer;
  if (!offer) return null;
  for (let i = latest + 1; i < turns.length; i++) {
    if (turns[i]!.role === 'user' && turns[i]!.forwarded) return null;
  }
  return { turnText: offer };
}

/**
 * Resolve a turn's anchor to its identifier, or refuse it (MOTIR-7047).
 *
 * The KEYED read, pinned to the ACTIVE project: `getWorkItemByIdentifier` looks
 * the key up by `(projectId, identifier)`, so another project's key simply does
 * not resolve; it checks the workspace and asserts browse. It does NOT exclude
 * triage items — that exclusion belongs to LIST reads — which is exactly what
 * makes a triage bug a legal anchor (ADR AMENDMENT 1, A1.2) without a new read.
 *
 * Every "not for you" collapses into ONE typed 404, the planning-anchor route's
 * no-existence-leak answer.
 */
async function resolveAnchor(anchorKey: string, ctx: ProjectContext): Promise<string> {
  try {
    const item = await workItemsService.getWorkItemByIdentifier(ctx.projectId, anchorKey, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return item.identifier;
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      throw new AskAnchorNotAvailableError();
    }
    throw err;
  }
}

/**
 * The offer a typed reply decides, or null (MOTIR-9291). Judged over CORE's own
 * thread BEFORE the turn being settled — the `seq < turn.seq` slice `settleMidRun`
 * reads — so a reply's own answer can never confirm itself, and the reply must name
 * exactly the offer that was pending, by its turn's `seq` and its kind.
 */
function repliedOffer(
  session: PlanChangeSessionDto,
  turn: PlanChangeTurnDto,
  reply: AskOfferReply | undefined,
): { turnId: string; kind: string; decision: AskOfferReply['decision'] } | null {
  if (!reply) return null;
  const pending = pendingPlanOfferOf(session.turns.filter((t) => t.seq < turn.seq));
  if (!pending || pending.seq !== reply.seq || pending.offer.kind !== reply.kind) return null;
  return { turnId: pending.turnId, kind: pending.offer.kind, decision: reply.decision };
}

/**
 * A typed yes to a `log_bug` offer (MOTIR-9323): the SAME landing the Confirm press
 * runs, through the same claim. A refusal (a stale or unreadable target, a declined
 * offer) leaves the offer as the landing found it — still confirmable on the rail —
 * and the answer lands either way.
 */
async function landOrNothing(
  ctx: ProjectContext,
  input: { conversationId: string; offerTurnId: string },
): Promise<void> {
  try {
    await debugLandingService.confirmLogBugOffer(ctx, input);
  } catch (err) {
    if (
      err instanceof PlanOfferStartRefusedError ||
      err instanceof DebugTargetChangedError ||
      err instanceof DebugTargetNotAvailableError ||
      err instanceof DebugAnchorNotTriageBugError ||
      err instanceof PermissionDeniedError
    ) {
      return;
    }
    throw err;
  }
}

/**
 * A start a settle makes, or null when it was refused. The answer lands either way: a
 * typed yes that cannot start is still a turn the person must see answered, and the
 * refusal leaves the offer as the start found it (`out_of_credits` recorded on it).
 */
async function startOrNothing(
  start: () => Promise<PlanOfferStartResult | null>,
): Promise<PlanOfferStartResult | null> {
  try {
    return await start();
  } catch (err) {
    if (
      err instanceof PlanOfferStartRefusedError ||
      err instanceof PlanTargetLockedError ||
      err instanceof PlanSessionEndedError ||
      err instanceof MotirAiOutOfCreditsError ||
      err instanceof PermissionDeniedError
    ) {
      return null;
    }
    throw err;
  }
}

/** The thread's turn with this id, from a session DTO. */
function turnById(session: PlanChangeSessionDto, turnId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.id === turnId) ?? null;
}

/** The `user` turn a job was submitted for, or null. The settle's key. */
function turnByJobId(session: PlanChangeSessionDto, jobId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.role === 'user' && t.jobId === jobId) ?? null;
}

/**
 * The session a CONTINUING ask write works on (MOTIR-6023; AMENDMENT 17 §2):
 * the one the client holds, else the caller's own resumable project-wide
 * session. A re-run or a settle continues a conversation, so with neither there
 * is nothing to continue.
 */
async function requireAskSession(
  ctx: ProjectContext,
  sessionId: string | undefined,
): Promise<PlanChangeSessionDto> {
  const session = sessionId
    ? await planChangeSessionsService.getById(ctx, sessionId)
    : await planChangeSessionsService.findResumable(ctx, PROJECT_SCOPE_KEY);
  if (!session) throw new PlanChangeSessionNotFoundError(ctx.projectId);
  return session;
}

/**
 * The settle of a MID-RUN turn (MOTIR-7996). Entered only for a turn carrying
 * `runJobId` whose outcome is `plan_change` or `ask`.
 *
 *  * `plan_change` → a FORWARD. The body is chosen from CORE's own record and never
 *    from the echo: `forward.text` only selects WHICH of two texts core already
 *    holds — this turn's body, or the pending offer's (the confirmation case).
 *    Anything else is ignored and settles `silent`: model output never crosses
 *    into the planner's input.
 *  * `ask` with `offerForward` → the answer, recording the offer.
 *  * `ask` otherwise → an ordinary answer.
 */
async function settleMidRun(args: {
  jobId: string;
  turn: PlanChangeTurnDto;
  outcome: NonNullable<ReturnType<typeof readAskOutcome>>;
  session: PlanChangeSessionDto;
  ctx: ProjectContext;
  address: { sessionId: string };
  /** The settled job's raw result — read only for the outage flag (MOTIR-8141). */
  result: unknown;
}): Promise<AskSettleResult> {
  const { jobId, turn, outcome, session, ctx, address } = args;
  const runJobId = turn.runJobId!;

  if (outcome.intent === 'plan_change') {
    // Already forwarded by an earlier settle of this same job: the answer is the
    // mailbox as it stands, and nothing is written (the idempotency key would
    // make a second attach a no-op anyway, but the run may have ended since).
    if (turn.forwarded) {
      const delivery = await planChangeMailboxService.peekForJob(runJobId, ctx, session.id);
      return { outcome: 'forwarded', delivery, session };
    }
    // Already revised in by an earlier settle of this same job (MOTIR-7997): the
    // revision exists, so answer it again and submit nothing. The revision job
    // is the plan's `sourceJobId` now, which is how the plan is found again.
    if (turn.revisedLate) {
      const planId = await plansService.findPlanIdForJob(turn.revisedLate.revisionJobId, ctx);
      if (planId) {
        return {
          outcome: 'revised_late',
          planId,
          revisionJobId: turn.revisedLate.revisionJobId,
          text: turn.body,
          session,
        };
      }
    }
    const offered = pendingOfferOf(session.turns.filter((t) => t.seq < turn.seq))?.turnText;
    const echoed = outcome.forward?.text ?? null;
    const chosen =
      echoed === null
        ? null
        : echoed === turn.body
          ? turn.body
          : echoed === offered
            ? offered
            : null;
    if (!chosen) return { outcome: 'silent', session };

    let delivery: MailboxDeliveryDto;
    try {
      delivery = await planChangeMailboxService.attachTurn(
        {
          jobId: runJobId,
          sessionId: session.id,
          body: chosen,
          idempotencyKey: `forward:${jobId}`,
          disposition: 'fold',
        },
        ctx,
      );
    } catch (err) {
      // The run is over: nothing was written. The person's turn stays on the
      // thread as an `ask` and nothing is retried; the words go back to them.
      if (err instanceof PlanChangeJobNotRunningError) {
        // THE WALK IS OVER BUT THE PLAN MAY NOT BE CLOSED (MOTIR-7997): a change
        // that arrives now is applied as a revision of the run's own plan, not lost.
        // `reviseLate` refuses with a reason (a decided plan, a stopped or failed
        // run, another revision holding the plan) and the text goes back.
        const late = await planChangeLateChangeService.reviseLate(
          { sessionId: session.id, runJobId, texts: [chosen] },
          ctx,
        );
        if (late.outcome === 'revised') {
          const updated = await planChangeSessionsService.recordTurnIntent(
            turn.id,
            'plan_change',
            ctx,
            { revisedLateJobId: late.revisionJobId },
            address,
          );
          return {
            outcome: 'revised_late',
            planId: late.planId,
            revisionJobId: late.revisionJobId,
            text: chosen,
            session: updated,
          };
        }
        return {
          outcome: 'forward_refused',
          code: late.code,
          jobStatus: err.status,
          text: chosen,
          session,
        };
      }
      // The session has moved on to another job since the turn was typed — the
      // run this turn was addressed at is no longer the thread's. Same fact, same
      // answer: keep the words.
      if (err instanceof PlanChangeMailboxJobMismatchError) {
        return {
          outcome: 'forward_refused',
          code: err.code,
          jobStatus: 'superseded',
          text: chosen,
          session,
        };
      }
      throw err;
    }
    const entryId = await planChangeMailboxService.entryIdForKey(
      runJobId,
      session.id,
      `forward:${jobId}`,
      ctx,
    );
    const updated = await planChangeSessionsService.recordTurnIntent(
      turn.id,
      'plan_change',
      ctx,
      entryId ? { forwardedEntryId: entryId } : {},
      address,
    );
    return { outcome: 'forwarded', delivery, session: updated };
  }

  // `ask`: an answer, with the offer recorded when the handler was unsure.
  if (!outcome.answer) return { outcome: 'silent', session };
  // The offer is the OFFERED turn's own body (core's record); an echo that says
  // anything else is not an offer core can honour, and is dropped.
  const forwardOffer = outcome.offerForward?.text === turn.body ? turn.body : null;
  const updated = await planChangeSessionsService.appendAnswerTurn(
    {
      jobId,
      body: outcome.answer,
      citations: outcome.citations,
      forwardOffer,
      codeUnreadable: readCodeUnreadable(args.result) === 'answered' ? 'answered' : null,
    },
    ctx,
    address,
  );
  return { outcome: 'answered', session: updated };
}

export const aiAskService = {
  /**
   * The composer's door: append what the person typed, then run it.
   *
   * The turn is appended with `intent: 'ask'` because that is what is ABOUT to
   * run — the field records the EFFECTIVE disposition, not a guess — and moves to
   * `plan_change` at settle if the handler hands it back. `jobId` binds the turn
   * to its job in a second, locked write, because the job does not exist until
   * after the append.
   */
  async submitTurn(
    body: string,
    ctx: ProjectContext,
    opts: {
      isAnswer?: boolean;
      sessionId?: string;
      seedGateId?: string;
      anchorKey?: string;
      /** Files on the turn (MOTIR-7484) — legal on a GUIDE conversation only
       *  (`guide-turn-files.md` A3.2 / A3.7), where the guide intake checks them. */
      attachmentIds?: readonly string[];
    } = {},
  ): Promise<AskSubmitResult | AskRedirectResult | GuideTurnResult> {
    const trimmed = body.trim();
    const attachmentIds = opts.attachmentIds ?? [];
    if (!trimmed && attachmentIds.length === 0) throw new EmptyPlanChangeTurnError();
    // Files ride a turn addressed at a session only: with no session, the turn
    // would start (or join) the project conversation, which is never a guide.
    if (attachmentIds.length > 0 && !opts.sessionId) throw new TurnFilesGuideOnlyError();

    // `ai:plan` — the same key the plan-change submit asserts, and for the same
    // reason: an ask turn spends the workspace's AI credits.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );

    // The anchor (MOTIR-7047), resolved BEFORE anything is written: an anchor the
    // caller may not see is refused with no turn appended and no job submitted.
    const anchor = opts.anchorKey ? await resolveAnchor(opts.anchorKey, ctx) : null;

    // WHICH conversation (MOTIR-6023; AMENDMENT 17 §2–§3): the session the
    // client holds, else the caller's own resumable project-wide session. With
    // neither, THIS turn starts one — the door stays self-sufficient, and a
    // session exists from its first turn, never from a look.
    //
    // A SEEDED first turn (a pick anchored at the project, MOTIR-6435) never joins
    // the caller's resumable project conversation: it starts — or resumes — the
    // session THIS gate seeded, under the seed guard (`startSeededWithFirstTurn`,
    // which refuses a gate that may not seed the project scope).
    const seeded = !opts.sessionId && opts.seedGateId ? opts.seedGateId : null;
    const current = opts.sessionId
      ? await planChangeSessionsService.getById(ctx, opts.sessionId)
      : seeded
        ? null
        : await planChangeSessionsService.findResumable(ctx, PROJECT_SCOPE_KEY);
    // A GUIDE conversation (MOTIR-7464; ADR AMENDMENT 2, A2.1): the session's
    // origin decides the turn, never the client. It is handed to the guide
    // intake whole — no `ask_project` job, so no classifier completion is spent.
    if (current?.origin === 'guide') {
      return aiGuideService.submitTurn(trimmed, ctx, {
        sessionId: current.id,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
    }
    // Only a guide conversation takes files (A3.7): refused before any write.
    if (attachmentIds.length > 0) throw new TurnFilesGuideOnlyError();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    if (!current) {
      const started = seeded
        ? await planChangeSessionsService.startSeededWithFirstTurn(
            ctx,
            PROJECT_SCOPE,
            trimmed,
            seeded,
            { isAnswer: opts.isAnswer === true, anchorKey: anchor },
          )
        : await planChangeSessionsService.startWithFirstTurn(ctx, PROJECT_SCOPE, trimmed, {
            isAnswer: opts.isAnswer === true,
            anchorKey: anchor,
          });
      const first = started.turns.at(-1);
      if (!first) throw new PlanChangeTurnNotFoundError('(the turn just appended)');
      // A fresh session has no pending question, so this is the ask branch.
      const { jobId } = await submitAsk(trimmed, anchor, ctx, undefined, attemptOf(first));
      const session = await planChangeSessionsService.recordTurnIntent(
        first.id,
        'ask',
        ctx,
        { jobId },
        { sessionId: started.id },
      );
      return { jobId, turnId: first.id, session };
    }
    const address = { sessionId: current.id };

    // ── ⭐ AN ANSWER TO A PENDING QUESTION SKIPS THE CLASSIFIER ──────────────
    //
    // `isAnswer` rides through because ADR §1's wire table says it does, and it
    // is NOT an intent: it records WHICH AFFORDANCE sent the turn. That is
    // exactly what makes it decisive here — the disposition is already known,
    // and it was recorded in the first place BECAUSE it cannot be re-derived
    // from the words.
    //
    // Classifying anyway is the expensive half of §4's asymmetry. A reply to a
    // blocking question is usually a fragment ("money in") that is neither a
    // question nor a request, so the default lands on `ask`, Motir answers it as
    // a project question, the planner's question stays pending forever and the
    // run never resumes — a thread the user has to un-stick by hand, which it
    // never needed before this door became the only one.
    //
    // ⚠️ THE FLAG ALONE IS NOT TRUSTED, which is what keeps the intent
    // server-resolved (§1). A client claiming `isAnswer` is honoured only when
    // the thread ACTUALLY has a pending question — the same derivation the rail
    // uses to decide whether to show the answer bar at all. Without that check
    // this would be a client-supplied intent wearing another name, which is the
    // back door §5 exists to close.
    const answersAQuestion = opts.isAnswer === true && pendingQuestion(current.turns) !== null;
    if (answersAQuestion) {
      await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
        // What actually RAN. The field records the effective disposition, and
        // what runs on this branch is the plan-change submit, not an ask.
        intent: 'plan_change',
        isAnswer: true,
      });
      // The SHIPPED submit, untouched: it accumulates every user turn in order,
      // which is how answering RESUMES the run rather than restarting it.
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    // Read BEFORE the append, so it is the offer standing when the person spoke
    // (MOTIR-9290) — the shape `submitMidRunTurn` uses for its forward offer.
    const pendingPlanOffer = planOfferService.statingPending(current.turns);
    // The same read gives the earlier turns (MOTIR-9442); the Grill me answers are read
    // NOW, at submit, so a Stop or Grill me switched off still carries what was settled.
    const conversation: AskConversation = {
      turns: conversationTurnsOf(current.turns),
      ...(await carriedAnswersOrNone(current, ctx)),
    };
    const appended = await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
      intent: 'ask',
      // Recorded even here: a turn sent from the answer bar when nothing was
      // pending is still a fact about the affordance, and the transcript keeps
      // facts rather than tidying them away.
      isAnswer: opts.isAnswer === true,
      // The RESOLVED anchor (MOTIR-7064), on the turn itself, so a reloaded
      // thread still draws the chip the person sent it with.
      anchorKey: anchor,
    });
    const turn = appended.turns.at(-1);
    if (!turn) throw new PlanChangeTurnNotFoundError('(the turn just appended)');

    const { jobId } = await submitAsk(
      trimmed,
      anchor,
      ctx,
      undefined,
      attemptOf(turn),
      pendingPlanOffer,
      conversation,
    );
    const session = await planChangeSessionsService.recordTurnIntent(
      turn.id,
      'ask',
      ctx,
      { jobId },
      address,
    );
    return { jobId, turnId: turn.id, session };
  },

  /**
   * A turn typed WHILE a planning run is in progress (Story MOTIR-7990 ·
   * MOTIR-7996; `conversation-turn-intent.md` AMENDMENT 4). It is not queued for
   * the planner: it goes to an ANSWERING session — `ask_project` with a run
   * snapshot on its context — and only a change verdict (or a confirmed ambiguous
   * turn) is forwarded, by {@link aiAskService.settle}.
   *
   * ⚠️ IT MUST NOT MOVE `session.lastJobId` off the planning job:
   * `requireThreadForJob` addresses the mailbox through it, and the forward at
   * settle goes through the mailbox. Only the TURN is bound to the ask job
   * (`recordTurnIntent(..., { jobId })`), never the session.
   *
   * Refused BEFORE any write when the addressed session is not on `runJobId`: the
   * mailbox's own no-existence-leak mismatch error (a 404).
   */
  async submitMidRunTurn(
    body: string,
    ctx: ProjectContext,
    opts: { sessionId: string; runJobId: string; planId: string },
  ): Promise<AskSubmitResult> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const current = await planChangeSessionsService.getById(ctx, opts.sessionId);
    // The session must BE on this run. A guide conversation never runs a plan.
    if (current.origin === 'guide' || current.lastJobId !== opts.runJobId) {
      throw new PlanChangeMailboxJobMismatchError(opts.runJobId);
    }
    const address = { sessionId: current.id };
    // Read BEFORE the append, so it is the offer standing when the person spoke.
    const pendingOffer = pendingOfferOf(current.turns);

    const appended = await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
      intent: 'ask',
      runJobId: opts.runJobId,
    });
    const turn = appended.turns.at(-1);
    if (!turn) throw new PlanChangeTurnNotFoundError('(the turn just appended)');

    // The snapshot and the submit are network/DB reads OUTSIDE any lock. The
    // snapshot never throws: an unreadable plan is `readable: false`, and the job
    // still runs so the person gets an honest "I could not read the run".
    const run = await planRunContextService.buildRunContext(
      opts.runJobId,
      opts.planId,
      ctx,
      pendingOffer,
    );
    // The earlier turns, never the carried answers: a run in flight is past grilling, and
    // carrying them would suppress a grilling the person has not had (MOTIR-9442).
    const { jobId } = await submitAsk(trimmed, null, ctx, run, attemptOf(turn), undefined, {
      turns: conversationTurnsOf(current.turns),
    });
    const session = await planChangeSessionsService.recordTurnIntent(
      turn.id,
      'ask',
      ctx,
      { jobId },
      address,
    );
    return { jobId, turnId: turn.id, session };
  },

  /**
   * Re-run a turn that is already on the thread — the RETRY after a failed
   * submit, and the CORRECTION affordance (ADR §3), which are the same write with
   * different bookkeeping.
   *
   * `flip: true` is the correction: the turn runs under the OTHER intent, and
   * `intentCorrected` latches. The DIRECTION is never supplied by the client —
   * it is derived from what the turn currently ran as, which is what keeps the
   * intent server-resolved (§1) even when a person is the one asking for the
   * change.
   *
   * No second `user` turn is ever appended: the person said one thing once.
   */
  async resubmit(
    turnId: string,
    ctx: ProjectContext,
    opts: { flip?: boolean; sessionId?: string; anchorKey?: string } = {},
  ): Promise<AskSubmitResult | AskRedirectResult | GuideTurnResult> {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );

    const current = await requireAskSession(ctx, opts.sessionId);
    // A guide turn's retry (MOTIR-7464): the guide intake re-runs it, replay-safe.
    // There is no flip — a guide turn has no other intent (A2.1).
    if (current.origin === 'guide') {
      return aiGuideService.resubmit(turnId, ctx, { sessionId: current.id });
    }
    const address = { sessionId: current.id };
    const turn = turnById(current, turnId);
    if (!turn || turn.role !== 'user') throw new PlanChangeTurnNotFoundError(turnId);

    // The flip runs ONE WAY: a turn that did not run as `ask` flips to `ask`. An
    // ANSWERED turn does not flip at all — AMENDMENT 3 retired §3's "Propose
    // changes instead", because whether a turn becomes a planning run is the
    // planner's call, never a person's button. It is refused before anything is
    // recorded or submitted.
    const ran = turn.intent ?? 'ask';
    if (opts.flip && ran === 'ask') throw new PlanChangeFlipNotOfferedError(turnId);
    // Every turn is READ now (AMENDMENT 5 · MOTIR-9231): a stored `debug` or
    // `new_session` turn re-runs as an ordinary ask. Only an unflipped `plan_change`
    // turn keeps its shipped retry.
    const next = !opts.flip && ran === 'plan_change' ? 'plan_change' : 'ask';
    const anchor = opts.anchorKey ? await resolveAnchor(opts.anchorKey, ctx) : null;

    if (next === 'plan_change') {
      // Hand it to the SHIPPED plan-change submit. Untouched: it accumulates the
      // thread's user turns exactly as it always has.
      await planChangeSessionsService.recordTurnIntent(
        turnId,
        'plan_change',
        ctx,
        // Only a RETRY reaches here: a flip never produces a plan change.
        { corrected: false },
        address,
      );
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    // A RETRY re-sends the attempt that did not come back (MOTIR-9255); a flip is a
    // new reading of the turn, so it runs fresh and unkeyed.
    const { jobId } = await submitAsk(
      turn.body,
      anchor,
      ctx,
      undefined,
      opts.flip ? undefined : attemptOf(turn),
      // The offer that stood when this turn was first typed: the thread before it.
      planOfferService.statingPending(current.turns.filter((t) => t.seq < turn.seq)),
      {
        turns: conversationTurnsOf(current.turns.filter((t) => t.seq < turn.seq)),
        ...(turn.runJobId ? {} : await carriedAnswersOrNone(current, ctx)),
      },
    );
    const session = await planChangeSessionsService.recordTurnIntent(
      turnId,
      'ask',
      ctx,
      { corrected: opts.flip === true, jobId },
      address,
    );
    return { jobId, turnId, session };
  },

  /**
   * Read a settled `ask_project` job and file what it produced.
   *
   * REPLAYABLE: the answer append is idempotent on the job id, and the redirect
   * arm is guarded by the turn's current intent, so a second settle of the same
   * job neither duplicates a bubble nor dispatches a second plan-edit job.
   *
   * There is no debug or new-session arm (AMENDMENT 5 · MOTIR-9231). A result
   * still carrying one of those outcomes — a job that finished across the deploy —
   * has no answer, so it settles `silent` and writes nothing.
   */
  async settle(
    jobId: string,
    ctx: ProjectContext,
    opts: { sessionId?: string } = {},
  ): Promise<AskSettleResult> {
    const session = await requireAskSession(ctx, opts.sessionId);
    // A guide turn's job is landed by the guide landing (MOTIR-7470; A2.4), never
    // read as an ask: the session's origin decides, as it did at submit.
    if (session.origin === 'guide') {
      return guideLandingService.settle(jobId, ctx, { sessionId: session.id });
    }
    const address = { sessionId: session.id };
    const turn = turnByJobId(session, jobId);
    // A job id this thread never submitted is not an error — the client may be
    // replaying a stale settle after a newer turn — so it yields the thread as it
    // stands, the same disposition `recordPlannerTurn` takes for a mismatch.
    if (!turn) return { outcome: 'silent', session };

    const job = await getJob(jobId, ctx.projectId);

    const outcome = readAskOutcome(job.result);
    if (!outcome) return { outcome: 'silent', session };

    // ⚠️ THE MID-RUN ARM (MOTIR-7996) — BEFORE the `plan_change` arm below, so a
    // turn typed during a run can never reach `planChangeSessionsService.submit`
    // and open a SECOND planning job on a thread that already has one.
    if (turn.runJobId && (outcome.intent === 'plan_change' || outcome.intent === 'ask')) {
      return settleMidRun({ jobId, turn, outcome, session, ctx, address, result: job.result });
    }

    if (outcome.intent === 'plan_change') {
      // Already redirected by an earlier settle of this same job — do not submit
      // a second plan-edit job for one turn.
      if (turn.intent === 'plan_change') return { outcome: 'silent', session };
      await planChangeSessionsService.recordTurnIntent(turn.id, 'plan_change', ctx, {}, address);
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    if (!outcome.answer) return { outcome: 'silent', session };

    // THE REPLY TO A PENDING OFFER (MOTIR-9291), decided BEFORE the answer is
    // appended: the answer supersedes the offer, so it must still be undecided when
    // it is judged. A decline writes `declined`; an agree starts exactly what the
    // Confirm button starts, through the same claim. A replayed settle finds the offer
    // decided and does neither again.
    const replied = repliedOffer(session, turn, outcome.offerReply);
    if (replied?.decision === 'decline') {
      await planOfferService.declinePlanOffer(replied.turnId, ctx, address).catch((err) => {
        if (!(err instanceof PlanOfferNotOpenError)) throw err;
      });
    }
    if (replied?.decision === 'agree' && replied.kind === 'log_bug') {
      await landOrNothing(ctx, { conversationId: session.id, offerTurnId: replied.turnId });
    }
    let started =
      replied?.decision === 'agree' && replied.kind === 'plan'
        ? await startOrNothing(() =>
            planOfferStartService.confirmPlanOffer(ctx, {
              conversationId: session.id,
              offerTurnId: replied.turnId,
            }),
          )
        : null;

    // The offer (MOTIR-9290) is gated HERE, where the answer lands, and rides the
    // SAME append: it can never precede its answer or outlive a failed write, and a
    // failed gate stores no offer while the answer still lands. Nothing on this arm
    // submits or records a `plan_change` / `new_session` intent.
    // A `log_bug` offer (MOTIR-9322) lands through its own door, with its target
    // re-resolved against the RESOLVED anchor of the turn it answers.
    const answerOffer =
      outcome.offer?.kind === 'log_bug'
        ? await logBugOfferService.land(outcome.offer, ctx, turn.anchorKey ?? null)
        : await planOfferService.land(outcome.offer, ctx);
    const updated = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId,
        body: outcome.answer,
        citations: outcome.citations,
        // The answer was given without the code (MOTIR-8141): stored with the turn.
        codeUnreadable: readCodeUnreadable(job.result) === 'answered' ? 'answered' : null,
        answerOffer,
      },
      ctx,
      address,
    );
    // "Plan this" with a grounded target (`immediate`): no offer was stored, and the
    // plan starts at once, claimed on the person's turn so a replay starts nothing.
    if (
      !started &&
      outcome.offer?.kind === 'plan' &&
      outcome.offer.immediate &&
      outcome.offer.targetKey
    ) {
      const anchorKey = outcome.offer.targetKey;
      started = await startOrNothing(() =>
        planOfferStartService.startTargetedPlan(ctx, {
          conversationId: session.id,
          askJobId: jobId,
          anchorKey,
        }),
      );
    }
    if (started) {
      return {
        outcome: 'redirected',
        jobId: started.jobId,
        planId: started.planId,
        session: started.session,
      };
    }
    return { outcome: 'answered', session: updated };
  },

  /** The live channel the rail subscribes to — the shipped job stream, relayed. */
  streamAsk(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },
};
