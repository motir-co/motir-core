import type { PlanChangeRunPause } from '@/generated/prisma/client';

import { getJob } from '@/lib/ai/motirAiClient';
import type { MailboxDeliveryDto } from '@/lib/dto/planChangeMailbox';
import type { PlanChangeRunPauseDto } from '@/lib/dto/planChange';
import { toPlanChangeRunPauseDto } from '@/lib/mappers/planChangeMappers';
import {
  EmptyPlanChangeTurnError,
  PlanChangeJobNotRunningError,
  PlanChangeRunPauseAnsweredError,
  PlanChangeRunPauseNotFoundError,
  PlanChangeRunPausePlanDecidedError,
  PlanChangeRunPauseShapeError,
  PlanChangeRunPauseTurnMismatchError,
  PlanChangeSessionNotFoundError,
} from '@/lib/planChange/errors';
import {
  parseCodeUnsearchableRepos,
  type CodeUnsearchableRepo,
} from '@/lib/planning/codeUnsearchable';
import { PLANNER_QUESTION_MAX_CHARS } from '@/lib/planning/plannerTurn';
import {
  findQuestionOption,
  questionOptionJson,
  readQuestionOption,
  readQuestionOptions,
  type QuestionOption,
} from '@/lib/planning/questionOptions';
import { planChangeMailboxRepository } from '@/lib/repositories/planChangeMailboxRepository';
import { planChangeRunPauseRepository } from '@/lib/repositories/planChangeRunPauseRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import {
  planChangeMailboxService,
  requireThreadForJob,
  type MailboxContext,
} from '@/lib/services/planChangeMailboxService';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE PLANNER'S MID-RUN PAUSE (Story MOTIR-7990 · MOTIR-8007; the decision
// `conversation-turn-intent.md` AMENDMENT 4).
//
// A walk session rules a forwarded change a CORRECTION, a RE-PLAN or UNCLEAR about
// WHAT. On the last two the walk pauses while its JOB KEEPS RUNNING, and the planner
// records ONE open pause here:
//
//   * `replan`  — it OFFERS a one-click START OVER. YES is the shipped `restart`
//     mailbox turn; NO is a `fold` turn marked `declines_pause_id` that tells the
//     walk to apply the change to the work items already written.
//   * `code_unsearchable` — a TARGET repository's code cannot be SEARCHED (never
//     indexed, indexing for the first time, refreshes failing or paused; MOTIR-9165).
//     The pause names each blocked repository and why. It takes no text and no
//     button but one: the person resumes the walk once the code can be searched,
//     and the run re-checks on receipt (motir-ai's side).
//   * `unclear` — it ASKS what was meant. The person's reply is a `fold` turn
//     marked `answers_pause_id`, ruled again as any change. No planning bug is filed.
//
// ⚠️ A3.1 HOLDS. `conversation-turn-intent.md` A3.1 retired the person-chosen
// "Propose changes instead" button because whether a turn becomes a planning run is
// the planner's reading alone. The START OVER button here classifies nothing: the
// pause exists only because the PLANNER posted it, and the button accepts or
// declines a remedy the planner already chose (the decision's ruling). The unclear
// question adds no button: the person answers by typing.
//
// ⚠️ NOT THE END-OF-JOB QUESTION (MOTIR-2226). `PlanChangeTurn.question` is written
// when a job has ENDED and its answer (`POST …/session/turns`, `isAnswer`) submits a
// NEW planning run. A mid-run question must reach THIS run instead, so it is never an
// `assistant` turn with `question` set — that would put the shipped answer bar in
// front of the person, and its send would open a second run beside the paused one.
//
// ⚠️ THE PERSON'S WORDS — OR THE PERSON'S PICK. Every body written to the mailbox is
// assembled from core's stored mailbox rows or the person's reply. The planner's
// `reason` and `question` are shown to the person and NEVER sent back. An `unclear`
// question carries 2 to 4 OPTIONS (MOTIR-11700), drawn as choices beside the reply
// box: a click answers with that option — its id is checked against the options THIS
// pause stored, and the option travels to the walk as `answerOption` — and a typed
// reply to a question that offered options travels marked `ownWords`, so the walk
// reads it as the person's instruction rather than as one of the options.
//
// CLAIM, THEN DELIVER. An answer is claimed under the SESSION row lock (the lock the
// mailbox and the transcript share) before the motir-ai round-trip, then delivered
// OUTSIDE any transaction on the key `run-pause:<id>:<choice>`: two tabs race on the
// claim, never on the mailbox, and a retry writes nothing twice.

