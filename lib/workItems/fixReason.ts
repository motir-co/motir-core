import type { ApprovalGate } from '@/generated/prisma/client';
import type { FixBranchDto, FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { RunDiedReason, WorkItemContinueRefusal } from '@/lib/dto/workItemContinue';
import type { RepairPullRequestDto } from '@/lib/dto/workItemRepair';
import { routedToDisplayName } from '@/lib/approvalGates/routing';

// THE PURE HALF of a card's to-fix answer (Story MOTIR-6588 · MOTIR-6600). The reads
// live in `fixReasonService`; everything here is a function of what they returned, so
// the priority and the detail can be pinned without a database.

/**
 * The reasons in PRIORITY order — the first that holds is the one to repair first
 * and the one stored. It is also the enum's declaration order (`WorkItemFixReason`),
 * and a test asserts the two are the same list.
 *
 * Why this order: a dead run comes first because nothing else on the card can be
 * repaired until somebody owns its branch again — a red check or a conflict on that
 * branch is fixed BY the continue (`design/workbench/design-notes.md` § 31). A queue failure and a conflict both mean the members cannot land AS
 * THEY ARE, and a green re-run fixes neither; a member out of date with a base that
 * requires it (MOTIR-10054) is the same shape, answered by a push that merges the base;
 * a red build usually shares a cause with them and is re-judged by the same push; a reviewer's refusal is last because a push
 * that answers any of the first three also withdraws what they were refusing.
 */
export const FIX_REASON_PRIORITY: readonly WorkItemFixReasonDto[] = [
  'run_died',
  'queue_failed',
  'conflicted',
  'out_of_date',
  'ci_failed',
  'changes_requested',
];

/** How long a reviewer's note may run in the row's reason line. */
export const FIX_NOTE_PREVIEW_MAX = 140;

/** The stored answer: both columns, `null` together when there is nothing to repair. */
export interface FixReasonValue {
  fixReason: WorkItemFixReasonDto | null;
  fixDetail: FixDetailDto | null;
}

export const NOTHING_TO_FIX: FixReasonValue = { fixReason: null, fixDetail: null };

const EMPTY_DETAIL: Omit<FixDetailDto, 'repair' | 'affected' | 'total'> = {
  groupKey: null,
  check: null,
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  lastHeardAt: null,
  ranByName: null,
  branch: null,
  branches: null,
  pushed: null,
  continueKey: null,
  diedReason: null,
};

/**
 * The first non-empty line of a reviewer's note, trimmed and cut to
 * {@link FIX_NOTE_PREVIEW_MAX} characters with an ellipsis; null when there is none.
 */
export function notePreviewOf(noteMd: string | null): string | null {
  const line = (noteMd ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > FIX_NOTE_PREVIEW_MAX ? `${line.slice(0, FIX_NOTE_PREVIEW_MAX - 1)}…` : line;
}

/**
 * What `deadRunReasonOf` reads — the continue service's `died` verdict
 * (`evaluateContinueWithin`), with the dead run's facts as the continue VIEW states them
 * (`describeDeadRunWithin`), so the row and the marker cannot name two different runs.
 */
export interface DeadRunVerdict {
  /** The card's own key. */
  key: string;
  /** What the continue claim would answer — null when it would take the card. */
  refusal: Exclude<WorkItemContinueRefusal, 'run_alive' | 'no_dead_run'> | null;
  /** Set with `continue_the_parent`: the parent run's scope. */
  parentKey: string | null;
  branch: string | null;
  branches: readonly FixBranchDto[];
  /** ISO-8601 — the view's `deadRun.lastHeardAt`. */
  lastHeardAt: string;
  /** The view's `deadRun.dispatcher.name`; null for a deleted account. */
  ranByName: string | null;
  diedReason: RunDiedReason;
}

// ── THE ENTRY A STUCK CARD BELONGS TO (MOTIR-7589; `design/workbench/design-notes.md`
// § 34.2) ─────────────────────────────────────────────────────────────────────────────
// Cards stuck for one reason that ONE repair clears are one To fix ENTRY. The key is
// stored with the reason (`fixDetail.groupKey`) by the same recompute, so the tab can
// group, page and count entries over the per-card column without a second stored truth.
//
//   `run:<DispatchRun.id>`  — `run_died`: every card the dead run carried.
//   `prs:<hash>`            — a pull-request reason, or a review's Request changes on the
//                             approve-and-merge gate / by the review agent: every card the
//                             same open pull requests deliver.
//   `card:<WorkItem.id>`    — an acceptance Re-run, and every row stored before the key
//                             existed (the read's `COALESCE` fallback). A card alone.

/** The three kinds of entry key — the prefix before the first `:`. */
export type FixGroupKind = 'run' | 'prs' | 'card';

export function runFixGroupKey(dispatchRunId: string): string {
  return `run:${dispatchRunId}`;
}

export function cardFixGroupKey(workItemId: string): string {
  return `card:${workItemId}`;
}

/** The PREFIX a pull-request set's key carries; the hash is the service's (it needs
 *  `node:crypto`, and this module is imported by client components). */
export const PULL_REQUEST_GROUP_PREFIX = 'prs:';

/** Which kind of entry a key names. An unrecognised key reads as `card`: a card alone
 *  is the one shape that can never merge two cards by mistake. */
export function fixGroupKindOf(groupKey: string): FixGroupKind {
  if (groupKey.startsWith('run:')) return 'run';
  if (groupKey.startsWith(PULL_REQUEST_GROUP_PREFIX)) return 'prs';
  return 'card';
}

/**
 * The entry a stored row belongs to — its `fixDetail.groupKey`, or `card:<id>` when the
 * row was stored before the key existed. The SAME fallback the grouped read's SQL
 * (`COALESCE("fixDetail"->>'groupKey', 'card:' || id)`) applies, stated once for the
 * readers that group in memory.
 */
export function fixGroupKeyOf(row: { id: string; fixDetail: unknown }): string {
  const stored =
    row.fixDetail !== null && typeof row.fixDetail === 'object' && !Array.isArray(row.fixDetail)
      ? (row.fixDetail as Record<string, unknown>).groupKey
      : null;
  return typeof stored === 'string' && stored.length > 0 ? stored : cardFixGroupKey(row.id);
}

/** The same answer with its entry key set. `NOTHING_TO_FIX` stays nothing. */
export function withFixGroupKey(value: FixReasonValue, groupKey: string): FixReasonValue {
  if (value.fixDetail === null) return value;
  return { ...value, fixDetail: { ...value.fixDetail, groupKey } };
}

/** A card in an entry, as the head rule reads it. */
export interface FixGroupMember {
  id: string;
  identifier: string;
  key: number;
  parentId: string | null;
}

/**
 * The HEAD of a pull-request entry (§ 34.2): the member that is an ANCESTOR of every
 * other member — the story whose legs share its pull requests — else the lowest key.
 * Ancestry is followed through the members' own `parentId`s, which is the shape a
 * story or sprint run delivers (a run target and the leaves under it).
 */
export function pullRequestGroupHead<M extends FixGroupMember>(members: readonly M[]): M | null {
  if (members.length === 0) return null;
  const byId = new Map(members.map((m) => [m.id, m]));
  const isAncestorOf = (ancestor: M, of: M): boolean => {
    const seen = new Set<string>();
    let at = of.parentId;
    while (at !== null && !seen.has(at)) {
      if (at === ancestor.id) return true;
      seen.add(at);
      at = byId.get(at)?.parentId ?? null;
    }
    return false;
  };
  const ancestor = members.find((m) => members.every((o) => o === m || isAncestorOf(m, o)));
  if (ancestor && members.length > 1) return ancestor;
  return [...members].sort((a, b) => a.key - b.key)[0]!;
}

/**
 * The order an entry lists its members in (§ 34.2 / § 34.4): the ones the READER holds
 * first, so the fold never hides why the entry is on their tab, then the entry's own
 * order — the run's leg positions for `run:`, the key for everything else.
 */
export function orderFixGroupMembers<M extends FixGroupMember>(
  members: readonly M[],
  heldByReader: (member: M) => boolean,
  position: (member: M) => number | null,
): M[] {
  return [...members].sort((a, b) => {
    const held = Number(heldByReader(b)) - Number(heldByReader(a));
    if (held !== 0) return held;
    const pa = position(a);
    const pb = position(b);
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    if (pa !== null && pb === null) return -1;
    if (pa === null && pb !== null) return 1;
    return a.key - b.key;
  });
}

/**
 * A DEAD RUN's reason, or null when the verdict is one `motir continue` does not own.
 *
 * Exactly three refusals are `run_died` (§ 31's premise): none — the claim would take
 * the card, so `continue` on its own key; `continue_the_parent` — `continue` on the
 * PARENT's key, the whole run resumes; `no_branch` — nothing was pushed, so there is no
 * command at all (`none`) and the card has to start over. `use_fix` falls to the
 * pull-request reasons (`motir fix` owns a card at Implemented and later), and
 * `not_in_progress` has nothing to repair.
 *
 * `affected` / `total` are 0: a dead run is not a pull-request fact, and no surface
 * draws the *N of M* clause for it.
 */
export function deadRunReasonOf(verdict: DeadRunVerdict): FixReasonValue | null {
  const { refusal } = verdict;
  if (refusal === 'use_fix' || refusal === 'not_in_progress') return null;
  if (refusal === 'continue_the_parent' && verdict.parentKey === null) return null;
  const nothingPushed = refusal === 'no_branch';
  return {
    fixReason: 'run_died',
    fixDetail: {
      ...EMPTY_DETAIL,
      repair: nothingPushed ? 'none' : 'continue',
      lastHeardAt: verdict.lastHeardAt,
      ranByName: verdict.ranByName,
      branch: verdict.branch,
      branches: verdict.branches.map((b) => ({ repository: b.repository, branch: b.branch })),
      pushed: !nothingPushed,
      continueKey: nothingPushed
        ? null
        : refusal === 'continue_the_parent'
          ? verdict.parentKey
          : verdict.key,
      diedReason: verdict.diedReason,
      affected: 0,
      total: 0,
    },
  };
}

/**
 * The PULL-REQUEST reason of a set of members the repair predicate handed over, or
 * null when none of them is failing.
 *
 * Each member is classed by the SAME three facts the predicate admitted it on —
 * `queueExit` (a standing queue failure at its head), `conflicted`, `outOfDate`, and its
 * own `ci` —
 * so a member is never listed for a reason the predicate did not see. `affected` counts
 * the members carrying the stored reason; `total` is every open member.
 */
export function pullRequestReasonOf(
  members: readonly RepairPullRequestDto[],
  total: number,
): FixReasonValue | null {
  const queued = members.filter((m) => m.queueExit !== null);
  if (queued.length > 0) {
    const exit = queued[0]!.queueExit!;
    return {
      fixReason: 'queue_failed',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        check: exit.failingCheckName,
        queueReason: exit.rawReason,
        affected: queued.length,
        total,
      },
    };
  }
  const conflicted = members.filter((m) => m.conflicted);
  if (conflicted.length > 0) {
    return {
      fixReason: 'conflicted',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        base: conflicted[0]!.baseRef,
        affected: conflicted.length,
        total,
      },
    };
  }
  const behind = members.filter((m) => m.outOfDate);
  if (behind.length > 0) {
    return {
      fixReason: 'out_of_date',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        base: behind[0]!.baseRef,
        affected: behind.length,
        total,
      },
    };
  }
  const red = members.filter((m) => m.ci === 'failing');
  if (red.length > 0) {
    return {
      fixReason: 'ci_failed',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        check: red[0]!.failingChecks[0] ?? null,
        affected: red.length,
        total,
      },
    };
  }
  return null;
}

