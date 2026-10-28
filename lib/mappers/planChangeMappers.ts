import type {
  PlanChangeRunPause,
  PlanChangeSession,
  PlanChangeTurn,
} from '@/generated/prisma/client';
import type {
  AnswerOfferKindDto,
  DebugLandingDto,
  LogBugOfferDto,
  PlanAnswerOfferDto,
  PlanChangeRunPauseDto,
  PlanChangeSessionDto,
  PlanChangeTurnConfirmDto,
  PlanChangeTurnOutageDto,
  PlanChangeTurnDto,
  PlanChangeTurnIntentDto,
  PlanChangeTurnRoleDto,
  PlanSessionAwaitingPersonDto,
  PlanSessionFailureDto,
} from '@/lib/dto/planChange';
import { isAwaitingPerson, isFailedWaiting } from '@/lib/planChange/sessionWaitingState';
import { InvalidAuthoredBugError, parseAuthoredBug, type AuthoredBug } from '@/lib/ai/authoredBug';
import { LOG_BUG_TARGET_KINDS, type LogBugTargetKind } from '@/lib/ai/logBugOffer';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { readGuideTurnRecord } from '@/lib/ai/guideWorkItem';
import { narrowSharpenedRequirement } from '@/lib/sharpening/requirement';
import { parseCodeUnsearchableRepos } from '@/lib/planning/codeUnsearchable';

// Prisma rows → API DTOs for the plan-change conversation (Story 7.30 ·
// MOTIR-1728). The single place the persisted enum narrows to its string union
// and Dates become ISO strings, so no Prisma row leaks past the service boundary
// (the 4-layer rule). `workspaceId` is deliberately NOT carried across the
// boundary — the client never needs the tenant id, and omitting it keeps the
// tenancy an entirely server-side concern.

const DEBUG_OUTCOMES: ReadonlySet<string> = new Set(['enrich_existing', 'diagnose', 'ungrounded']);

/**
 * The persisted `debug_landing` JSON → its DTO (MOTIR-7064). The column is
 * written only by `debugLandingService` from a `DebugLandingDto`, so this is a
 * NARROWING, not a repair: anything that is not that shape reads as null — the
 * turn then renders as the ordinary answer it would have been — rather than as
 * an outcome line built from a guess.
 */
function toDebugLandingDto(value: unknown): DebugLandingDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== 'string' || !DEBUG_OUTCOMES.has(v.outcome)) return null;
  return {
    outcome: v.outcome as DebugLandingDto['outcome'],
    workItemKey: typeof v.workItemKey === 'string' ? v.workItemKey : null,
    title: typeof v.title === 'string' ? v.title : null,
    createdInTriage: v.createdInTriage === true,
  };
}

const ANSWER_OFFER_KINDS: ReadonlySet<string> = new Set<AnswerOfferKindDto>(['plan', 'log_bug']);

/** The stored bug of a `log_bug` offer → its DTO (MOTIR-9322), or null when any field
 *  is the wrong shape. The draft is re-read through `parseAuthoredBug`: a stored row
 *  is as untrusted as the wire it came from once a later build reads it. */
function toLogBugOfferDto(value: unknown): LogBugOfferDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const target = v.target as Record<string, unknown> | null | undefined;
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((e) => typeof e === 'string');
  if (
    typeof v.title !== 'string' ||
    !strings(v.acceptanceCriteria) ||
    !strings(v.contextRefs) ||
    !target ||
    typeof target !== 'object' ||
    !(LOG_BUG_TARGET_KINDS as readonly unknown[]).includes(target.kind)
  ) {
    return null;
  }
  const key = nullableString(target.key);
  const title = nullableString(target.title);
  const targetUpdatedAt = nullableString(v.targetUpdatedAt);
  if (key === undefined || title === undefined || targetUpdatedAt === undefined) return null;
  let draft: AuthoredBug;
  try {
    draft = parseAuthoredBug(v.draft);
  } catch (err) {
    if (err instanceof InvalidAuthoredBugError) return null;
    throw err;
  }
  return {
    title: v.title,
    acceptanceCriteria: v.acceptanceCriteria,
    draft,
    target: { kind: target.kind as LogBugTargetKind, key, title },
    targetUpdatedAt,
    contextRefs: v.contextRefs,
  };
}