/** The fixed instruction a NO writes ahead of the change bodies. */
export const PAUSE_DECLINE_INSTRUCTION =
  'The person declined to start over. Apply this change to the work items already written, removing cards where the change requires it:';

/** The fixed body a RESUME delivers (MOTIR-9167). The run reads the pause the entry
 *  answers (`answersQuestion`), not these words; they are the non-empty fallback every
 *  mailbox turn carries, and they are the person's decision, not the planner's text. */
export const PAUSE_RESUME_TEXT =
  'Resume planning: the code can be searched now. Check the target repositories again and continue.';

const REPLAN_REASON_MAX_CHARS = 500;
const REPLY_MAX_CHARS = 20_000;

export type PauseKindInput = 'replan' | 'unclear' | 'code_unsearchable';
export type PauseChoice = 'start_over' | 'apply' | 'reply' | 'resume';

export interface RecordPauseInput {
  jobId: string;
  kind: PauseKindInput;
  changeTurnIds: readonly string[];
  reason?: string | null;
  question?: string | null;
  /** The `unclear` question's options (MOTIR-11700) — `[{ id, label, means }]`, optional. */
  options?: unknown;
  /** The blocked target repositories — required, and only, on `code_unsearchable`. */
  repos?: unknown;
  idempotencyKey: string;
}

export type RecordPauseResult = {
  outcome: 'recorded' | 'already_open';
  pause: PlanChangeRunPauseDto;
};

export interface AnswerPauseInput {
  sessionId: string;
  jobId: string;
  pauseId: string;
  choice: PauseChoice;
  text?: string | null;
  /** A reply that PICKED one of the question's options (MOTIR-11700): its id. */
  optionId?: string | null;
}

export type AnswerPauseResult =
  | { outcome: 'answered'; pause: PlanChangeRunPauseDto; delivery: MailboxDeliveryDto }
  | {
      outcome: 'refused';
      code: string;
      jobStatus: string;
      choice: PauseChoice;
      text?: string;
      pause: PlanChangeRunPauseDto;
    };

const CHOICE_ANSWER = {
  start_over: 'start_over',
  apply: 'apply',
  reply: 'replied',
  resume: 'resumed',
} as const;