/**
 * The reviewer label a REVIEW AGENT's refusal carries on the To fix row (Story MOTIR-1626 ·
 * MOTIR-6819; `approval-gates.md` §12.4 — *the review agent as the decider*). A constant
 * rather than the run's attributed user: the row must not claim a person reviewed the
 * code (§12.3). The surfaces translate it (MOTIR-6823 / MOTIR-6825 own the en/zh copy).
 */
export const REVIEW_AGENT_REVIEWER_NAME = 'Review agent';

/**
 * A REFUSAL the card is still waiting on — `changes_requested`, from the gate the
 * reviewer decided.
 *
 * `repair` follows what `motir fix` would do with it, and it is `fix` for EVERY gate: an
 * acceptance Re-run is a repair class of its own (`acceptance_rerun`), and so is a card a
 * REVIEW sent back — the review agent's refusal (`approval-gates.md` §12.4) or a person's
 * approve-and-merge Request changes (§12.7) — the `review` class (MOTIR-6822), whose
 * prompt carries the findings in full.
 *
 * ⚠️ NEVER `run` AGAIN. It was `run` for the approve-and-merge gate until §12.7, and `run`
 * cannot repair it: a sent-back card sits in the in-progress category, and both claim
 * doors take only the to-do category (`lib/workItems/claimOutcome.ts`).
 */
