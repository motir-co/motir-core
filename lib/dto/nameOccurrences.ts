// The DTOs the MCP `record_name_occurrences` / `lookup_name_occurrences` tools return
// (MOTIR-11647 · story MOTIR-11497). They reach the organisation-wide record of where
// code names occur — the record the hosted planner writes and asks — through motir-ai's
// `POST /v1/code-graph/name-occurrences/record` and `/lookup`.
//
// ⚠️ ONE SHAPE ON EVERY PATH. A degraded answer (motir-ai unreachable, unconfigured, a
// non-2xx, or motir-ai's own degraded 200) keeps the shape: `names` is still one entry
// per asked name in request order, each with an empty list, and `recorded` is 0 — and
// `note` / `reason` say why. A caller (plan.py's check) reads `names` / `recorded` and
// never a discriminator, so "we could not ask" can never become "no name was found"
// by a missing field; it reads as an all-miss WITH a note.

/** One place a name occurs at the answer's commit. Lines are 1-based and inclusive. */
export interface NameOccurrenceAtDTO {
  path: string;
  startLine: number;
  endLine: number;
  blob: string;
}

/** One asked name and where it occurs; an empty list is a miss. */
export interface NameOccurrenceAnswer {
  name: string;
  occurrences: NameOccurrenceAtDTO[];
}

/**
 * Why an answer is degraded: `ai_not_configured` / `ai_unreachable` / `ai_error` when
 * the forward to motir-ai failed, `record_unanswered` when motir-ai answered with its
 * own state sentence (the record never answered: unmapped, not indexed, the service down).
 */
export type NameOccurrenceReason =
  | 'ai_not_configured'
  | 'ai_unreachable'
  | 'ai_error'
  | 'record_unanswered';

export interface NameOccurrenceLookupDTO {
  /** The commit the answer was computed at; `null` when nothing was answered. */
  commit: string | null;
  /** Exactly one entry per asked name, in the order asked. */
  names: NameOccurrenceAnswer[];
  /** One sentence naming the state met, when degraded; `null` on an answer. */
  note: string | null;
  reason: NameOccurrenceReason | null;
}

export interface NameOccurrenceRecordDTO {
  /** The occurrence rows the record reports it inserted (a repeat inserts none). */
  recorded: number;
  note: string | null;
  reason: NameOccurrenceReason | null;
}

/** One occurrence to record: a name in a git blob, at a 1-based inclusive line range. */
export interface NameOccurrenceInput {
  blob: string;
  name: string;
  startLine: number;
  endLine: number;
}
