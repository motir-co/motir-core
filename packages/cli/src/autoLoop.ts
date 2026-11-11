import type { HowToTestRecord } from './client.js';
import { formatTable, truncate } from './render.js';
import type { SessionCommit } from './git.js';

// The PURE half of `motir auto` (Story 7.9 · Subtask 7.9.4 · MOTIR-882): what
// the loop DECIDES and what it REPORTS, with no MCP call, no spawn, no git and
// no stdout. The I/O half — the WHILE loop itself — lives in
// `commands/auto.ts`, so every decision below is unit-testable against a plain
// object.
//
// The loop's defining property is that it holds NO plan of the run. It asks the
// server for exactly ONE item per iteration and acts on that; the ready set
// changes underneath it (an integrated item unlocks its dependents mid-run), so
// any list materialized up front would be wrong by the second iteration. There
// is deliberately no function here that takes or returns a ready LIST.

/** What the loop does with one item the server handed it. */
export type ItemDisposition =
  /** A leaf a coding agent can execute — the normal case. */
  | 'dispatch'
  /** An UNEXPANDED epic/story: legitimately ready (the childless-container
   *  rule — a container WITH children never reaches the ready set), but it is a
   *  PLANNING item, and there is no agent prompt for "do the planning". Skipped
   *  and named; `motir auto --include-planning` (MOTIR-886) is what will instead
   *  trigger its expansion. */
  | 'needs_planning'
  /** Human work a coding agent cannot do (`type: manual` / `executor: human`).
   *  It has no branch and no pull request, so handing it to an agent would
   *  produce a confident lie rather than a deliverable. */
  | 'needs_human';

const CONTAINER_KINDS = new Set(['epic', 'story']);

/**
 * Decide what to do with one ready item — the loop's only classification, made
 * from the dispatch payload alone (no extra round-trip).
 *
 * The manual test mirrors the server's own `isManualReadyItem` predicate; it is
 * re-stated here rather than imported because the CLI is a standalone package
 * that cannot reach into the Next app, exactly as it re-states the workflow
 * status keys it names.
 */
export function classifyReadyItem(item: {
  kind: string;
  type?: string | null;
  executor?: string | null;
}): ItemDisposition {
  if (CONTAINER_KINDS.has(item.kind.toLowerCase())) return 'needs_planning';
  if (item.executor === 'human' || item.type === 'manual') return 'needs_human';
  return 'dispatch';
}

/**
 * A `decision` card an AGENT runs — dispatched like any other, but never onto a
 * session branch (MOTIR-6094), and since MOTIR-7437 onto no branch at all: the
 * agent writes its decision as a PAGE and publishes it with
 * `publish_decision_page`, making no commit and opening no pull request.
 *
 * The server's prompt renders no git workflow for such a card and names no
 * branch (`isAgentDecisionItem`, restated here for the reason
 * {@link classifyReadyItem} gives). Keeping it off the session still matters: a
 * decision makes no commits to integrate, and seeding a lineage for it would open
 * a session pull request with nothing on it. A scoped drain additionally holds
 * the decision's dependents until its gate is approved, because nothing else in
 * that loop would.
 */
export function isAgentDecisionItem(item: {
  type?: string | null;
  executor?: string | null;
}): boolean {
  return item.type === 'decision' && item.executor !== 'human';
}

/**
 * A `design` card an AGENT runs — its published result raises a design gate that
 * a PERSON answers, so a scoped drain holds the cards waiting on it until that
 * gate is approved, exactly as it holds a decision's (MOTIR-6117).
 *
 * Landing is not approval: the drain used to count a landed design as a
 * satisfied blocker and dispatch its dependents straight into the run-time
 * design gate, whose remedy — propose a new design card — is wrong for a design
 * that is simply awaiting a person.
 */
export function isAgentDesignItem(item: {
  type?: string | null;
  executor?: string | null;
}): boolean {
  return item.type === 'design' && item.executor !== 'human';
}

/**
 * The status keys at which a decision's GATE has been answered yes — what
 * releases the work that waits on it (MOTIR-6094).
 *
 * `approved` is the press; `done` is the merge that follows it. A `cancelled`
 * decision is deliberately NOT here: an overturned decision is a re-plan still
 * owed, and building on it is the one thing the hold exists to prevent.
 */
export const DECISION_RELEASED_STATUS_KEYS: ReadonlySet<string> = new Set(['approved', 'done']);

/** How one dispatched item ended. */
export type AutoOutcome =
  /** Agent exited 0 and the work was recorded on the session branch. */
  | 'integrated'
  /** Agent exited 0 and its work reached the remote, but the server kept the item
   *  OFF the session lineage (it already belonged to another one), so it opened a
   *  pull request of its own and was moved to Implemented instead — CI decides
   *  when that becomes In Review (MOTIR-3004). */
  | 'implemented'
  /** Agent exited non-zero. The item stays In Progress — nothing was reverted. */
  | 'failed'
  /**
   * The agent REFUSED the card: it found the premise false, reverted, commented
   * the finding, left the card in `planning` and submitted a re-plan for a human
   * (MOTIR-3018). Exit 0, and NOT a success — nothing was built and nothing
   * reached a branch.
   *
   * ⚠️ IT IS ALSO NOT A FAILURE, and every consumer has to be told which. It
   * does not open a pull request, it is not listed among the cards a session
   * branch carries, it does not set a failing exit code, and it does not consult
   * `--keep-going` — the run stops because the prompt told the agent to stop,
   * not because anything went wrong.
   */
  | 'replanned';

