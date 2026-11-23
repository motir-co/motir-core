import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunOrigin,
  DispatchRunReporter,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';

// The DISPATCH RUN DTOs (Story MOTIR-1789 · MOTIR-1792), the shape
// `docs/decisions/dispatch-run-record.md` decides.
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — never re-declared. A
// second copy of a closed enum is a second thing to keep total: the day the ADR
// grows a member, a hand-written union here would silently stop being able to
// carry it while every renderer downstream kept compiling. Aliasing means adding
// a member to the schema is a type error at every non-total `switch` in the
// tree, which is the whole reason the ADR made them closed.
//
// ⚠️ AND THERE IS NO PULL REQUEST, NO CI VERDICT, NO WORK-ITEM STATUS AND NO
// COST ON ANY SHAPE HERE (ADR Q3). The run says what the run DID; the read side
// JOINS the delivery set for what shipped. A field added here would be the first
// place the two could disagree, because a DTO is where a surface stops asking
// and starts rendering.

export type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
};

/** One LEG — one card this run owns, at its place in the run's own order. */
export interface DispatchRunCardDto {
  id: string;
  /**
   * The card's `MOTIR-<n>` key.
   *
   * ⚠️ NEVER NULL, even when the work item has been deleted: it is stored on the
   * leg precisely so a run's history stays readable after its subjects are gone.
   * `workItemId` is the one that goes null.
   */
  key: string | null;
  /** Null once the card has been deleted — the leg survives it. */
  workItemId: string | null;
  /** The run's OWN order. Never re-derive it from a dependency graph. */
  position: number;
  disposition: DispatchCardDisposition;
  /** Non-null exactly when `disposition === 'skipped'`. */
  skipReason: DispatchSkipReason | null;
  sessionBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  /**
   * The agent's SELF-REPORTED model for this leg (MOTIR-7502), null when it
   * reported none — never inferred. Readers take the leg's model, else the run's.
   */
  model: string | null;
  /**
   * A `needs_human` leg's `manual_work` gate (Story MOTIR-7460 · MOTIR-7477), so
   * the leg can say WHO it waits on rather than *needs a human*. Filled only by
   * the BROWSER's reads (the run detail and a card's run history); absent on the
   * v1 contract and the ingest answers, and `null` on a leg with no live gate —
   * no gate at all, a withdrawn one, or any leg that is not a manual skip. Both
   * read as *Skipped — manual work.*
   */
  manualGate?: DispatchRunLegGateDto | null;
}

/**
 * A manual leg's gate as the run surfaces name it (`design/runs/design-notes.md`
 * § _Waiting on you_). Resolved per READER on the server, because *you* is the
 * person reading the page — never the run's starter.
 */
export interface DispatchRunLegGateDto {
  /** `awaiting` — still owed; `approved` — somebody pressed Mark done. */
  state: 'awaiting' | 'approved';
  /**
   * `awaiting`: the routed person's display name (the card's assignee, else its
   * reporter, read off the live card as Waiting on you lists it). `approved`: who
   * marked it done. Null when that person no longer resolves.
   */
  name: string | null;
  /** `awaiting` only: the gate is routed to the reader of this DTO. */
  routedToReader: boolean;
}

/**
 * A run's `needs_human` legs whose gate is still AWAITING, split by whether it
 * waits on the reader (MOTIR-7477) — the summary's *{n} waiting on you* and
 * *{n} waiting on others* segments. Both are INSIDE `legs.skipped`.
 */
export interface DispatchRunWaitingCountsDto {
  you: number;
  others: number;
}