function ctxOf(pctx: MailboxContext) {
  return { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId };
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** The kind ↔ text-field pairing, checked BEFORE any network or lock. */
function assertRecordShape(input: RecordPauseInput): {
  reason: string | null;
  question: string | null;
  options: QuestionOption[] | null;
  repos: CodeUnsearchableRepo[] | null;
} {
  const reason = nonBlank(input.reason);
  const question = nonBlank(input.question);
  const hasOptions = input.options !== undefined && input.options !== null;
  if (input.kind !== 'unclear' && hasOptions) {
    throw new PlanChangeRunPauseShapeError(`a ${input.kind} pause takes no \`options\``);
  }
  const repos = input.repos === undefined || input.repos === null ? null : parseRepos(input.repos);
  if (input.kind !== 'code_unsearchable' && input.repos !== undefined && input.repos !== null) {
    throw new PlanChangeRunPauseShapeError(`a ${input.kind} pause takes no \`repos\``);
  }
  if (input.kind === 'code_unsearchable') {
    if (!repos) {
      throw new PlanChangeRunPauseShapeError(
        'a code_unsearchable pause needs a non-empty `repos` list of { repoRef, state }',
      );
    }
    if (reason)
      throw new PlanChangeRunPauseShapeError('a code_unsearchable pause takes no `reason`');
    if (question) {
      throw new PlanChangeRunPauseShapeError('a code_unsearchable pause takes no `question`');
    }
    return { reason: null, question: null, options: null, repos };
  }
  if (input.kind === 'replan') {
    if (!reason) throw new PlanChangeRunPauseShapeError('a replan pause needs a `reason`');
    if (question) throw new PlanChangeRunPauseShapeError('a replan pause takes no `question`');
    if (reason.length > REPLAN_REASON_MAX_CHARS) {
      throw new PlanChangeRunPauseShapeError(
        `\`reason\` is over ${REPLAN_REASON_MAX_CHARS} characters`,
      );
    }
    if (input.changeTurnIds.length === 0) {
      throw new PlanChangeRunPauseShapeError('a replan pause names the change turns it is about');
    }
    return { reason, question: null, options: null, repos: null };
  }
  if (input.kind === 'unclear') {
    if (!question) throw new PlanChangeRunPauseShapeError('an unclear pause needs a `question`');
    if (reason) throw new PlanChangeRunPauseShapeError('an unclear pause takes no `reason`');
    if (question.length > PLANNER_QUESTION_MAX_CHARS) {
      throw new PlanChangeRunPauseShapeError(
        `\`question\` is over ${PLANNER_QUESTION_MAX_CHARS} characters`,
      );
    }
    const options = hasOptions ? readQuestionOptions(input.options) : null;
    if (hasOptions && !options) {
      throw new PlanChangeRunPauseShapeError(
        '`options` must be a list of 2 to 4 { id, label, means }, each id unique',
      );
    }
    return { reason: null, question, options, repos: null };
  }
  throw new PlanChangeRunPauseShapeError(
    '`kind` must be `replan`, `unclear` or `code_unsearchable`',
  );
}

function parseRepos(value: unknown): CodeUnsearchableRepo[] {
  const repos = parseCodeUnsearchableRepos(value);
  if (!repos) {
    throw new PlanChangeRunPauseShapeError(
      '`repos` must be a non-empty list of { repoRef, state }, each state one of never_indexed, indexing, refresh_failing, paused, provider_unsupported, unavailable',
    );
  }
  return repos;
}

function assertChoiceFits(
  kind: string,
  choice: PauseChoice,
  text: string | null,
  optionId: string | null,
): void {
  if (optionId && !(kind === 'unclear' && choice === 'reply')) {
    throw new PlanChangeRunPauseShapeError('only a reply to an unclear question picks an option');
  }
  if (kind === 'replan' && (choice === 'start_over' || choice === 'apply')) return;
  if (kind === 'code_unsearchable' && choice === 'resume') return;
  if (kind === 'unclear' && choice === 'reply') {
    if (optionId) return;
    if (!text) throw new PlanChangeRunPauseShapeError('a reply needs non-blank `text`');
    if (text.length > REPLY_MAX_CHARS) {
      throw new PlanChangeRunPauseShapeError(`\`text\` is over ${REPLY_MAX_CHARS} characters`);
    }
    return;
  }
  throw new PlanChangeRunPauseShapeError(`choice \`${choice}\` does not fit a ${kind} pause`);
}

export const planChangeRunPauseService = {
  /**
   * THE JOB-TOKEN SIDE: the running planning job records ONE open pause.
   *
   * Idempotent per job and key (the same key returns the same pause, `recorded`);
   * while a pause is OPEN a different key answers `already_open` with that pause —
   * the walk is already paused on it, and a second card would be a second question.
   */
  async recordPause(input: RecordPauseInput, mctx: MailboxContext): Promise<RecordPauseResult> {
    if (!input.idempotencyKey) {
      throw new PlanChangeRunPauseShapeError('`idempotencyKey` is required');
    }
    const { reason, question, options, repos } = assertRecordShape(input);
    // The thread that is RUNNING this job (the mailbox mismatch error otherwise).
    const { sessionId } = await requireThreadForJob(input.jobId, mctx);

    // OUTSIDE any transaction: a motir-ai round-trip.
    const job = await getJob(input.jobId, mctx.projectId);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new PlanChangeJobNotRunningError(input.jobId, job.status);
    }
    const planId = await plansService.findPlanIdForJob(input.jobId, mctx);
    if (planId) {
      const plan = await plansService.getPlan(planId, mctx);
      if (plan.status === 'approved' || plan.status === 'declined') {
        throw new PlanChangeRunPausePlanDecidedError(planId, plan.status);
      }
    }

    return withWorkspaceContext(ctxOf(mctx), async (tx) => {
      const locked = await planChangeSessionRepository.lockById(sessionId, tx);
      if (!locked) throw new PlanChangeSessionNotFoundError(mctx.projectId);

      const same = await planChangeRunPauseRepository.findByIdempotencyKey(
        sessionId,
        input.jobId,
        input.idempotencyKey,
        mctx.workspaceId,
        tx,
      );
      if (same) return { outcome: 'recorded' as const, pause: toPlanChangeRunPauseDto(same) };

      const open = await planChangeRunPauseRepository.findOpenForJob(
        sessionId,
        input.jobId,
        mctx.workspaceId,
        tx,
      );
      if (open) return { outcome: 'already_open' as const, pause: toPlanChangeRunPauseDto(open) };

      const ids = [...new Set(input.changeTurnIds)];
      const rows = await planChangeMailboxRepository.findTurnsByIds(
        ids,
        sessionId,
        input.jobId,
        mctx.workspaceId,
        tx,
      );
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.find((id) => !found.has(id));
      if (missing) throw new PlanChangeRunPauseTurnMismatchError(missing);

      const created = await planChangeRunPauseRepository.create(
        {
          workspaceId: mctx.workspaceId,
          sessionId,
          jobId: input.jobId,
          kind: input.kind,
          changeTurnIds: ids,
          reason,
          question,
          ...(options ? { options: options.map(questionOptionJson) } : {}),
          ...(repos ? { unsearchableRepos: repos.map((r) => ({ ...r })) } : {}),
          idempotencyKey: input.idempotencyKey,
        },
        tx,
      );
      return { outcome: 'recorded' as const, pause: toPlanChangeRunPauseDto(created) };
    });
  },

  /**
   * THE PERSON'S SIDE: answer the open pause. Claim under the lock, then deliver.
   */
  async answer(input: AnswerPauseInput, pctx: MailboxContext): Promise<AnswerPauseResult> {
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    const { sessionId } = await requireThreadForJob(input.jobId, pctx, input.sessionId);
    const typed = nonBlank(input.text);
    const optionId = nonBlank(input.optionId);
    if (input.choice === 'reply' && !typed && !optionId) {
      throw new PlanChangeRunPauseShapeError('a reply needs non-blank `text` or an `optionId`');
    }
    // A picked option is resolved against THIS pause's stored options, under the lock.
    let picked: QuestionOption | null = null;
    let text = typed;

    // ── 1. CLAIM, under the session lock ──────────────────────────────────────
    const claimed = await withWorkspaceContext(ctxOf(pctx), async (tx) => {
      const locked = await planChangeSessionRepository.lockById(sessionId, tx);
      if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
      const pause = await planChangeRunPauseRepository.findById(
        input.pauseId,
        sessionId,
        input.jobId,
        pctx.workspaceId,
        tx,
      );
      if (!pause) throw new PlanChangeRunPauseNotFoundError(input.pauseId);
      assertChoiceFits(pause.kind, input.choice, text, optionId);
      if (optionId) {
        picked = findQuestionOption(readQuestionOptions(pause.options), optionId);
        if (!picked) {
          throw new PlanChangeRunPauseShapeError(
            `\`optionId\` ${optionId} is not one of this question's options`,
          );
        }
        // A click's words are the option's label: the reply is that option.
        text = picked.label;
      }

      if (pause.answer !== null) {
        const sameChoice = pause.answer === CHOICE_ANSWER[input.choice];
        // A reply is the same answer only with the same words and the same pick.
        const sameText =
          input.choice !== 'reply' ||
          (pause.replyText === text &&
            (readQuestionOption(pause.replyOption)?.id ?? null) === (picked?.id ?? null));
        if (!sameChoice || !sameText) {
          throw new PlanChangeRunPauseAnsweredError(pause.id, pause.answer);
        }
        return pause; // a replay
      }
      const count = await planChangeRunPauseRepository.markAnswered(
        pause.id,
        {
          answer: CHOICE_ANSWER[input.choice],
          answeredAt: new Date(),
          answeredById: pctx.userId,
          replyText: input.choice === 'reply' ? text : null,
          replyOption: input.choice === 'reply' && picked ? questionOptionJson(picked) : null,
        },
        tx,
      );
      // Cannot lose under the lock; guarded anyway.
      if (count === 0) throw new PlanChangeRunPauseAnsweredError(pause.id, 'unknown');
      return {
        ...pause,
        answer: CHOICE_ANSWER[input.choice],
        replyText: text,
        replyOption: picked ? questionOptionJson(picked) : null,
      } as PlanChangeRunPause;
    });

    // Already delivered by an earlier call: answer with the mailbox as it stands.
    if (claimed.mailboxEntryId) {
      const delivery = await planChangeMailboxService.peekForJob(input.jobId, pctx, sessionId);
      return { outcome: 'answered', pause: toPlanChangeRunPauseDto(claimed), delivery };
    }

    // ── 2. DELIVER, outside any transaction ───────────────────────────────────
    const body = await bodyFor(claimed, input.choice, text, pctx);
    const key = `run-pause:${claimed.id}:${input.choice}`;
    try {
      const delivery = await planChangeMailboxService.attachTurn(
        {
          jobId: input.jobId,
          sessionId,
          body,
          idempotencyKey: key,
          disposition: input.choice === 'start_over' ? 'restart' : 'fold',
          restartTarget: null,
          ...(input.choice === 'apply' ? { declinesPauseId: claimed.id } : {}),
          ...(input.choice === 'reply' || input.choice === 'resume'
            ? { answersPauseId: claimed.id }
            : {}),
          // The answer's kind (MOTIR-11700): the option picked, or — when the question
          // offered options and none was picked — the person's own words.
          ...(input.choice === 'reply'
            ? answerKindOf(claimed, readQuestionOption(claimed.replyOption))
            : {}),
        },
        pctx,
      );
      const entryId = await planChangeMailboxService.entryIdForKey(
        input.jobId,
        sessionId,
        key,
        pctx,
      );
      const updated = entryId
        ? await setDelivery(claimed.id, { mailboxEntryId: entryId }, pctx)
        : claimed;
      return { outcome: 'answered', pause: toPlanChangeRunPauseDto(updated), delivery };
    } catch (err) {
      if (err instanceof PlanChangeJobNotRunningError) {
        const updated = await setDelivery(
          claimed.id,
          { deliveryRefusedCode: 'PLAN_CHANGE_JOB_NOT_RUNNING' },
          pctx,
        );
        return {
          outcome: 'refused',
          code: err.code,
          jobStatus: err.status,
          choice: input.choice,
          ...(input.choice === 'reply' && text ? { text } : {}),
          pause: toPlanChangeRunPauseDto(updated),
        };
      }
      throw err;
    }
  },

  /** The newest pause of the session's CURRENT job, or null. */
  async latestForSession(
    sessionId: string,
    pctx: MailboxContext,
  ): Promise<PlanChangeRunPauseDto | null> {
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const session = await planChangeSessionRepository.findByIdInProject(
        sessionId,
        pctx.projectId,
        pctx.workspaceId,
        tx,
      );
      if (!session?.lastJobId) return null;
      const row = await planChangeRunPauseRepository.findLatestForSession(
        sessionId,
        session.lastJobId,
        pctx.workspaceId,
        tx,
      );
      if (!row) return null;
      // Whether the run has READ the answer's mailbox entry, so a reloaded rail can
      // say "planning resumed" without a live poll of its own.
      if (!row.mailboxEntryId) return toPlanChangeRunPauseDto(row);
      const [entry] = await planChangeMailboxRepository.findTurnsByIds(
        [row.mailboxEntryId],
        sessionId,
        row.jobId,
        pctx.workspaceId,
        tx,
      );
      return toPlanChangeRunPauseDto(row, entry ? entry.consumedAt !== null : false);
    });
  },
};

