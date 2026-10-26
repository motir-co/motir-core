/**
 * The day-1 system-health glance — design `platform-admin/design-notes.md`
 * **Panel 8** (MOTIR-1167).
 *
 * Seven read-only signals (six from MOTIR-1167, Gateway from MOTIR-742) and one
 * list, shaped so the UI renders them uniformly and the SERVICE owns every
 * judgement about what a signal means.
 *
 * ⚠️ THE THREE STATES ARE NOT A SEVERITY SCALE, and the third is the reason
 * this file exists. The asset's own argument:
 *
 * > an unreachable probe must never read as a zero. The Errors card says "No
 * > response from Sentry" and "this is **not** an error count of zero" in situ —
 * > a green card reading "0 errors" while the probe is down is the failure this
 * > panel exists to prevent.
 *
 * So `unreachable` is a distinct member from `healthy`, and no default anywhere
 * collapses it into one: a signal whose probe threw carries `unreachable` and a
 * null `value`, never a zero. Every place a number could be invented instead of
 * measured is a place this panel stops being worth having.
 */

/** One signal's verdict. */
export type PlatformSignalState = 'healthy' | 'degraded' | 'unreachable';

/** Which signal a card is — the key the UI resolves its copy and icon from. */
export type PlatformSignalId =
  | 'database'
  /**
   * The web deployment (MOTIR-1167, MOTIR-7332). `values` always carry the
   * process's own identity — `app`, `region`, `machineId` — once on a managed
   * host. On a read they add `<group>Started` / `<group>Expected` per process
   * group (`appStarted`, `appExpected`, `workerStarted`, `workerExpected`) and
   * `release` (the newest release a running machine carries). Degraded adds
   * `reason`: `shortGroup` with `group`, `started` and `expected` for the first
   * group short of its expectation, or `mixedReleases` with `count` (distinct
   * releases running). Unreachable: `reason` — `notManaged` (no values),
   * `noReadCredential` (identity only, no counts) or `readFailed` (no values).
   */
  | 'hosting'
  /**
   * motir-gateway (MOTIR-742). `values` when it answers: `ms` (latency),
   * `version`, `since` (ISO-8601, when the gateway process started) and
   * `threshold` (the slow bar in ms). Unreachable: `reason` — `notConfigured`
   * (no `MOTIR_GATEWAY_URL`), `noAnswer`, with `timeout` as a string (the probe's
   * deadline in seconds, a setting and not a measurement), or `badAnswer` (the gateway
   * answered and the answer was rejected, MOTIR-9641), with `why` — `httpStatus`,
   * `notJson`, `noSuccess`, `noData`, `noVersion` or `noStartTime` — and, on
   * `httpStatus`, `status` as a string.
   */
  | 'gateway'
  | 'schedules'
  | 'failedJobs'
  /**
   * Motir's own Sentry project (MOTIR-740). `values` on a read: `count` (errors
   * accepted over the window), `windowHours` (24) and `threshold` (the degraded
   * bar, inclusive). Unreachable: `reason` — `notConfigured`, `noReadCredential`
   * or `readFailed` — and no count.
   */
  | 'errors'
  | 'lastHealthCheck';

/**
 * One of the seven cards.
 *
 * `value` and `detail` are DATA the UI interpolates into its own localized copy
 * — never a rendered English sentence. The asset's copy strings are template
 * literals (`"{n} of {total} crons overdue"`), so the numbers cross the boundary
 * as numbers and the words live in `messages/*.json`.
 */
export interface PlatformSignalDTO {
  id: PlatformSignalId;
  state: PlatformSignalState;
  /**
   * The interpolation values for this signal's headline and its body, keyed by
   * the placeholder names the `admin` namespace uses. Empty when the probe could
   * not answer — which is what keeps an unreachable card from rendering a zero.
   */
  values: Record<string, string | number>;
  /**
   * Where the card's "link OUT to the provider's own dashboard" goes, or `null`
   * when this deployment has no such destination configured.
   *
   * ⚠️ Nullable ON PURPOSE. Motir is self-hostable, and a self-hosted instance
   * has no Fly app and no Neon project; a hard-coded URL there would send an
   * operator to somebody else's console. The label is the UI's; the target is
   * the deployment's.
   */
  linkOut: string | null;
}

/** One overdue cron, as the glance's single list renders it. */
export interface PlatformOverdueScheduleDTO {
  /** The job's function id, e.g. `system.daily-health-check`. */
  functionId: string;
  cron: string;
  /** ISO-8601, or null when the ledger has never seen this job run. */
  lastRunAt: string | null;
  /** ISO-8601 — the tick it was judged against. */
  expectedAt: string | null;
}