export interface DispatchRecord {
  key: string;
  title: string | null;
  outcome: AutoOutcome;
  durationMs: number;
  /** The branch the work was integrated onto, when it was. */
  sessionBranch: string | null;
  repo: string | null;
  /**
   * The agent conversation that built this card (MOTIR-9059) — what its CI watch resumes.
   * `null` when the agent recorded none; absent on a record that never ran an agent.
   */
  sessionId?: string | null;
  /**
   * EVERY repository the card ships in (MOTIR-3135), primary first — `[]` when
   * it names none, so `repo` is `repos[0] ?? null`.
   *
   * The scalar alone is not enough at close-out: a FAILED record is matched to a
   * repository's session pull request by name, and a card that failed while
   * carrying two repositories belongs in BOTH of their bodies. Matching on the
   * primary would silently drop it from the other one — a half-done card missing
   * from the review surface of the repository it half-touched.
   */
  repos?: string[];
  /**
   * The card's PARENT key, or `null` for a top-level item (MOTIR-2422).
   *
   * Carried on the record because the TITLE is decided at close-out, from the
   * whole set — and it costs nothing: it rides the dispatch prompt the loop
   * already fetches per item (MOTIR-2445).
   */
  parentKey: string | null;
  /** Extra detail for the summary (an exit code, a lineage note). */
  detail?: string;
}

export interface SkipRecord {
  key: string;
  title: string | null;
  /**
   * The first two are read off the ready ROW, before anything is touched. The
   * third, `claim_refused`, can only be learned by ASKING (MOTIR-3048): the
   * pick already narrowed to rows this run may take, and a sibling can still
   * take one between the pick and the claim. It is a SKIP and not a failure —
   * no agent ran, nothing was reverted — so `autoExitCode`, which reads only
   * `records`, is unaffected by it.
   */
  reason: 'needs_planning' | 'needs_human' | 'claim_refused' | 'blocked_in_scope';
  /** For `needs_human`: the person the card waits on when that is NOT the run's
   *  starter (see {@link manualWaitingOn}). Absent means the starter — *you*. */
  waitingOn?: string;
  /** For `blocked_in_scope`: the in-scope blockers that were still open when the
   *  run reached this card. Absent for every other reason. */
  blockedBy?: string[];
}

/** How ONE `--include-planning` expansion trigger ended (MOTIR-886).
 *
 *  Note what is NOT here: an `expanded` / `children` outcome. The job produces a
 *  Plan of PROPOSALS, and approving that plan — in Motir, by a human — is the
 *  only thing that turns a proposal into a work item. The run's whole job is to
 *  FIRE the planning and say so; it can never report children it did not create.
 *  The vocabulary mirrors the shipped server-side cadence trigger (MOTIR-916):
 *  fired / skipped / failed. */
export interface PlanningRecord {
  key: string;
  title: string | null;
  /** `triggered` — the job was accepted; `failed` — the submit was refused. */
  outcome: 'triggered' | 'failed';
  /** The plan the job writes its proposals into — the thing to review. */
  planId: string | null;
  /** Where to review it, when the run knew the server URL. */
  reviewUrl: string | null;
  /** Why it failed, verbatim from the server's own typed error. */
  detail?: string;
}

/**
 * One plan the run APPROVED on its own (MOTIR-3023) — what
 * `--auto-approve-replan` actually did to the operator's tree.
 *
 * ⚠️ THE SUMMARY OWES THIS MORE THAN ANYTHING ELSE IN THE RUN. Every other
 * record says what the loop BUILT; this one says what it DECIDED, while nobody
 * was watching, about a plan someone else owns. The first thing they read in the
 * morning should be what changed, not a tree that is quietly different.
 */
export interface ApprovalRecord {
  /** The card whose refusal produced the plan. */
  key: string;
  /** The plan that was approved — the id to open in Motir. */
  planId: string;
  /** How many proposals it carried. */
  proposalCount: number;
}

/**
 * What happened to ONE submitted re-plan under `--auto-approve-replan`
 * (MOTIR-4085) — which lane it went down, and what the run then did.
 *
 * ⚠️ ONE ROW PER ITERATION THAT SUBMITTED A RE-PLAN, including the ones that
 * were NOT approved — which is the half a summary is most tempted to drop.
 * {@link ApprovalRecord} says what the run changed; this says what it DECIDED,
 * and a decline is a decision. An operator reading only the approvals cannot
 * tell "the agent never refused anything" from "the agent refused three cards
 * and the loop declined every one of them", and those want opposite responses.
 */
export interface ReplanLaneRecord {
  /** The card whose agent submitted the re-plan. */
  key: string;
  /**
   * Which lane it turned out to be in.
   *
   * - `auto_approved` — every proposal fell inside the card's own lane, so the
   *   run approved it and carried on.
   * - `declined_out_of_lane` — the plan is valid and reaches wider than this
   *   card and its siblings, so a person decides it. NOT a failure.
   * - `anchored_elsewhere` — the agent anchored its plan at something other than
   *   this card, which is the normal lane ELECTED. Also not a failure.
   * - `unreadable` — the plan could not be read at all (still being written when
   *   the run's patience ran out, or the read was refused). The run stops rather
   *   than approving something it has not seen.
   */
  lane: 'auto_approved' | 'declined_out_of_lane' | 'anchored_elsewhere' | 'unreadable';
  /** The plan, when the run got far enough to learn its id. */
  planId: string | null;
  /** For `declined_out_of_lane`: one line per proposal that fell outside, each
   *  naming what it would have touched. A count alone is not actionable. */
  outOfLane?: string[];
  /** What the run did next — the fact the other fields exist to explain. */
  continued: boolean;
  /** For `auto_approved`: the SCOPED refresh (below), so the operator can see
   *  which sibling work the run then skipped and which it picked up. */
  refresh?: ReplanRefresh;
  /** The server's own sentence, for the two arms that have one. */
  detail?: string;
}

