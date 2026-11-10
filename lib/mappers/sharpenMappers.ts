import type { ConversationNoteDto } from '@/lib/dto/conversationNote';
import type { SharpenSession, SharpenTurn } from '@/generated/prisma/client';
import type {
  CarriedAnswers,
  SettledAnswer,
  SharpenAssumption,
  SharpenQuestion,
} from '@/lib/ai/types';
import type {
  SharpenConversationSettledDto,
  SharpenSessionDto,
  SharpenTurnDto,
} from '@/lib/dto/sharpen';

// Sharpen session rows → DTO (Task MOTIR-1101 · Subtask MOTIR-8181). The store's
// JSON columns are opaque to the repository; this is where they are typed. Every
// value in them was written by `aiSharpenService` from a `parseSharpenTurn`
// result, so the shapes are the parsed ones.

/** The record a planner turn stores when its job failed. */
export interface SharpenFailedRecord {
  failed: true;
  reason: string;
}

/** A failed record's `reason` when the job stopped because the org ran out of
 *  credits (MOTIR-10235) — the one failure the person is told about by name. */
export const SHARPEN_OUT_OF_CREDITS_REASON = 'out_of_credits';

export function isFailedRecord(record: unknown): record is SharpenFailedRecord {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { failed?: unknown }).failed === true
  );
}

export function toSharpenTurnDto(row: SharpenTurn): SharpenTurnDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    action: row.action,
    body: row.body,
    readingId: row.readingId,
    jobId: row.jobId,
    failed: row.role === 'planner' && isFailedRecord(row.record),
    outOfCredits:
      row.role === 'planner' &&
      isFailedRecord(row.record) &&
      row.record.reason === SHARPEN_OUT_OF_CREDITS_REASON,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The person turn whose job has not produced a planner turn yet. Only the
 *  LATEST person turn can be in flight; an earlier one was answered or failed. */
export function inFlightTurn(turns: readonly SharpenTurn[]): SharpenTurn | null {
  const latest = [...turns].reverse().find((t) => t.role === 'person');
  if (!latest) return null;
  if (latest.jobId === null) return latest;
  const answered = turns.some((t) => t.role === 'planner' && t.jobId === latest.jobId);
  return answered ? null : latest;
}

/** True when the person has already acted on the question the last planner turn
 *  asked: a person turn follows the latest planner turn that did not fail. The
 *  stored `pendingQuestion` outlives that act until the next planner turn lands,
 *  so a failed read leaves it set on a question that is answered (MOTIR-10865).
 *  The client's `openQuestion` reads the same rule off the DTO. */
export function questionActedOn(turns: readonly SharpenTurn[]): boolean {
  let asked = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role === 'planner' && !isFailedRecord(t.record)) {
      asked = i;
      break;
    }
  }
  if (asked < 0) return false;
  return turns.slice(asked + 1).some((t) => t.role === 'person');
}

export function toSharpenSessionDto(
  row: SharpenSession,
  turns: readonly SharpenTurn[],
  notes: readonly ConversationNoteDto[] = [],
): SharpenSessionDto {
  const inFlight = inFlightTurn(turns);
  return {
    id: row.id,
    scope:
      row.scopeKind === 'plan'
        ? { kind: 'plan', planId: row.planId ?? undefined }
        : { kind: 'conversation', conversationId: row.planChangeSessionId ?? undefined },
    status: row.status,
    endReason: row.endReason,
    pendingQuestion: (row.pendingQuestion as SharpenQuestion | null) ?? null,
    settled: (row.settled as unknown as SettledAnswer[]) ?? [],
    assumptions: (row.assumptions as unknown as SharpenAssumption[]) ?? [],
    writeBack: (row.writeBack as SharpenSessionDto['writeBack']) ?? null,
    inFlight: inFlight ? { turnId: inFlight.id, jobId: inFlight.jobId } : null,
    turns: turns.map(toSharpenTurnDto),
    notes: [...notes],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

/** The most carried answers (and, separately, assumptions) motir-ai reads. */
const CARRIED_ENTRIES_MAX = 50;

/**
 * A conversation's settled set as the CARRIED ANSWERS a planning run reads
 * (MOTIR-9315), or `undefined` when there is nothing to carry: no grilling, one
 * that settled nothing, or no person turn it was given for.
 */
export function toCarriedAnswers(
  settled: SharpenConversationSettledDto | null,
): CarriedAnswers | undefined {
  if (!settled || settled.requests.length === 0) return undefined;
  if (settled.settled.length === 0 && settled.assumptions.length === 0) return undefined;
  return {
    requests: settled.requests,
    settled: settled.settled.slice(0, CARRIED_ENTRIES_MAX).map((s) => ({
      questionId: s.questionId,
      question: s.question,
      answer: s.answer,
      topic: s.topic,
      readingId: s.readingId,
    })),
    assumptions: settled.assumptions.slice(0, CARRIED_ENTRIES_MAX).map((a) => ({
      questionId: a.questionId,
      question: a.question,
      recommendation: a.recommendation,
      why: a.why,
    })),
  };
}