export function changesRequestedOf(
  refusal: {
    gate: 'pull_request_approval' | 'acceptance_result' | 'agent_review';
    /** The reviewer as a SURFACE draws them — `reviewerNameOf`, never the audit label. */
    reviewerName: string | null;
    noteMd: string | null;
  },
  total: number,
): FixReasonValue {
  return {
    fixReason: 'changes_requested',
    fixDetail: {
      ...EMPTY_DETAIL,
      repair: 'fix',
      reviewerName: refusal.reviewerName,
      notePreview: notePreviewOf(refusal.noteMd),
      gate: refusal.gate,
      affected: total,
      total,
    },
  };
}

/**
 * The reviewer's name as the To fix row draws it.
 *
 * ⚠️ NOT `decidedByLabel` AS STORED. That column is the gate's AUDIT string —
 * `Name <email>`, denormalised at decision time so an auditor can resolve a person
 * who has since gone (`lib/approvalGates/routing.ts`) — and an email in the middle of
 * the row's sentence is noise. The live user row answers first, through the same
 * `routedToDisplayName` a routed name uses; a reviewer whose row no longer resolves
 * falls back to the audit label with its `<email>` suffix removed.
 */
export function reviewerNameOf(
  user: { name: string; email: string } | null,
  decidedByLabel: string | null,
): string | null {
  const live = routedToDisplayName(user);
  if (live) return live;
  if (decidedByLabel === null) return null;
  return decidedByLabel.replace(/\s*<[^<>]*>\s*$/, '').trim() || decidedByLabel;
}