/**
 * The queue REFRESH an approved in-lane plan forces (MOTIR-4085).
 *
 * ⚠️ SCOPED TO ONE PARENT, and the scope is the substantive claim. An in-lane
 * plan changes the children of exactly one container, so re-deriving anything
 * wider would let one leaf silently re-order work the operator queued elsewhere.
 * The record names that parent so the bound is visible rather than asserted.
 */
export interface ReplanRefresh {
  /** The container whose children were re-read; `null` for a top-level card. */
  parentKey: string | null;
  /** Children that were there before the approval and are gone after it — the
   *  plan removed them, and the run must not execute work a plan deleted. */
  removed: string[];
  /** Children the approval created. They join the ready set on their own merits;
   *  naming them is how an operator knows the run's remaining work grew. */
  added: string[];
}

/** One repo the run touched: its session branch and the items carried on it. */
export interface RepoSession {
  repoName: string | null;
  cwd: string;
  branch: string;
  keys: string[];
}

/** Why the loop stopped — every exit path is named, so the summary can say. */
export type StopReason =
  /** `next_ready` returned nothing: the ready set is drained. */
  | 'drained'
  /** `--max <n>` reached. */
  | 'max'
  /** An agent failed and `--keep-going` was not passed. */
  | 'halted'
  /** Ctrl-C. */
  | 'interrupted'
  /**
   * An agent submitted a re-plan (MOTIR-3018). The loop stops rather than
   * picking up other work, which is what the prompt's own THE-CARD-IS-WRONG
   * branch instructs — and what a human deciding on a plan needs, since the
   * cards the loop would take next are the ones that plan may be about to
   * change.
   *
   * Distinct from `halted` on purpose: `halted` means something went wrong and
   * `autoExitCode` reports it; this is a correct outcome and exits 0.
   */
  | 'replanned'
  /**
   * A scoped drain stopped because every child left waits on a PERSON's gate — a
   * design, a decision or a manual card nobody has approved yet (Story MOTIR-7701
   * · MOTIR-7704). A correct outcome, never `halted`: the server records the
   * gates and the run waits To resume. {@link AutoSummary.gatedOn} names them.
   */
  | 'gated';

export interface PrReport {
  repoName: string | null;
  branch: string;
  url: string | null;
  outcome: 'opened' | 'existing' | 'failed' | 'empty';
  /**
   * The pull request was left a DRAFT (MOTIR-4967) — either because a child of
   * the claimed container had not landed, or because `gh pr ready` refused.
   *
   * ⚠️ THIS REPLACES THE `held` OUTCOME (Bug MOTIR-3268). A hold used to mean
   * "no pull request was opened at all", because a pull request opened over an
   * unfinished container claims the container is built. The draft carries that
   * invariant strictly better — a draft cannot be merged, so nothing can close
   * the children — while the work still gets CI, which the hold denied it.
   */
  draft?: boolean;
  message?: string;
}

export interface AutoSummary {
  runId: string;
  records: DispatchRecord[];
  skipped: SkipRecord[];
  /** The expansions `--include-planning` fired. Empty without the flag, in which
   *  case the planning items appear under {@link AutoSummary.skipped} instead. */
  planning: PlanningRecord[];
  repos: RepoSession[];
  prs: PrReport[];
  /** The plans `--auto-approve-replan` approved. Empty without the flag, and
   *  empty with it when no agent refused a card. */
  approvals: ApprovalRecord[];
  /**
   * Every re-plan this run made a LANE DECISION about (MOTIR-4085) — approved,
   * declined, elected away, or unreadable. A superset of {@link approvals}:
   * every approval has a row here, and so does every refusal.
   *
   * Empty without `--auto-approve-replan`, because without it there is no
   * decision to make — the loop stops on any re-plan, which the `replanned`
   * block already reports.
   */
  lanes: ReplanLaneRecord[];
  /**
   * The claimed container's children that had NOT landed when the close-out
   * re-read it (MOTIR-4967, retiring Bug MOTIR-3268's `held`).
   *
   * ⚠️ IT INFORMS THE SUMMARY; IT NO LONGER GATES THE OPEN. The re-read itself
   * survives unchanged — the close-out still has to know whether every child
   * landed, because that is exactly the condition for marking the pull request
   * READY. What changed is the consequence: the pull request exists either way,
   * and an unfinished container simply leaves it a draft.
   *
   * Absent on a run with no container to re-read (`motir auto`, a sprint scope).
   */
  outstanding?: { containerKey: string; keys: string[] };
  /**
   * The WORK ITEM a scoped run was launched against (MOTIR-10985) — the story
   * whose session pull request this run delivers. Known before the first card
   * starts, so the pull request is titled for it and linked to it from the first
   * landed card rather than inferred from the carried set's parent partition,
   * which reads `one-card` until a second card lands.
   *
   * Absent on `motir auto` and on a sprint scope, which keep the partition's arms.
   */
  container?: SessionPrContainer;
  stopReason: StopReason;
  /** On a `gated` stop: the gate cards still awaiting a person, in order. */
  gatedOn?: string[];
}

/** The review surface for a submitted plan — `<server>/plans/<id>`, the same
 *  route the in-app generation hand-off links to. Built from the run's own
 *  server URL so the summary line is clickable rather than a bare id. */