/** One entry in the ordered stream. */
export interface DispatchRunEventDto {
  id: string;
  /** Monotonic per RUN, and the stream's resume cursor. Never order by time. */
  seq: number;
  kind: DispatchEventKind;
  /** The leg this event belongs to, or null for a RUN-scoped event. */
  cardId: string | null;
  /** Structured detail. Never a log body. */
  data: unknown;
  /**
   * The opt-in log body (ADR Q4), or null.
   *
   * Null means one of three things and the surface must not guess between them:
   * the event carries no body, the run was not started with `--report-log`, or
   * the 30-day retention window has passed and the sweep cleared it.
   */
  body: string | null;
  /**
   * Who wrote this event (MOTIR-7450, `agent-reported-runs.md` §3) — `agent` for a
   * step or milestone the agent reported through `report_action`, `cli` for every
   * other writer.
   */
  reportedBy: DispatchRunReporter;
  createdAt: string;
}

/** The agent a run executed in (MOTIR-7023) — its name and its coding agent. */
export interface DispatchRunAgentInstanceDto {
  id: string;
  /** The agent's own name (`yue-claude`). */
  name: string;
  /** The sandbox profile id (`claude`, `codex`, …) — the coding agent. */
  profile: string;
  /** The profile's display name (`Claude Code`), or the raw id for an unknown one. */
  profileLabel: string;
}

/** The run HEADER plus its SET — what `/runs/[id]` renders. */
export interface DispatchRunDto {
  id: string;
  projectId: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  /** The scope's work-item id, or null for an unscoped run (`auto`, `batch`). */
  scopeWorkItemId: string | null;
  /** What the CLI printed for the scope. Survives the scope card's deletion. */
  scopeLabel: string | null;
  status: DispatchRunStatus;
  stopReason: DispatchStopReason | null;
  agent: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * When the run last said it was alive (MOTIR-6528) — read through `isRunAlive`
   * (`lib/runs/runLiveness.ts`), never compared to a clock anywhere else.
   */
  lastHeartbeatAt: string | null;
  /**
   * Who reports this run (MOTIR-7450, `agent-reported-runs.md` §1) — `agent` for a
   * run the agent opened about itself, `cli` for every run a runner observes. Set by
   * the door that opened the run, never by a caller.
   */
  reportedBy: DispatchRunReporter;
  createdById: string | null;
  /**
   * The developer's own agent the run executed in (MOTIR-7023,
   * `agent-instance-run.md` §5) — what lets the run section and the run modal say
   * _"yue-claude · Claude Code"_. Null for every `local` and `hosted` run, and for
   * an `instance` run whose agent row was removed.
   *
   * ⚠️ NO COST FIELD rides with it (`dispatch-run-record.md` Q3.3): a run in an
   * agent is charged as the agent's machine time, on the agent's intervals.
   */
  agentInstance: DispatchRunAgentInstanceDto | null;
  /** The run's cards, in the run's own stored order. */
  cards: DispatchRunCardDto[];
  /**
   * The highest `seq` this run has stored, or 0 for a run with no events — the
   * cursor a client resumes the stream from.
   *
   * ⚠️ 0 rather than null, so `?since=<seq>` takes one type on the wire and a
   * client that has seen nothing uses the same call as one that has seen 400.
   */
  seq: number;
  /**
   * What a `continue` run resumes (MOTIR-6795), read from its `run_opened` — the
   * dead run, every repository's branch, and for a parent which legs landed and
   * which were in flight. A hosted container adopts the run instead of claiming,
   * so this is how it learns what the claim decided. Only the single-run read
   * fills it; null for every other command, and absent on the ingest answers.
   */
  continues?: DispatchRunContinuesDto | null;
  /**
   * What a HOSTED `fix` run repairs (MOTIR-6929), read from the `run_opened` the
   * server's repair claim wrote (MOTIR-6928) — the class, every pull request on its
   * OWN branch at the head it was handed, and the review's findings. A hosted
   * container adopts the run instead of claiming, so this is how it learns what the
   * claim decided. Only the single-run read fills it; null for every other command
   * and for a LOCAL `fix` run (whose `run_opened` the CLI writes, recording none of it).
   */
  repair?: DispatchRunRepairDto | null;
  /**
   * What a `review` run reviews (Story MOTIR-11941 · MOTIR-11953), read from its
   * `run_opened`: the gate (null with Review off) and the delivery-set version. A review in
   * the person's own agent adopts its run and compares the served prompt against this. Only
   * the single-run read fills it; null for every other command.
   */
  review?: DispatchRunReviewDto | null;
}

