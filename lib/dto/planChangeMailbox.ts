// THE BOUNDARY MAILBOX's wire shape (Story MOTIR-4054 · MOTIR-4067).
//
// ⚠️ THIS IS A TWO-REPO CONTRACT AND THE CONSUMER LANDED FIRST. `motir-ai`
// `src/llm/mailbox.ts` (MOTIR-4060, merged) already accepts exactly this shape
// and parses it TOTALLY — an unreadable body, a 404, a `motir-core` that
// predates the contract all read as an empty mailbox rather than failing a
// planning run. So these types MATCH what that side accepts; they do not
// propose a second shape for it to be reconciled with later.
//
// The field names are therefore not ours to choose freely. Each one below names
// the property `readDelivery` reads, and a rename here is a silent no-op there:
// an entry whose `id` or `text` it cannot read is DROPPED, not rejected. That is
// the right behaviour for a producer that has not shipped yet and the wrong
// failure to discover at a planning run, which is why the cross-repo fixture in
// `tests/integration/planning/planChangeMailbox.test.ts` holds the consumer's
// own reading of this shape rather than a round-trip through our own types.

/** What the run should DO with one turn. Mirrors `MailboxDisposition`. */
export type MailboxDispositionDto = 'fold' | 'restart';

/** One turn the user typed while the run was in flight. Mirrors `MailboxTurn`. */
export interface MailboxTurnDto {
  /**
   * The delivery's own id — and the consumer's IDEMPOTENCY KEY. Its boundary
   * check records the ids it has consumed and skips them, so this must be
   * stable for the life of the entry. It is the row's `id`.
   */
  id: string;
  /** What the user typed, verbatim. */
  text: string;
  /**
   * When motir-core accepted it, ISO-8601.
   *
   * ⚠️ IT IS NOT THE ORDERING, AND THE ARRAY IS. `readDelivery` sorts on this
   * and breaks ties on ARRAY INDEX — so two turns written inside the same
   * millisecond are ordered by the array, which we build from `seq`. Sending
   * this field is what makes the sort stable; relying on it alone is what the
   * card's ordering criterion forbids.
   */
  receivedAt: string;
  /** `fold` (carry on) or `restart` (withdraw and re-plan). */
  disposition: MailboxDispositionDto;
  /**
   * Where a `restart` RE-ANCHORS the walk — a work-item identifier, or `null`
   * for the target the run is already on. Always present rather than omitted:
   * the consumer distinguishes an ABSENT `target` (keep the current one) from an
   * explicit `null` (also keep it), so sending null costs nothing and sending
   * the key unconditionally keeps the shape total.
   */
  target: string | null;
  /**
   * Present ONLY on the `fold` turn that DECLINES the planner's START OVER offer
   * (MOTIR-8007): the run pause's id. Absent on every other turn.
   */
  declinesPause?: string;
  /**
   * Present ONLY on the `fold` turn that ANSWERS the planner's mid-run question
   * (MOTIR-8007): the run pause's id. Absent on every other turn.
   */
  answersQuestion?: string;
}

/** What ONE boundary check found. Mirrors `MailboxDelivery`. */
export interface MailboxDeliveryDto {
  /** The turns waiting, in the order they were typed. */
  turns: MailboxTurnDto[];
  /**
   * The user ENDED the run.
   *
   * ⚠️ Derived from a `stop` entry EXISTING, never from one being unconsumed —
   * a run that has been ended stays ended, so every boundary after the first
   * still reads `true`. The consumer reads this branch FIRST, because a delivery
   * carrying both a turn and a stop is a user who said something and then ended
   * the run, and the ending is the later fact.
   */
  stopped: boolean;
  /**
   * A person asked to SKIP the plan's final check (MOTIR-11266): end the check
   * now, fix nothing it found, and propose the plan. It ends only the check,
   * never the plan.
   *
   * ⚠️ Derived from a `skip_final_check` entry EXISTING, as `stopped` is, so every
   * read after the first still says it. Always sent; a motir-ai that predates the
   * field ignores it (its parse is total), and the check then runs to its end.
   */
  skipFinalCheck: boolean;
}

/**
 * What the skip door answers (MOTIR-11266): `skipped` when the entry is written
 * (or was already, under the same key), `not_running` when the plan's final check
 * is not running, so there was nothing to skip and nothing was written. Either
 * way the mailbox as it now stands.
 */
export interface SkipFinalCheckResultDto {
  outcome: 'skipped' | 'not_running';
  mailbox: MailboxDeliveryDto;
}