export function planReviewUrl(serverUrl: string, planId: string): string | null {
  try {
    return new URL(`/plans/${encodeURIComponent(planId)}`, serverUrl).toString();
  } catch {
    // A server URL the CLI could not parse is not worth failing a run over — the
    // planId alone still identifies the plan.
    return null;
  }
}

/** `1m 04s` / `12s` — a duration a human reads at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

const OUTCOME_LABEL: Record<AutoOutcome, string> = {
  integrated: 'integrated',
  implemented: 'implemented',
  failed: 'FAILED',
  replanned: 're-planned',
};

/**
 * Did this dispatch put code somewhere? The partition every consumer needs, and
 * the reason it is a named predicate rather than `outcome !== 'failed'`.
 *
 * ⚠️ `!== 'failed'` WAS TOTAL AND STOPPED BEING SO (MOTIR-3018). With two
 * outcomes it read as "landed"; with `replanned` added, every site spelling it
 * that way silently claims a refused card as delivered work — listing it under
 * *Implemented*, naming it in a pull-request title, and putting it in the body
 * as a card the branch carries. A predicate that enumerates what it INCLUDES
 * cannot rot the same way: a future outcome is excluded until someone decides
 * otherwise, which is the safe direction for a claim about shipped code.
 */
export function landedWork(record: Pick<DispatchRecord, 'outcome'>): boolean {
  return record.outcome === 'integrated' || record.outcome === 'implemented';
}

const STOP_LABEL: Record<StopReason, string> = {
  drained: 'the ready set is drained',
  max: '--max reached',
  halted: 'halted on the first agent failure (--keep-going continues past one)',
  interrupted: 'interrupted (Ctrl-C)',
  replanned: 'an agent refused its work item and submitted a re-plan — waiting for you in Motir',
  gated: 'stopped at a gate',
};

/**
 * WHO A MANUAL CARD THE RUN SKIPPED IS WAITING ON (Story MOTIR-7460 · MOTIR-7477;
 * `docs/decisions/manual-work-gate.md` §8).
 *
 * The run's skip raises a `manual_work` gate on the card, routed to its assignee —
 * and an UNASSIGNED card is assigned to the run's starter first (§3). So the CLI,
 * which cannot see the gate, answers from the card it was handed: `undefined` —
 * *waiting on you*, the starter — when the card is unassigned or the starter's;
 * the assignee's name otherwise. Every loop picks only unassigned or own cards
 * (`isPickable`), so the second arm is the rare one; it is here so the report
 * never says *you* about somebody else's card.
 */
export function manualWaitingOn(
  item: { assigneeId: string | null; assigneeName?: string | null },
  ownerId: string | null | undefined,
): string | undefined {
  if (item.assigneeId === null || !ownerId || item.assigneeId === ownerId) return undefined;
  return item.assigneeName?.trim() || 'its assignee';
}

/**
 * The `needs_human` group of a run report, in the words §8 gives it: the card is
 * waiting on its person in Motir's **Waiting on you** — never *needs a human*.
 * Split in two so *you* stays true: the starter's cards, then anybody else's,
 * each line naming who.
 */
export function renderManualSkipGroups(
  prefix: string,
  group: ReadonlyArray<{ key: string; title: string | null; waitingOn?: string | undefined }>,
  titleWidth: number,
): string[] {
  const blocks: string[] = [];
  const mine = group.filter((s) => s.waitingOn === undefined);
  const others = group.filter((s) => s.waitingOn !== undefined);
  if (mine.length > 0) {
    blocks.push(
      [
        `${prefix} — waiting on you in Motir's Waiting on you (${mine.length}):`,
        ...mine.map((s) => `  ${s.key} — ${truncate(s.title ?? '', titleWidth)}`),
      ].join('\n'),
    );
  }
  if (others.length > 0) {
    blocks.push(
      [
        `${prefix} — waiting on someone else in Motir (${others.length}):`,
        ...others.map(
          (s) => `  ${s.key} — ${truncate(s.title ?? '', titleWidth)} (waiting on ${s.waitingOn})`,
        ),
      ].join('\n'),
    );
  }
  return blocks;
}

const SKIP_LABEL: Record<Exclude<SkipRecord['reason'], 'needs_human'>, string> = {
  needs_planning: 'needs planning',
  // ⚠️ A SCOPED-RUN reason (MOTIR-3199), and it can only arise there. The run
  // OWNS this card — the claim took every member in the to-do category,
  // `blocked` included — which is not the same as being allowed to build it out
  // of order. Skipped and NAMED, never forced.
  blocked_in_scope: 'its blockers inside this scope did not land',
  claim_refused: 'claimed by somebody else, or no longer claimable',
};

/**
 * WHAT THIS RUN IS, read off the set it CARRIES (MOTIR-4969).
 *
 * ── Why the carried set and not the command ───────────────────────────────
 * The obvious partition is by lane — a scoped run has a story, an unscoped one
 * does not — and it is false on the first case anyone tries: `motir run sprint`
 * IS scoped and its ready set spans parents, so there is no single story for it
 * to name. What actually decides is the parent partition of the cards the run
 * carried, which is a property of the work rather than of the words typed.
 *
 * ── ONE derivation, two consumers ─────────────────────────────────────────
 * {@link sessionPrTitle} has computed exactly this partition since MOTIR-2422 to
 * decide what to CALL the session pull request; MOTIR-4969 needs the same answer
 * to decide what that pull request DELIVERS. Naming it once is not tidiness: two
 * copies are free to disagree about what the run is, and the title is the line a
 * reviewer reads first while the link is what moves the tree — so a divergence
 * would be invisible in review and consequential at merge.
 */
