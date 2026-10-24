import type {
  SettledAnswer,
  SharpenAction,
  SharpenAssumption,
  SharpenQuestion,
} from '@/lib/ai/types';

// The Sharpen session as it crosses the API (Task MOTIR-1101 · Subtask
// MOTIR-8181) — what `/api/ai/sharpen*` returns and the Sharpen UI renders. It is
// the server's STORED state, so a reload resumes exactly where the person was.

/** One turn of the transcript. */
export interface SharpenTurnDto {
  id: string;
  seq: number;
  role: 'person' | 'planner';
  /** The person's action; null on a planner turn. */
  action: SharpenAction | null;
  body: string;
  readingId: string | null;
  jobId: string | null;
  /** A planner turn that records a FAILED job — the person turn can be re-run. */
  failed: boolean;
  createdAt: string;
}

/** What a Sharpen session is about. */
export interface SharpenScopeDto {
  kind: 'plan' | 'conversation';
  planId?: string;
  conversationId?: string;
}

export interface SharpenSessionDto {
  id: string;
  scope: SharpenScopeDto;
  status: 'open' | 'ended';
  endReason: 'nothing_to_ask' | 'finished' | 'stopped' | null;
  /** The question waiting on the person, or null. */
  pendingQuestion: SharpenQuestion | null;
  settled: SettledAnswer[];
  assumptions: SharpenAssumption[];
  /** What motir-ai reported about writing the answers back; null before an end. */
  writeBack: { ok: boolean; error?: string } | null;
  /** The person turn whose job has not settled yet, or null. */
  inFlight: { turnId: string; jobId: string | null } | null;
  turns: SharpenTurnDto[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

/** What opening, acting and resubmitting answer. `jobId` / `turnId` are null
 *  only on a resume, which sends nothing. */
export interface SharpenDoorResult {
  outcome: 'sharpening' | 'resumed';
  jobId: string | null;
  turnId: string | null;
  session: SharpenSessionDto;
}

/** What a person's grilling on a conversation settled (MOTIR-9314) — their latest
 *  session there, open or ended. Read by the plan submit to carry the answers
 *  into the run. */
export interface SharpenConversationSettledDto {
  sessionId: string;
  status: 'open' | 'ended';
  endReason: 'nothing_to_ask' | 'finished' | 'stopped' | null;
  settled: SettledAnswer[];
  assumptions: SharpenAssumption[];
  /** The conversation's person turns the grilling was given: every one written
   *  before its latest turn. A turn written after is a later request. */
  requests: string[];
}

/** What settling a job answers. */
export interface SharpenSettleResult {
  outcome: 'pending' | 'settled' | 'failed';
  session: SharpenSessionDto;
}