/**
 * Does `latest` — the card's most recently DECIDED gate of any kind — still stand as an
 * approve-to-merge Request changes over the set as it is NOW?
 *
 * It is `approvalGatesService.latestRefusalFor`'s question (the last thing a person
 * decided about this card, across kinds), narrowed two ways. To the
 * `pull_request_approval` kind, because a refused design or decision is not a repair of
 * the pull requests. And to a refusal whose `subjectVersion` still names the members'
 * CURRENT heads: a new commit is the answer to a refusal, so from that commit on the
 * card waits on CI like any other, and a set with an unknown head (`currentVersion`
 * null) has no version a refusal could still be about.
 */
export function standingMergeRefusalOf(
  latest: Pick<ApprovalGate, 'kind' | 'state' | 'subjectVersion'> | null,
  currentVersion: string | null,
): boolean {
  // ⚠️ …OR THE REVIEW AGENT'S (MOTIR-6819; `approval-gates.md` §12.4). Its refusal is
  // about exactly the commits the approve-and-merge gate asks about (§12.1's one stamp),
  // moves no status, and is answered the same way — a push, which changes the version and
  // so clears it here.
  if (
    latest === null ||
    (latest.kind !== 'pull_request_approval' && latest.kind !== 'agent_review')
  ) {
    return false;
  }
  if (latest.state !== 'changes_requested') return false;
  return currentVersion !== null && latest.subjectVersion === currentVersion;
}

/** The detail's fields, in one fixed order — what {@link sameFixReason} compares. */
const FIX_DETAIL_FIELDS = [
  'groupKey',
  'repair',
  'check',
  'queueReason',
  'base',
  'reviewerName',
  'notePreview',
  'gate',
  'lastHeardAt',
  'ranByName',
  'branch',
  'pushed',
  'continueKey',
  'diedReason',
  'affected',
  'total',
] as const satisfies readonly (keyof FixDetailDto)[];

/** Two stored branch lists are the same — compared entry by entry, for the reason
 *  {@link sameFixReason} gives (a `jsonb` object never stringifies as written). */
function sameBranches(stored: unknown, next: readonly FixBranchDto[] | null): boolean {
  if (next === null) return (stored ?? null) === null;
  if (!Array.isArray(stored) || stored.length !== next.length) return false;
  return next.every((b, i) => {
    const s = stored[i] as { repository?: unknown; branch?: unknown } | null;
    return s !== null && (s.repository ?? null) === b.repository && s.branch === b.branch;
  });
}

/**
 * Two stored answers are the same — the recompute writes only when this is false.
 *
 * ⚠️ FIELD BY FIELD, NEVER BY SERIALISING THE WHOLE OBJECT: the column is `jsonb`, which
 * stores its keys in its own order, so a detail read back never stringifies the way it
 * was written and a string compare would rewrite every card on every event.
 */
export function sameFixReason(
  a: { fixReason: string | null; fixDetail: unknown },
  b: FixReasonValue,
): boolean {
  if (a.fixReason !== b.fixReason) return false;
  if (b.fixDetail === null || a.fixDetail === null || typeof a.fixDetail !== 'object') {
    return (a.fixDetail ?? null) === b.fixDetail;
  }
  const stored = a.fixDetail as Record<string, unknown>;
  return (
    FIX_DETAIL_FIELDS.every((field) => (stored[field] ?? null) === b.fixDetail![field]) &&
    sameBranches(stored.branches, b.fixDetail.branches)
  );
}