/** How a reply answered (MOTIR-11700): the option it picked, or its own words when
 *  the question offered options; nothing for a question that offered none. */
function answerKindOf(
  pause: PlanChangeRunPause,
  picked: QuestionOption | null,
): { answerOption: QuestionOption } | { answerOwnWords: true } | Record<string, never> {
  if (picked) return { answerOption: picked };
  return readQuestionOptions(pause.options) ? { answerOwnWords: true } : {};
}

async function setDelivery(
  id: string,
  data: { mailboxEntryId?: string; deliveryRefusedCode?: string },
  pctx: MailboxContext,
): Promise<PlanChangeRunPause> {
  return withWorkspaceContext(ctxOf(pctx), (tx) =>
    planChangeRunPauseRepository.setDelivery(id, data, tx),
  );
}

/** The mailbox body for an answer — only ever core's stored rows or the person's
 *  own reply, never the pause's `reason` / `question`. */
async function bodyFor(
  pause: PlanChangeRunPause,
  choice: PauseChoice,
  text: string | null,
  pctx: MailboxContext,
): Promise<string> {
  if (choice === 'reply') {
    if (!text) throw new EmptyPlanChangeTurnError();
    return text;
  }
  if (choice === 'resume') return PAUSE_RESUME_TEXT;
  const rows = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeMailboxRepository.findTurnsByIds(
      pause.changeTurnIds,
      pause.sessionId,
      pause.jobId,
      pctx.workspaceId,
      tx,
    ),
  );
  const bodies = rows.map((r) => r.body ?? '').filter((b) => b.length > 0);
  const joined = bodies.join('\n\n');
  return choice === 'apply' ? `${PAUSE_DECLINE_INSTRUCTION}\n\n${joined}` : joined;
}