/** What a review run reviews, as its `run_opened` recorded it (MOTIR-11953). */
export interface DispatchRunReviewDto {
  gateId: string | null;
  subjectVersion: string;
}

/** A hosted repair's decision, as its `run_opened` recorded it (MOTIR-6928 · MOTIR-6929). */
export interface DispatchRunRepairDto {
  repairClass: 'ci' | 'acceptance_rerun' | 'review';
  title: string | null;
  /** Every pull request, each on its OWN branch — checked out and pushed to, nothing else. */
  pullRequests: Array<{
    /** `owner/name`. */
    repo: string;
    number: number;
    url: string;
    branch: string;
    baseRef: string | null;
    /** The head the claim was handed, or null when no check row named one. */
    headSha: string | null;
    /** The claim found it CONFLICTED with `baseRef` at that head (Bug MOTIR-12096) — the
     *  same reading as the terminal claim's `conflicted`. False on a run recorded before
     *  the claim kept it. */
    conflicted: boolean;
    /** The claim found it OUT OF DATE with a base that requires branches to be up to date
     *  (`mergeable_state: behind`) — the terminal claim's `outOfDate`. False on a run
     *  recorded before the claim kept it. */
    outOfDate: boolean;
  }>;
  /**
   * The conversation an agent-door repair can resume (MOTIR-9052): the profile of the
   * card's last agent run (the caller's own) and the session it recorded. Null for a
   * hosted or local repair, and when the card had no earlier agent run.
   */
  resume: { profile: string; sessionId: string | null; canResume: boolean } | null;
  /** The review's refusal the repair answers — set on a `review` repair. */
  findings: {
    gate: 'agent_review' | 'pull_request_approval';
    gateId: string | null;
    subjectVersion: string | null;
    /** VERBATIM and in full. */
    findingsMd: string | null;
    reviewerName: string | null;
    decidedByLabel: string | null;
    decidedUnderAuthority: string | null;
    decidedAt: string;
  } | null;
}

export interface DispatchRunContinuesDto {
  /** The dead run this one carries on. */
  fromRunId: string | null;
  /** The primary repository's branch. */
  branch: string | null;
  /**
   * Every repository's branch, primary first, with the repository's clone URL
   * where the project knows it — so a hosted container can clone a repository
   * the dead run pushed to even when no leg left to run touches it.
   */
  branches: Array<{ repository: string | null; branch: string; cloneUrl: string | null }>;
  mode: 'card' | 'parent';
  landedKeys: string[];
  resumedKeys: string[];
}

/** What the OPEN operation answers with. */
export interface DispatchRunOpenedDto {
  run: DispatchRunDto;
  /**
   * Whether this call CREATED the run, or found the one the same
   * `idempotencyKey` already opened. A repeat is a success, not an error — the
   * flag is what lets a reporter tell a first attempt from a retry without
   * comparing timestamps.
   */
  created: boolean;
}

/**
 * What `start_work_item_run` answers with (MOTIR-7450, `agent-reported-runs.md` §2):
 * the run, and whether this call OPENED it or found the caller's own open run on the
 * same card — a retried or resumed session gets `mine` and the same run, never a
 * second one.
 */
export interface AgentRunOpenedDto {
  outcome: 'opened' | 'mine';
  run: DispatchRunDto;
  /** The run's legs in order, each with its card's title (null for a card no longer in the tree). */
  legs: AgentRunLegDto[];
}

/** One leg of an agent-reported run, as `start_work_item_run` names it. */
export interface AgentRunLegDto {
  /** Null only for a leg whose card has since been deleted. */
  key: string | null;
  title: string | null;
}

/**
 * What `close_work_item_run` answers with (MOTIR-7451, §4): the run as it now
 * stands, the leg cards a delivered close stamped with the run's harness and model,
 * and whether it was ALREADY closed (a second close, or one the reap beat), in which
 * case nothing was written and `stamped` is empty.
 */
