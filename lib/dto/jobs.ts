// DTO for the background-job run ledger (Story 1.6 · Subtask 1.6.2). What the
// operator dashboard (1.6.5) and any future API render — never the raw Prisma
// `JobRun` model. Dates cross the boundary as ISO strings.

export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';

/**
 * WHICH ENGINE ran a job (Bug MOTIR-3683). Declared by the writer on every
 * ledger row, so an audit never has to infer it from `eventId`'s format — an id
 * matching neither the engine's cuid nor Inngest's ULID used to be counted as
 * NEITHER lane, which made a whole class of row invisible to exactly the queries
 * the Inngest migration is verified with.
 */
export type JobRunLane = 'inngest' | 'engine';

/** A serialized failure captured when a job run ends in `failed`. */
export interface JobRunFailure {
  message: string;
  stack?: string;
  code?: string;
}

/**
 * What became of the MESSAGE an `email.send` run dispatched (Bug MOTIR-3507 ·
 * Subtask MOTIR-3517). Distinct from `JobRunStatus`, and the whole point of the
 * distinction: a run can be `succeeded` — the provider accepted the POST —
 * while its message bounced.
 *
 * ⚠️ `delivered` does NOT mean "in the inbox". A spam-foldered message is
 * delivered; the provider cannot see the recipient's folders.
 */
export type EmailDeliveryState = 'accepted' | 'delivered' | 'bounced' | 'complained' | 'delayed';

/** The delivery record joined onto a run, for the operator surface. */
export interface JobDeliveryDTO {
  state: EmailDeliveryState;
  /** The provider's own handle, so an operator can look the message up. */
  providerMessageId: string | null;
  recipient: string;
  template: string;
  /** When the provider last said something about it; null until an event lands. */
  lastEventAt: string | null;
}

export interface JobRunDTO {
  id: string;
  /** Null for untenanted system jobs (e.g. system.daily-health-check). */
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  eventId: string;
  /** Which engine ran it — recorded, never inferred from `eventId`'s shape. */
  lane: JobRunLane;
  attempt: number;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  failure: JobRunFailure | null;
  /** The handler's JSON-safe resolved value, recorded on success (5.2.7) — e.g. the attachment-GC's { scanned, deleted, failed } summary. */
  output: unknown;
  idempotencyKey: string | null;
  /**
   * The delivery record for this run's message, or null when there is none —
   * a job that is not `email.send`, a send that predates the record, or a send
   * the provider refused outright (whose `status` is already `failed`).
   */
  delivery: JobDeliveryDTO | null;
}

/**
 * A dead-lettered job (Story 1.6 · Subtask 1.6.4) — what the 1.6.5 dashboard's
 * DLQ tab renders and the "Replay" button acts on. Carries the original event
 * payload (`eventData`) so a replay can re-emit it. Dates cross as ISO strings.
 */
export interface JobRunDlqDTO {
  id: string;
  /** Null for untenanted system / cross-workspace jobs. */
  workspaceId: string | null;
  functionId: string;
  eventName: string;
  /** The original triggering event's full payload, for replay. */
  eventData: unknown;
  failure: JobRunFailure;
  /** Total attempts made before dead-lettering (including the first). */
  attempts: number;
  /** When the failing run started. */
  firstFailedAt: string;
  /** When the retry budget was exhausted. */
  lastFailedAt: string;
  /** When an operator replayed this entry, or null if not yet replayed. */
  replayedAt: string | null;
}

/** One page of the platform ledger's runs (MOTIR-9984). */
export interface PlatformRunsPageDTO {
  rows: JobRunDTO[];
  /** Another page follows this one. */
  hasMore: boolean;
}

/** One job function with dead letters still waiting, and how many. */
export interface PlatformDlqFunctionDTO {
  functionId: string;
  unreplayed: number;
}

/**
 * The platform ledger's dead letters (MOTIR-9984): every workspace's and none,
 * unreplayed first then those replayed in the last seven days, each half capped
 * per selection. The counts are TRUE counts, so they stay honest past the cap.
 */
export interface PlatformDlqListDTO {
  rows: JobRunDlqDTO[];
  /** Every function with at least one unreplayed dead letter, most first. */
  functions: PlatformDlqFunctionDTO[];
  /** Unreplayed dead letters across every function. */
  unreplayedTotal: number;
  /** Dead letters replayed in the last seven days, within the selection. */
  replayedRecently: number;
}

/** What a Replay all of one function did (MOTIR-9986). */
export interface ReplayAllResultDTO {
  functionId: string;
  /** Rows this run replayed — each has its own audit row. */
  replayed: number;
  /** Rows someone else replayed first; nothing was sent for them. */
  alreadyReplayed: number;
  /** Ids whose replay threw. They stay unreplayed unless the audit write was what failed. */
  failed: string[];
}