export type SessionPrScope =
  /**
   * ONE card, which is therefore the deliverable. Its parent describes something
   * much larger than what shipped, so nothing here names the parent — the title
   * would overstate a single subtask as its whole feature, and the link would
   * close a story on one of its children.
   */
  | { arm: 'one-card'; key: string }
  /**
   * N cards, EVERY one of them under the same parent: the run built a container,
   * and the container is what the pull request delivers.
   */
  | { arm: 'shared-parent'; key: string }
  /**
   * N cards under several parents — or none the set agrees on. There is no
   * container to name, and inventing one is the failure this arm exists to make
   * unreachable.
   */
  | { arm: 'many-parents' };

export function sessionPrScope(
  carried: readonly Pick<DispatchRecord, 'key' | 'parentKey'>[],
): SessionPrScope {
  const only = carried.length === 1 ? carried[0] : undefined;
  if (only) return { arm: 'one-card', key: only.key };

  // ⚠️ SHARED means EVERY card, and a `null` counts as a distinct answer. A set
  // containing a top-level card does not share a parent, so it falls through
  // rather than naming the story the OTHERS happen to sit under — saying less
  // beats saying something untrue, and here the untrue thing would be a link.
  //
  // An EMPTY set lands here too, and correctly: nothing was carried, so nothing
  // is delivered.
  const parents = new Set(carried.map((r) => r.parentKey));
  const shared = parents.size === 1 ? [...parents][0] : null;
  return shared ? { arm: 'shared-parent', key: shared } : { arm: 'many-parents' };
}

/** The work item a scoped run delivers — its key and title (MOTIR-10985). */
export interface SessionPrContainer {
  key: string;
  title: string;
}

/**
 * Which work item a session pull request DELIVERS, beside the cards its agents
 * link themselves (MOTIR-4969 · MOTIR-10985) — or `null` for none.
 *
 * A scoped run names it up front, so the answer is that item from the first
 * landed card on. Otherwise it is the carried set's shared parent, and only
 * that: a `one-card` run's pull request is the card's own, and a `many-parents`
 * run must not invent a story to name.
 */
export function deliveredContainerKey(
  carried: readonly Pick<DispatchRecord, 'key' | 'parentKey'>[],
  container?: SessionPrContainer,
): string | null {
  if (container) return container.key;
  const scope = sessionPrScope(carried);
  return scope.arm === 'shared-parent' ? scope.key : null;
}

/** The PR title for a session branch. Carries a `MOTIR-<n>` only in its
 *  one-card arm, where the claim is true; see
 *  {@link import('./git.js').sessionBranchName} for why a session PR must not
 *  name one item otherwise.
 *
 *  ⚠️ Since MOTIR-3674 a key here is a LABEL a human reads and nothing more —
 *  Motir does not parse a title, so this string cannot link, mis-link, or move
 *  anything. It is still worth getting right for the reader.
 *
 *  ⚠️ The three arms are {@link sessionPrScope}'s, shared rather than repeated
 *  (MOTIR-4969) — see there for why the partition is the carried set's. */
export function sessionPrTitle(
  runId: string,
  carried: readonly Pick<DispatchRecord, 'key' | 'title' | 'parentKey'>[],
  /**
   * A scoped run's work item (MOTIR-10985). The pull request is that item's
   * from its first card to its last, so its title names it whatever the carried
   * set's partition would say — one card, or none yet.
   */
  container?: SessionPrContainer,
): string {
  if (container) return fitTitle(`${container.key}${container.title ? ` ${container.title}` : ''}`);
  const count = carried.length;
  const scope = sessionPrScope(carried);

  if (scope.arm === 'one-card') {
    const only = carried[0]!;
    return fitTitle(`${only.key}${only.title ? ` ${only.title}` : ''}`);
  }
  if (scope.arm === 'shared-parent') return fitTitle(`${scope.key} — ${count} work items`);
  return `Motir auto run ${runId} — ${count} work item${count === 1 ? '' : 's'}`;
}

/**
 * GitHub renders a pull-request title in a list at roughly this width before it
 * elides; stating the budget here beats discovering it in the UI. Titles are
 * built to fit rather than trimmed after the fact, so the elision — when it
 * happens — falls at the end of a card title, never mid-key.
 */
const TITLE_BUDGET = 72;

function fitTitle(title: string): string {
  return title.length <= TITLE_BUDGET ? title : `${title.slice(0, TITLE_BUDGET - 1).trimEnd()}…`;
}

/**
 * The PR body: the LOOP's frame around the AGENTS' own commit messages
 * (MOTIR-2411).
 *
 * ── Who writes what, and why neither can do the other's job ────────────────
 * The body used to be a MANIFEST — one `- KEY — title` line per card. Fully
 * traceable, and it said nothing about what the branch DOES. A card title is
 * what was PLANNED; the commit is what was DONE, including everything that only
 * surfaced while doing it, and those diverge.
 *
 * So: **the AGENT writes the substance** — one card, one commit, composed at the
 * moment it had the most context it will ever have (11.5.25 tells it that this
 * message becomes this body). **The loop writes the frame** — which run, which
 * branch, what failed, how to close out. An agent saw one card and can know none
 * of that; the loop knows the run and nothing about what the change means.
 *
 * ⚠️ It reads the COMMITS, it does not reconstruct them from `records`. An
 * implementation that kept building from `DispatchRecord[]` and merely appended
 * a subject would look right in a single-repo test and silently drop any commit
 * the loop did not record — which is exactly the commit a reviewer most needs
 * told about.
 *
 * ⚠️ KNOWN LIMIT, not papered over: concatenated commits do not SYNTHESISE.
 * Four commits that together deliver one capability read as four changes. Saying
 * "these four do X" needs something that read the whole diff — a close-out agent
 * call, which is MOTIR-2423. This gets most of the value for none of that cost.
 */