export interface AgentRunClosedDto {
  run: DispatchRunDto;
  stamped: string[];
  alreadyClosed: boolean;
}

/**
 * What `report_action` answers with (MOTIR-7450, §3). `reported` when it wrote into
 * the caller's open run on a card; `heartbeat` for the no-argument form, with how
 * many of the caller's open runs it touched (a run beaten under a minute ago is
 * left alone, so `0` is an ordinary answer).
 */
export type AgentActionReportedDto =
  | {
      kind: 'reported';
      runId: string;
      /** Who reports the run it wrote into — `cli` when the agent is inside a CLI run. */
      runReportedBy: DispatchRunReporter;
      /** How many events this call wrote. */
      appended: number;
      /** The run's new highest `seq`. */
      seq: number;
    }
  | { kind: 'heartbeat'; touched: number };

/** What the APPEND operation answers with. */
export interface DispatchRunAppendedDto {
  runId: string;
  /** How many events this call actually wrote. */
  appended: number;
  /** The run's new highest `seq` — the cursor for the next append. */
  seq: number;
  /** Every leg this batch moved, so a caller need not re-read the run. */
  cards: DispatchRunCardDto[];
}

/**
 * One LEG with its card's DELIVERY SET joined on.
 *
 * ⚠️ THE DELIVERIES ARE JOINED, NEVER STORED. The run record holds no
 * pull-request or CI column at all (ADR Q3), so this shape is where the two
 * owners meet: the run says what it DID, `work_item_delivery` says what SHIPPED,
 * and `derivePrCiState` — the one CI derivation in the product — says whether it
 * is green. A second copy on the run row would be the first place the two could
 * disagree, and a person would then have two screens with two answers to *did
 * this ship*.
 *
 * Empty is the ordinary answer: a card the run skipped, or one whose agent has
 * not pushed yet, has no delivery and never had one.
 */
export interface DispatchRunCardWithDeliveriesDto extends DispatchRunCardDto {
  deliveries: WorkItemDeliveryDto[];
}

/**
 * What a HOSTED run cost in model tokens and credits (MOTIR-689), read from
 * motir-ai's per-run usage (`GET /v1/agent-runs/:coreRunId/usage`), keyed by the
 * run's own id (`docs/decisions/hosted-agent-run.md` §1).
 *
 * ⚠️ A READ, NEVER A COLUMN: `DispatchRun` carries no cost (MOTIR-1801). Zeroes
 * mean motir-ai has recorded no billed call for the run yet. Machine SECONDS are
 * not here — they are the fleet meter's (MOTIR-6448); the CREDITS they were
 * charged at are (MOTIR-6514), and never the meter's cost figure.
 */
export interface DispatchRunCostDto {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The MODEL-CALL credits (MOTIR-689). */
  credits: number;
  /** The machine-time charge (MOTIR-6514); `0` until the run's container settles. */
  machineCredits: number;
  /** `credits + machineCredits` — what the run cost the org, in credits. */
  totalCredits: number;
}

/** The run as the BROWSER reads it — the header, its set, and what each leg shipped. */
export interface DispatchRunDetailDto extends Omit<DispatchRunDto, 'cards'> {
  cards: DispatchRunCardWithDeliveriesDto[];
  /**
   * A HOSTED run's token and credit cost (MOTIR-689). ABSENT on a local run,
   * which is billed nowhere Motir can read and makes no such call. `null` on a
   * hosted run means motir-ai could not be asked — never "cost nothing".
   */
  cost?: DispatchRunCostDto | null;
  /**
   * How a HOSTED run — or a run in an agent (MOTIR-7028) — ended, for its reason
   * line (MOTIR-691). ABSENT on a local run. `null` fields mean the fact is not
   * recorded — never a guess.
   */
  hostedEnd?: DispatchRunHostedEndDto;
}