/** The whole glance. */
export interface PlatformHealthDTO {
  /** ISO-8601 — when these signals were read. The panel refreshes on load. */
  checkedAt: string;
  signals: PlatformSignalDTO[];
  /**
   * The crons that have missed more than one consecutive tick, newest miss
   * first. Capped by the service; `overdueTotal` is the true count so the
   * pager's "Showing {n} of {total}" cannot lie about what was elided.
   */
  overdue: PlatformOverdueScheduleDTO[];
  overdueTotal: number;
  /** How many schedules were checked — the foot's "{checked} schedules checked". */
  schedulesChecked: number;
}

/**
 * THE QUEUE BACKLOG READING (Subtask MOTIR-3764) — a MACHINE surface, and
 * deliberately not one of the six cards above.
 *
 * ⚠️ WHY IT IS ITS OWN SHAPE RATHER THAN A SEVENTH `PlatformSignalDTO`. The six
 * are cards on a staff-gated page, and this reading exists precisely for the
 * moment that page cannot be reached: on 2026-08-28 the queue stopped being
 * claimed and the only thing that noticed was a person wondering why six work
 * items had not moved. A signal that can only be read by signing in to the app
 * re-creates the defect one layer up. So this crosses the boundary on its own,
 * through an unauthenticated route an external monitor polls, carrying two
 * numbers and no tenant data at all.
 *
 * (`design/platform-admin/design-notes.md` Panel 8 draws SIX signal cards and
 * says "Six signals" in its own subtitle. Adding a seventh would be a design
 * change, and it would be the weaker half of this card besides — so the board is
 * untouched and the reading ships as a route.)
 */
/**
 * THE STANDING DEAD-LETTER READING (MOTIR-5840) — depth, not arrivals.
 *
 * ⚠️ WHY IT IS SEPARATE FROM THE `failedJobs` SIGNAL RATHER THAN THE SAME NUMBER.
 * That card answers *how many jobs died recently?* over a 24-hour window, which
 * is a RATE. This answers *how many dead jobs has nobody dealt with?*, which is a
 * DEPTH — and the two come apart exactly when it matters. Production stood at
 * 1,381 unreplayed rows whose newest was four days old, so the windowed card read
 * `0 dead-lettered · 24h` in green while the whole backlog sat behind it. A
 * window cannot report a backlog; that is not a tuning problem, it is the wrong
 * question.
 *
 * ⚠️ AND IT DOES NOT TOUCH `PlatformQueueHealthDTO.state`. That field means *is
 * the queue draining* — the page-somebody-now verdict the HTTP status carries —
 * and an untriaged backlog is a different urgency with a different remedy. Fold
 * the two together and a 503 stops saying which one happened, and this endpoint
 * would sit at 503 for as long as the backlog takes to triage, which is how a
 * monitor gets muted.
 */
export interface PlatformDeadLetterReadingDTO {
  /**
   * `healthy` while standing depth is under the threshold; `backlogged` at or
   * above it; `unreadable` when the probe could not answer.
   *
   * ⚠️ `unreadable` is a MEMBER, for the same reason `PlatformSignalState` has
   * one: a probe that threw must never be rendered as a zero. A measured empty
   * dead-letter set is `healthy` with `unreplayed: 0` and is good news.
   */
  state: 'healthy' | 'backlogged' | 'unreadable';
  /**
   * Unreplayed dead letters across EVERY workspace, with no time bound —
   * untenanted `system.*` rows included.
   *
   * `null` when and ONLY when `state` is `unreadable`. There is no `?? 0` on this
   * field and there must never be one.
   */
  unreplayed: number | null;
  /** The depth `state` was judged against, so a reader never has to guess what "backlogged" meant. */
  threshold: number;
}

export interface PlatformQueueHealthDTO {
  /** `healthy` while the queue is moving; `stalled` once the oldest DUE run has waited past the threshold. */
  state: 'healthy' | 'stalled';
  /** How many runs are claimable right now. CONTEXT, never the verdict — a deep queue that is draining is healthy. */
  depth: number;
  /**
   * How long the oldest claimable run has been waiting, in ms — THE verdict's
   * input. `null` when nothing is due, which is a measured empty queue and not
   * an unread probe.
   */
  oldestPendingAgeMs: number | null;
  /** The threshold `state` was judged against, so a reader never has to guess what "stalled" meant. */
  stallThresholdMs: number;
  /** ISO-8601 — when this reading was taken. */
  checkedAt: string;
  /**
   * The standing dead-letter backlog, beside the queue reading and independent of
   * it — see `PlatformDeadLetterReadingDTO`. Carried here because this route is
   * the surface an external monitor actually POLLS: the platform-health board is
   * staff-gated, so a signal that only lands there still waits for somebody to
   * decide to look, which is the decision nobody makes on a quiet day.
   */
  deadLetters: PlatformDeadLetterReadingDTO;
}
