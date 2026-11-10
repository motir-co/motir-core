import {
  withPlanningOverlay,
  type PlanningEntrance,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';
import type { ReaderRoutes } from '@/lib/visitor/routes';
import type { PlanStatusDto } from '@/lib/dto/plans';

// WHERE A PLAN'S ROW GOES — ONE rule, both lists (Story MOTIR-6043 · MOTIR-6045;
// `design/ai-planning/design-notes.md` Part XXI; ADR `approval-gates.md` §11.5b).
//
// Two surfaces list the same plans — the Plans page's session rows and the
// workbench's To-approve rows — and before this module each decided for itself
// where a row should lead. That is the duplicated sentence this file exists to
// delete: a person opening one plan from two places must land in one place.
//
// ── THE RULE, and the ONE thing it keys on ──────────────────────────────────
// An UNDECIDED plan is a live thing: it is read beside the conversation that can
// change it, so its row opens the PLANNING SURFACE. A DECIDED plan is a record,
// so its row opens the plan's own page. A plan with NO SESSION cannot happen any
// more (below), and if one does it degrades to the page with no copy at all.
//
// ⚠️ THE PREDICATE IS THE SESSION'S EXISTENCE — never its ORIGIN, and never
// whether it holds TURNS. Both of those readings were tried and both are wrong:
//
//   · `docs/decisions/mcp-authored-plan-review.md` overturned the TURNS reading.
//     *"An empty transcript is not an absent conversation … `has a session` and
//     `has turns` are different questions, and it is the first that says whether
//     there is a planning phase to watch."* An agent writing through the MCP
//     holds its conversation in its own harness, and Motir sees no turns; the
//     planning phase is still there to watch and decide.
//   · The ORIGIN reading is that same mistake one door over. A `cadence` session
//     (`agent-authored-plans.md` AMENDMENT 17 §4) and a backfilled `legacy` one
//     (§5) are the same shape as an `mcp` one — a session exists, the transcript
//     may be empty — and Motir AI is on the surface for any of them. An undecided
//     cadence plan is the case where a person most wants to argue with the
//     planner, because nobody asked for it.
//
// ⚠️ A NULL SESSION IS AN INVARIANT BREACH, NOT A POPULATION (Story MOTIR-7883 ·
// MOTIR-7885, 2026-10-08). `createPlan` attaches a session in the same transaction
// (MOTIR-6022) and MOTIR-6020 backfilled every older plan, so `Plan.sessionId IS
// NULL` is only the rollout residue `prisma/schema.prisma` names: *"NULLABLE AT THE
// DATABASE only so a build predating this column can still write a plan during a
// rollout."* The branch stays because nothing at the database enforces the
// non-null; it answers `'no-session'`, and no surface renders a reason for it.
// (Until this story the arm carried a reason two renderers explained to a reader,
// which made it a sanctioned second road to deciding a plan outside the overlay.)
//
// ── TOTAL over `PlanStatus`, with NO default arm ────────────────────────────
// The switch below answers every member and falls through to nothing. A sixth
// plan status is then a compile error here rather than a silent fall-through to
// the plan page — which is the failure mode a `default` would hide, and the one
// a rule shared by two surfaces can least afford.

/** WHY a row lands on the plan page — the two are not interchangeable to a reader. */
export type PlanPageReason =
  /** The plan is `approved` or `declined`: there is nothing left to decide. */
  | 'decided'
  /**
   * THE INVARIANT BREACH (MOTIR-7885, Story MOTIR-7883). `Plan.sessionId` is nullable
   * at the database only for rollout; a plan reaching this arm degrades to its page
   * and NOTHING renders a reason for it.
   */
  | 'no-session'
  /** The reader is a Visitor (MOTIR-6888): the planning workspace is not served to one. */
  | 'visitor';

/** Where a plan's row goes, and — for the page — why. */
export type PlanRowDestination =
  | { kind: 'planning-surface'; href: string }
  | { kind: 'plan-page'; href: string; reason: PlanPageReason };

export interface PlanRowDestinationInput {
  /** The plan's status. With the session below, the whole of the rule's input. */
  planStatus: PlanStatusDto;
  /** The plan's id — `/plans/<id>` is the page href. */
  planId: string;
  /**
   * The plan's SESSION. `null` is the invariant breach above — nullable at the
   * database for rollout only — and lands on the plan page with no copy.
   *
   * ⚠️ Neither the session's ORIGIN nor its TURN COUNT is an input, and that is
   * asserted by this signature rather than left to a comment: a caller cannot
   * pass one, so a future reader cannot quietly reintroduce either reading.
   */
  sessionId: string | null;
  /**
   * The address the ROW SITS ON — the planning surface is an overlay, so its
   * href is this page plus the overlay's parameters, and Close returns to
   * exactly the list the reader left (filter and scroll intact).
   */
  host: string;
  /** The session's first anchor key; absent / null means a project-wide session. */
  anchorKey?: string | null;
  /** Which list the row is in — only To approve sets it, for the reopened line. */
  via?: PlanningEntrance;
  /**
   * The reader's addresses (MOTIR-6888). On the Visitor route tree the row always
   * lands on the plan's Visitor page: the planning workspace is not served there,
   * and a Visitor decides nothing. Absent means a member reader.
   */
  routes?: ReaderRoutes;
}

/**
 * The overlay context a session opens at: anchored at its first key, else
 * project-wide. Exported (MOTIR-7884) so every door that turns a session into an
 * overlay address — the approval overlay's plan forward among them — asks this
 * one function rather than restating the ternary.
 */
export function planSessionLaunchContext(
  sessionId: string,
  anchorKey: string | null | undefined,
  via: PlanningEntrance | undefined,
): PlanningLaunchContext {
  return anchorKey
    ? { kind: 'work-item', itemKey: anchorKey, sessionId, ...(via ? { via } : {}) }
    : { kind: 'project', sessionId, ...(via ? { via } : {}) };
}

/**
 * WHERE THIS PLAN'S ROW GOES. Pure: both a server component (the Plans row) and
 * a client component (the To-approve row) call it with the same three facts.
 *
 * The surface href is composed through {@link withPlanningOverlay} rather than
 * assembled here, so the `planSession` / `planVia` address has ONE author and a
 * change to it reaches both lists at once.
 */
export function planRowDestination({
  planStatus,
  planId,
  sessionId,
  host,
  anchorKey,
  via,
  routes,
}: PlanRowDestinationInput): PlanRowDestination {
  const planPage = routes ? routes.plan(planId) : `/plans/${encodeURIComponent(planId)}`;
  if (routes && routes.identifier !== null) {
    return { kind: 'plan-page', href: planPage, reason: 'visitor' };
  }

  switch (planStatus) {
    case 'generating':
    case 'planned':
    case 'approving':
    case 'stale':
      // UNDECIDED — `approving` too (Bug MOTIR-9006): the overlay is where its progress
      // is drawn until the approval commits. The session is the whole test.
      return sessionId === null
        ? { kind: 'plan-page', href: planPage, reason: 'no-session' }
        : {
            kind: 'planning-surface',
            href: withPlanningOverlay(host, planSessionLaunchContext(sessionId, anchorKey, via)),
          };
    case 'approved':
    case 'declined':
      // DECIDED — a record, whatever its conversation holds.
      return { kind: 'plan-page', href: planPage, reason: 'decided' };
  }
}

/**
 * WHERE AN OPEN SESSION'S HOLD GOES (AMENDMENT 23 §5; MOTIR-7640) — the session
 * form of {@link planRowDestination}, for the held line's **Open the session**
 * door. A session hold has no plan, so it has no plan page to fall back to: a
 * member lands on the planning surface on that session; a Visitor — to whom the
 * planning workspace is not served — gets `null`, and the door is not drawn.
 */
export function sessionHoldDestination({
  sessionId,
  host,
  anchorKey,
  routes,
}: {
  sessionId: string;
  host: string;
  anchorKey?: string | null;
  routes?: ReaderRoutes;
}): { kind: 'planning-surface'; href: string } | null {
  if (routes && routes.identifier !== null) return null;
  return {
    kind: 'planning-surface',
    href: withPlanningOverlay(host, planSessionLaunchContext(sessionId, anchorKey, undefined)),
  };
}