/**
 * A HOSTED run's END, as the run record holds it (MOTIR-691).
 *
 * ⚠️ READ, NEVER STORED — the run record carries no reason column. `outcome` and
 * `detail` are the closing `log` line the end path writes (`endHostedRun`);
 * `exitCode` is its legs' agent exit code (a failing leg's first), the only
 * reason a run the CLI closed itself has. A run still going has all three null.
 */
export interface DispatchRunHostedEndDto {
  /** The end path's outcome name — `exited` (a crash), `failed`, `cancelled`,
   *  `stall`, `backstop`, `lost_supervision` — or null when the CLI closed it. */
  outcome: string | null;
  /** The closing line's detail, verbatim (`stalled: no agent output for 15
   *  minutes`), or null once its body has aged out or when there is none. */
  detail: string | null;
  /** The agent's exit code — a failing leg's first, else any leg's — or null. */
  exitCode: number | null;
}

/**
 * A run's MACHINE TIME (MOTIR-691 over MOTIR-6448's by-run read): billable
 * seconds, and whether every container row has settled. Never a money figure —
 * the meter's cost is Motir's own fleet cost, not a price.
 */
export interface DispatchRunMachineTimeDto {
  billableSeconds: number;
  settled: boolean;
}

/**
 * How a run's SET came out, COUNTED — the runs index's summary of one run
 * (MOTIR-3922).
 *
 * ⚠️ TOTAL over `DispatchCardDisposition`, zeros included, and that is the
 * point rather than payload hygiene. A partial map with *absent means zero*
 * hands every renderer an `undefined` to remember, and the day the ADR grows a
 * disposition a partial map keeps compiling while the new value renders as
 * nothing — the same silent-default failure the run surfaces' totality tests
 * exist to make loud. A dozen zeros per row is a price worth paying for a map
 * the compiler checks.
 */
export type DispatchRunLegCountsDto = Record<DispatchCardDisposition, number>;

/**
 * One run as the RUNS INDEX reads it (MOTIR-3922) — the header, and its set
 * SUMMARISED rather than listed.
 *
 * ⚠️ IT CARRIES NO `cards` ARRAY, deliberately. The index renders a list that
 * grows without bound — run headers are append-only and nothing deletes them —
 * so sending every leg of every run would make the list pay for a run view
 * nobody opened, exactly as {@link ActiveDispatchRunDto} refuses to. What a row
 * needs is *how it came out*: "9 of 11 implemented, 1 skipped, 1 not reached".
 * The counts come from the same include the query already makes, so the page
 * costs one query however many runs it holds.
 *
 * The one thing derived FROM those cards in place of shipping them is the run's
 * TARGET — `targetKey`, `targetWorkItemId` and `otherCardCount` — which is what
 * the index names a run by. The run's full set stays readable in the overlay
 * where somebody deliberately opened it.
 */
export interface DispatchRunListItemDto {
  id: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  /** The scope's work-item id, or null for an unscoped run (`auto`, `batch`). */
  scopeWorkItemId: string | null;
  /** What the CLI printed for the scope. Survives the scope card's deletion. */
  scopeLabel: string | null;
  status: DispatchRunStatus;
  stopReason: DispatchStopReason | null;
  agent: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  createdById: string | null;
  /**
   * The agent a run in an agent executed in (MOTIR-7028) — the Run section's
   * scope block names it as *agent · coding agent*. Null (or absent, on a row
   * built without it) for every other run.
   */
  agentInstance?: DispatchRunAgentInstanceDto | null;
  /** How many cards this run owned. Zero is a real answer, not an error. */
  cardCount: number;
  legs: DispatchRunLegCountsDto;
  /**
   * What the run was FOR, as a key: the scope work item's identifier; else, when
   * the scope is gone, the stored label AS TEXT; else the first leg's key. Null
   * only for a run with no subject at all (`auto` with no legs and no scope).
   *
   * ⚠️ NOT `scopeLabel`: every shipped writer of a container run stores the
   * work item's TITLE there, so a column fed from it would show a title and its
   * link would open `/items/<title>`.
   */
  targetKey: string | null;
  /**
   * The id that decides whether {@link targetKey} is a door. Picked in the SAME
   * branch as the key (scope → the scope's id, stored label → null, first leg →
   * that leg's id), so a key can never link to another branch's work item. Null
   * means render the key as text: there is nothing to open.
   */
  targetWorkItemId: string | null;
  /**
   * The legs whose key differs from {@link targetKey} — the `+N`. Never
   * `cardCount - 1`: a run scoped to a container over three children needs 3,
   * a run of three legs whose first is its own target needs 2, and `cardCount`
   * is 3 both times. Zero means no `+N`.
   */
  otherCardCount: number;
  /**
   * The skipped legs still waiting on a person (MOTIR-7477), for this reader.
   * Absent on a row built without the gate read — every leg then counts as
   * skipped, which is what it is.
   */
  waiting?: DispatchRunWaitingCountsDto;
}

