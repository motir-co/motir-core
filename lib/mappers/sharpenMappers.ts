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

export function toSharpenSessionDto(
  row: SharpenSession,
  turns: readonly SharpenTurn[],
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