export function renderSessionPrBody(
  runId: string,
  branch: string,
  records: DispatchRecord[],
  commits: SessionCommit[] = [],
  /**
   * The run's HOW TO TEST (MOTIR-5358) — the run target and its current record,
   * rendered as this body's `## How to test` section for THIS repository. Omitted
   * for a run with no run target (`motir auto`), whose cards each published their
   * own and whose body keeps its old shape.
   */
  howToTest?: { targetKey: string; record: HowToTestRecord | null; repoName: string | null },
): string {
  const carried = records.filter(landedWork);
  const failed = records.filter((r) => r.outcome === 'failed');
  const lines = [
    `Unattended \`motir auto\` run \`${runId}\`, integrated on \`${branch}\`.`,
    '',
    `## Work items carried (${carried.length})`,
    '',
    ...carried.map((r) => `- ${r.key} — ${r.title ?? '(untitled)'}`),
  ];

  if (commits.length > 0) {
    lines.push('', `## What the commits say (${commits.length})`, '');
    for (const [index, commit] of commits.entries()) {
      if (index > 0) lines.push('');
      lines.push(`### ${commit.subject}`);
      // A THIN commit degrades to the card's title rather than to a bare
      // subject with nothing under it — today's output, not worse than it. The
      // pairing is positional because one card is one commit, in dispatch order.
      const fallback = carried[index]?.title;
      const beneath = commit.body || (fallback ? `_${fallback}_` : '');
      if (beneath) lines.push('', beneath);
    }
  }

  if (howToTest) lines.push('', ...renderHowToTestSection(howToTest, branch));

  if (failed.length > 0) {
    lines.push(
      '',
      `## Attempted and failed (${failed.length}) — still In Progress, not in this branch`,
      '',
      ...failed.map((r) => `- ${r.key} — ${r.title ?? '(untitled)'}`),
    );
  }
  lines.push(
    '',
    '## Close-out',
    '',
    'Review this pull request as ONE unit. After merging it, run:',
    '',
    '```',
    `motir done --session ${branch}`,
    '```',
    '',
    'That flips every item recorded on the branch to Done and clears the recorded',
    'branch. If the pull request is rejected instead, the items honestly stay In',
    'Review — flip them back or re-dispatch them.',
  );
  return lines.join('\n');
}

/**
 * The `## How to test` section of a session pull request body (Story MOTIR-4906 ·
 * MOTIR-5358), rendered from the run target's CURRENT record — its rich-text body
 * verbatim, the same record the item page shows, so the two cannot disagree. §9's 2026-09-13 amendment
 * keeps this section in the body; the record is what Motir renders, the body is
 * what a reviewer on the host reads.
 *
 * Every body carries the whole run's text, followed by THIS repository's fetch.
 */
export function renderHowToTestSection(
  howToTest: { targetKey: string; record: HowToTestRecord | null; repoName: string | null },
  branch: string,
): string[] {
  const { targetKey, record } = howToTest;
  if (!record) {
    return [
      '## How to test',
      '',
      `No run has written How to test onto ${targetKey} — nothing to follow here yet.`,
    ];
  }
  // The agent's rich text VERBATIM — its own sections and fenced commands — so the
  // body and the item page render one record. Its `##` headings sit under this
  // section's; GitHub renders them as written. Then THIS repository's branch fetch,
  // which Motir composes and the agent was told not to write.
  return [
    '## How to test',
    '',
    `Written onto ${targetKey} by the run.`,
    '',
    record.bodyMd,
    '',
    '```sh',
    `git fetch origin ${branch} && git checkout ${branch}`,
    '```',
  ];
}

const SUMMARY_HEADERS = ['ITEM', 'OUTCOME', 'TIME', 'BRANCH', 'TITLE'];

/** The end-of-run summary block: the dispatch table, then everything the run
 *  did NOT do — which is the half a human has to act on. */