/**
 * The WORK ITEM a narrowed runs index is scoped to (Story MOTIR-5363 · design
 * MOTIR-5402) — what `/runs?scope=<KEY>`'s header names.
 *
 * Three fields and no more: the page links back to the work item for everything
 * else, and the header needs only to say WHICH item and whether it is archived —
 * an archived scope still resolves (its runs are still its runs), and the header
 * says so rather than surprising a reader who arrived from an old link.
 */
export interface DispatchRunScopeDto {
  key: string;
  title: string;
  archived: boolean;
}

/**
 * One LIVE run in a project, keyed by LEG.
 *
 * Deliberately NARROWER than the detail shape: it carries each leg's KEY and
 * DISPOSITION and nothing else, so a caller can answer *is THIS card being
 * worked?* for many cards from one request.
 *
 * ⚠️ ITS ORIGINAL CONSUMER IS GONE. This shape was built for the `/ready` run
 * strip, which is archived — a ready row cannot have a live run, because
 * `collectReadyLeaves` lists only `todo` leaves and claiming a card flips it to
 * `in_progress` first (MOTIR-3914). It is kept because the question it answers
 * is per-CARD, which {@link DispatchRunListItemDto} deliberately does not
 * answer: the index summarises a run's legs by COUNT and never by key. Whether
 * anything still needs the per-card form is MOTIR-3923's to settle when it
 * builds the index; if the answer is no, this shape and its route go together.
 */
export interface ActiveDispatchRunDto {
  id: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  scopeLabel: string | null;
  startedAt: string;
  cards: Array<{ key: string | null; disposition: DispatchCardDisposition }>;
}

/**
 * A run's CLOSE-OUT prompt (Story MOTIR-4906 · MOTIR-5357) — what the CLI hands
 * one agent before marking the run's pull requests ready, so HOW TO TEST is
 * written onto the run target by an agent that sees the whole run.
 */
export interface DispatchRunCloseOutPromptDto {
  runId: string;
  /** The run target — the item the run was launched against. */
  targetKey: string;
  prompt: string;
  /** The cards the run landed (integrated or implemented), in run order. */
  landedKeys: string[];
}

/**
 * WHOSE runs a Runs-room read covers (Story MOTIR-6179 · MOTIR-6331) — a
 * different axis from `?scope=<KEY>`, which narrows WHICH work item's runs.
 *
 *   * `project` — every run; served only to a reader holding `run:view_any`
 *     (on a bearer token: in its grant too).
 *   * `mine` — the runs the reader STARTED; served to anyone who browses.
 *
 * The caller ASKS; the service serves, and says which on the DTO — a `project`
 * request from a reader without the key is served `mine`, never refused.
 */
export type DispatchRunView = 'mine' | 'project';

/** A page of a project's runs, with the scope the service SERVED. */
export interface DispatchRunListPageDto {
  runs: DispatchRunListItemDto[];
  scope: DispatchRunView;
}

/** A project's live runs, with the scope the service SERVED. */
export interface ActiveDispatchRunsDto {
  runs: ActiveDispatchRunDto[];
  scope: DispatchRunView;
}