/** The saved requirement page an offer records (MOTIR-9436): an id and a title, both
 *  non-empty strings, or nothing. */
function toRequirementPageRef(value: unknown): { pageId: string; title: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { pageId, title } = value as Record<string, unknown>;
  return typeof pageId === 'string' && pageId && typeof title === 'string' && title
    ? { pageId, title }
    : undefined;
}

/** A string, or null; `undefined` when the value is neither — the wrong type. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The persisted `answer_offer` JSON → its DTO (MOTIR-9288), on the model of
 * `readReplanOffer` in `lib/ai/guideWorkItem.ts`. A NARROWING, not a repair: the
 * whole offer reads as null when any field is the wrong type, and a `kind` outside
 * the union reads as NO offer — never as a `plan` one, which would put a working
 * Confirm under the wrong action's words.
 */
function toAnswerOfferDto(value: unknown): PlanAnswerOfferDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !ANSWER_OFFER_KINDS.has(v.kind)) return null;
  if (typeof v.requestMd !== 'string' || v.requestMd.trim().length === 0) return null;
  const fields = {
    targetKey: nullableString(v.targetKey),
    declinedAt: nullableString(v.declinedAt),
    declinedById: nullableString(v.declinedById),
    confirmedAt: nullableString(v.confirmedAt),
    confirmedById: nullableString(v.confirmedById),
    confirmedSessionId: nullableString(v.confirmedSessionId),
  };
  if (Object.values(fields).some((f) => f === undefined)) return null;
  // A `log_bug` offer is only as good as its bug: one that does not read is no offer.
  const bug = v.kind === 'log_bug' ? toLogBugOfferDto(v.bug) : null;
  if (v.kind === 'log_bug' && !bug) return null;
  // The composed requirement (MOTIR-9432) rides a `plan` offer — with no target, or
  // with one whose description does not state the WHAT (MOTIR-9878). One that does not
  // read is dropped; the offer itself still reads.
  const plan = v.kind === 'plan';
  const requirement = plan ? narrowSharpenedRequirement(v.requirement) : undefined;
  // The saved page and the failed-save flag (MOTIR-9436) ride the same offers, each
  // dropped alone when it does not read.
  const requirementPage = plan ? toRequirementPageRef(v.requirementPage) : undefined;
  return {
    kind: v.kind as AnswerOfferKindDto,
    requestMd: v.requestMd,
    ...(fields as { [K in keyof typeof fields]: string | null }),
    ...(requirement ? { requirement } : {}),
    ...(requirementPage ? { requirementPage } : {}),
    ...(plan && v.requirementSaveFailed === true ? { requirementSaveFailed: true as const } : {}),
    ...(bug ? { bug } : {}),
  };
}

/** A run pause row → its DTO (MOTIR-8007). The delivery state is derived: an answer
 *  with a mailbox entry is `delivered`, one with a refusal code is `refused`, anything
 *  else (open, or claimed and not yet delivered) is `pending`. */
export function toPlanChangeRunPauseDto(
  row: PlanChangeRunPause,
  entryRead?: boolean,
): PlanChangeRunPauseDto {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind as PlanChangeRunPauseDto['kind'],
    changeTurnIds: row.changeTurnIds,
    reason: row.reason,
    question: row.question,
    repos: parseCodeUnsearchableRepos(row.unsearchableRepos),
    createdAt: row.createdAt.toISOString(),
    answer: row.answer as PlanChangeRunPauseDto['answer'],
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    replyText: row.answer === 'replied' ? row.replyText : null,
    delivery: row.mailboxEntryId ? 'delivered' : row.deliveryRefusedCode ? 'refused' : 'pending',
    refusedCode: row.deliveryRefusedCode,
    mailboxEntryId: row.mailboxEntryId,
    ...(entryRead === undefined ? {} : { entryRead }),
  };
}