export function renderAutoSummary(summary: AutoSummary, titleWidth = 44): string {
  const blocks: string[] = [];
  blocks.push(
    summary.stopReason === 'gated' && summary.gatedOn && summary.gatedOn.length > 0
      ? `Run ${summary.runId} — stopped at a gate — waiting on ${summary.gatedOn.join(', ')}.`
      : `Run ${summary.runId} — stopped: ${STOP_LABEL[summary.stopReason]}.`,
  );

  if (summary.records.length === 0) {
    blocks.push('No work items were dispatched.');
  } else {
    const rows = summary.records.map((r) => [
      r.key,
      OUTCOME_LABEL[r.outcome] + (r.detail ? ` (${r.detail})` : ''),
      formatDuration(r.durationMs),
      r.sessionBranch ?? '—',
      truncate(r.title ?? '', titleWidth),
    ]);
    blocks.push(formatTable(SUMMARY_HEADERS, rows));
  }

  for (const reason of [
    'needs_planning',
    'needs_human',
    'claim_refused',
    'blocked_in_scope',
  ] as const) {
    const group = summary.skipped.filter((s) => s.reason === reason);
    if (group.length === 0) continue;
    if (reason === 'needs_human') {
      blocks.push(...renderManualSkipGroups('Skipped', group, titleWidth));
      continue;
    }
    blocks.push(
      [
        `Skipped — ${SKIP_LABEL[reason]} (${group.length}):`,
        ...group.map((s) => `  ${s.key} — ${truncate(s.title ?? '', titleWidth)}`),
      ].join('\n'),
    );
  }

  blocks.push(...renderPlanningBlocks(summary.planning, titleWidth));

  const landed = summary.records.filter(landedWork);
  if (landed.length > 0) {
    blocks.push(
      [
        // Implemented, not In Review: the cards are built and pushed, and CI is
        // what promotes them (MOTIR-3006). Saying "awaiting your merge" here
        // would teach the operator that the run finished the lifecycle, which is
        // the mental model this story exists to correct.
        `Implemented — CI decides when these become reviewable (${landed.length}):`,
        ...landed.map((r) => `  ${r.key} on ${r.sessionBranch ?? '(no branch recorded)'}`),
      ].join('\n'),
    );
  }

  const failed = summary.records.filter((r) => r.outcome === 'failed');
  if (failed.length > 0) {
    blocks.push(
      [
        `Failed — still In Progress, nothing reverted (${failed.length}):`,
        ...failed.map((r) => `  ${r.key} — re-run it with \`motir run ${r.key}\``),
      ].join('\n'),
    );
  }

  if (summary.approvals.length > 0) {
    blocks.push(
      [
        // Named PLAN BY PLAN, with the card each was approved FOR. A count would
        // tell an operator that their tree moved without telling them where.
        `Plans APPROVED by this run — your tree changed while you were away (${summary.approvals.length}):`,
        ...summary.approvals.map(
          (a) =>
            `  ${a.planId} — approved for ${a.key}, ${a.proposalCount} proposal${a.proposalCount === 1 ? '' : 's'} materialized`,
        ),
        '  Each item that was re-planned is held out of THIS run; re-run to pick the new work up.',
      ].join('\n'),
    );
  }

  blocks.push(...renderLaneBlocks(summary.lanes));

  const replanned = summary.records.filter((r) => r.outcome === 'replanned');
  if (replanned.length > 0) {
    blocks.push(
      [
        // Named as an OUTCOME the run produced, not as a shortfall — and it says
        // what is now waiting for the operator, because the plan is the thing
        // they have to act on and it is not in this terminal.
        `Re-planned — refused by their agent, left in Planning (${replanned.length}):`,
        ...replanned.map((r) => {
          // Do not tell the operator to review a plan this run already approved
          // — the approvals block above says what happened to it.
          const approved = summary.approvals.some((a) => a.key === r.key);
          return approved
            ? `  ${r.key} — its plan was approved by this run (above); the item itself stays in Planning`
            : `  ${r.key} — review the submitted plan in Motir, then re-run it`;
        }),
        '  Nothing was recorded for these: no branch, no pull request, no status moved by this run.',
      ].join('\n'),
    );
  }

  blocks.push(...renderOutstandingBlock(summary.outstanding));

  if (summary.prs.length > 0) {
    blocks.push(['Pull requests:', ...summary.prs.map(prLine)].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * The children that kept this run's pull requests in DRAFT (MOTIR-4967).
 *
 * ⚠️ IT NAMES THEM, AND IT PRESCRIBES NOTHING. Its predecessor
 * (`renderOpenChildrenHold`) offered an operator three dispositions, because a
 * hold was a decision the run had made on their behalf and they had to undo it
 * to proceed. Nothing has been decided here: the work is pushed, the pull request
 * exists, CI is running on it, and the only thing missing is the children. Re-run
 * the container and the same close-out marks it ready.
 */
function renderOutstandingBlock(outstanding: AutoSummary['outstanding']): string[] {
  if (!outstanding || outstanding.keys.length === 0) return [];
  return [
    [
      `${outstanding.containerKey} is NOT finished — ${outstanding.keys.length} of its children ` +
        `${outstanding.keys.length === 1 ? 'has' : 'have'} not landed:`,
      ...outstanding.keys.map((key) => `  ${key} — not implemented`),
      'Its pull requests stay DRAFTS until they do, so nothing can merge and claim the container is',
      `built. The work IS pushed — re-run \`motir run ${outstanding.containerKey}\` to pick these up,`,
      'or re-parent them out if they are no longer in its scope.',
    ].join('\n'),
  ];
}

/**
 * The LANE section (MOTIR-4085): which lane each submitted re-plan went down,
 * whether it was approved, what fell out when it was not, and what the run then
 * did.
 *
 * ⚠️ THE DECLINES ARE WHY THIS BLOCK EXISTS. An approval already has a block of
 * its own — the tree changed, and that is the loudest thing a run can do
 * unattended. A DECLINE changes nothing, which is exactly why it would otherwise
 * be invisible: an operator would read a run that stopped with no approvals and
 * no explanation, and could not tell a loop that was never asked from a loop that
 * was asked and said no.
 *
 * ⚠️ AND IT SAYS "NOT A FAILURE" IN THE HEADING, not in a footnote. A declined
 * lane and an elected one are both the bound working — the plan is submitted,
 * intact and waiting for a person. An operator who reads them as errors learns to
 * distrust the one signal the flag depends on.
 */
function renderLaneBlocks(lanes: ReplanLaneRecord[]): string[] {
  if (lanes.length === 0) return [];
  const blocks: string[] = [];

  const declined = lanes.filter((l) => l.lane === 'declined_out_of_lane');
  if (declined.length > 0) {
    const lines = [
      `Re-plans NOT auto-approved — wider than the card's own lane, so a person decides` +
        ` (${declined.length}). Not a failure:`,
    ];
    for (const record of declined) {
      lines.push(`  ${record.key}${record.planId ? ` — plan ${record.planId}` : ''}`);
      for (const out of record.outOfLane ?? []) lines.push(`      ${out}`);
    }
    lines.push('  Review each plan in Motir, then re-run the card if the corrected one survives.');
    blocks.push(lines.join('\n'));
  }

  const elsewhere = lanes.filter((l) => l.lane === 'anchored_elsewhere');
  if (elsewhere.length > 0) {
    blocks.push(
      [
        `Re-plans anchored ELSEWHERE — the agent elected the lane that goes to a person` +
          ` (${elsewhere.length}). Not a failure:`,
        ...elsewhere.map((r) => `  ${r.key} — ${r.detail ?? 'no plan is anchored at this card'}`),
        '  The plan is about a container, or about a precondition no card names yet.',
      ].join('\n'),
    );
  }

  const unreadable = lanes.filter((l) => l.lane === 'unreadable');
  if (unreadable.length > 0) {
    blocks.push(
      [
        // ⚠️ THIS ONE IS NOT REASSURED. The run stopped because it could not SEE
        // what it was being asked to approve, which is the one arm where the
        // operator has something to check rather than something to read.
        `Re-plans this run could NOT read, so it approved nothing (${unreadable.length}):`,
        ...unreadable.map((r) => `  ${r.key} — ${r.detail ?? 'the plan could not be read'}`),
      ].join('\n'),
    );
  }

  // The refresh rides the APPROVAL rows, beside the approvals block rather than
  // inside it: that block is about the tree, this is about the run's own queue.
  const refreshed = lanes.filter((l) => l.refresh && !isEmptyRefresh(l.refresh));
  if (refreshed.length > 0) {
    const lines = [`Queue refreshed after an approved re-plan (${refreshed.length}):`];
    for (const record of refreshed) {
      const refresh = record.refresh as ReplanRefresh;
      lines.push(`  ${record.key} — re-read ${refresh.parentKey ?? 'no parent'}'s children`);
      if (refresh.removed.length > 0) {
        lines.push(`      removed by the plan, NOT run: ${refresh.removed.join(', ')}`);
      }
      if (refresh.added.length > 0) {
        lines.push(`      added by the plan, run when ready: ${refresh.added.join(', ')}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks;
}

function isEmptyRefresh(refresh: ReplanRefresh): boolean {
  return refresh.removed.length === 0 && refresh.added.length === 0;
}

/**
 * The planning section: what `--include-planning` fired, and what it did NOT do.
 *
 * The "awaiting your approval" wording is load-bearing, not decoration. A run
 * that printed "expanded ACME-5" would be claiming work items it never created
 * — the exact misreading the tool's own description guards against — so every
 * triggered line says out loud that a human's approval stands between this plan
 * and any subtask.
 */
function renderPlanningBlocks(planning: PlanningRecord[], titleWidth: number): string[] {
  const blocks: string[] = [];
  const triggered = planning.filter((p) => p.outcome === 'triggered');
  const failed = planning.filter((p) => p.outcome === 'failed');

  if (triggered.length > 0) {
    blocks.push(
      [
        `Planning triggered — awaiting your approval (${triggered.length}):`,
        ...triggered.map(
          (p) =>
            `  ${p.key} — ${truncate(p.title ?? '', titleWidth)}\n` +
            `    plan ${p.planId ?? '(id not returned)'}${p.reviewUrl ? ` — ${p.reviewUrl}` : ''}`,
        ),
        '  These are PROPOSALS. Nothing was added to the plan: approve them in Motir',
        '  and their subtasks join a later run like any other ready work.',
      ].join('\n'),
    );
  }

  if (failed.length > 0) {
    blocks.push(
      [
        `Planning failed — still unexpanded (${failed.length}):`,
        ...failed.map((p) => `  ${p.key} — ${p.detail ?? 'the expansion was refused'}`),
      ].join('\n'),
    );
  }
  return blocks;
}

function prLine(pr: PrReport): string {
  const repo = pr.repoName ?? 'the checkout';
  // ⚠️ THE DRAFT IS SAID ON THE PR LINE, not only in the outstanding block
  // below: a reader who skims to "Pull requests:" is deciding whether there is
  // something to merge, and a draft is not.
  const draft = pr.draft ? ' — still a DRAFT' : '';
  const why = pr.draft && pr.message ? `\n    ${pr.message}` : '';
  switch (pr.outcome) {
    case 'opened':
      return `  ${repo}: ${pr.url ?? pr.branch} (opened${draft})${why}`;
    case 'existing':
      return `  ${repo}: ${pr.url ?? pr.branch} (already open — updated by this run${draft})${why}`;
    case 'empty':
      return `  ${repo}: no pull request — ${pr.branch} carries no commits beyond main.`;
    case 'failed':
      return (
        `  ${repo}: NOT opened. ${pr.message ?? ''}\n` +
        `    The work IS pushed to ${pr.branch} — open the pull request by hand, then ` +
        `\`motir done --session ${pr.branch}\`.`
      );
  }
}

/** The process exit code for a finished run: non-zero when anything needs the
 *  human's attention as a FAILURE (an interrupted run included).
 *
 *  DISPATCH outcomes only — `summary.planning` is deliberately not read. A failed
 *  expansion is non-halting (nothing in the run depended on it), so letting it
 *  redden the exit code would fail a run whose every dispatch succeeded. */
export function autoExitCode(summary: AutoSummary): number {
  if (summary.records.some((r) => r.outcome === 'failed')) return 1;
  if (summary.stopReason === 'interrupted') return 130;
  return 0;
}