export function toPlanChangeTurnDto(row: PlanChangeTurn): PlanChangeTurnDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as PlanChangeTurnRoleDto,
    body: row.body,
    jobId: row.jobId,
    question: row.question,
    isAnswer: row.isAnswer,
    intent: (row.intent as PlanChangeTurnIntentDto | null) ?? null,
    intentCorrected: row.intentCorrected,
    citations: row.citations,
    anchorKey: row.anchorKey,
    debugLanding: toDebugLandingDto(row.debugLanding),
    guide: readGuideTurnRecord(row.guideTurn),
    attachmentIds: row.attachmentIds,
    confirm: (row.confirm as PlanChangeTurnConfirmDto | null) ?? null,
    codeUnreadable: (row.codeUnreadable as PlanChangeTurnOutageDto | null) ?? null,
    codeUnsearchable: parseCodeUnsearchableRepos(row.codeUnsearchable),
    runJobId: row.runJobId,
    forwardOffer: row.forwardOffer,
    offer: toAnswerOfferDto(row.answerOffer),
    forwarded: row.forwardedEntryId ? { mailboxEntryId: row.forwardedEntryId } : null,
    revisedLate: row.revisedLateJobId ? { revisionJobId: row.revisedLateJobId } : null,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The failure a session is waiting to resume from, or null (MOTIR-7908). Keyed on
 * the shared predicate, so an ENDED row reads null even if its columns were left set
 * — the same rule every other reader of the waiting state applies. `failedJobId` and
 * `failureDetail` are deliberately not mapped: they are server-side only.
 */
function toPlanSessionFailureDto(row: PlanChangeSession): PlanSessionFailureDto | null {
  if (!isFailedWaiting(row) || row.failedAt === null || row.failureReason === null) return null;
  return {
    failedAt: row.failedAt.toISOString(),
    reason: row.failureReason,
    stopPhase: row.failureStopPhase ?? null,
    stopRef: row.failureStopRef ?? null,
    stopTitle: row.failureStopTitle ?? null,
  };
}

function toPlanSessionAwaitingPersonDto(
  row: PlanChangeSession,
): PlanSessionAwaitingPersonDto | null {
  if (
    !isAwaitingPerson(row) ||
    row.awaitingPersonSince === null ||
    row.awaitingPersonCause === null
  ) {
    return null;
  }
  return { since: row.awaitingPersonSince.toISOString(), cause: row.awaitingPersonCause };
}

/** The session plus its FULL ordered thread — the resume payload. `turns` MUST
 *  already be in `seq` order (the repository read orders them); the mapper does
 *  not re-sort, so a caller passing an unordered list gets an unordered DTO. */
export function toPlanChangeSessionDto(
  row: PlanChangeSession,
  turns: PlanChangeTurn[],
  workItemRefs: WorkItemRefMap = {},
  runPause: PlanChangeRunPause | null = null,
  runPauseEntryRead?: boolean,
): PlanChangeSessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    // The anchor set crosses the boundary; the derived `scopeKey` it is stored
    // under does not (the client never needs the discriminator, only the items).
    targetKeys: row.targetKeys,
    turnCount: row.turnCount,
    lastJobId: row.lastJobId,
    lastSubmittedAt: row.lastSubmittedAt ? row.lastSubmittedAt.toISOString() : null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    origin: row.origin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    turns: turns.map(toPlanChangeTurnDto),
    workItemRefs,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endReason: row.endReason ?? null,
    copiedFromSessionId: row.copiedFromSessionId ?? null,
    failure: toPlanSessionFailureDto(row),
    awaitingPerson: toPlanSessionAwaitingPersonDto(row),
    runPause: runPause ? toPlanChangeRunPauseDto(runPause, runPauseEntryRead) : null,
  };
}
