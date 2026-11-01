import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The story's GATE (Story MOTIR-3532 · Subtask MOTIR-3537) — the two things
// neither sibling card's own tests can hold, and which a coverage percentage
// cannot see either.
//
// ── What is HERE, and what deliberately is not ──────────────────────────────
// The card's own rule: *no assertion here duplicates a sibling card's units.*
// So the properties the siblings already prove against real Postgres are NOT
// restated — they are named, with where they live:
//
//   * the revision is TRANSACTIONAL with its mutation (rollback → no row,
//     commit → exactly one), at all six sites → `planRevisions.test.ts`;
//   * the merged timeline interleaves by time, and the collapse rule
//     → `planTimelineMerge.test.ts` (seam) + `plans/timelineMerge.test.ts` (unit);
//   * the LEGACY plan renders unchanged → both of those, and
//     `components/plan-review-rail-content-events.test.tsx` for the render;
//   * the actor in both senses → `planRevisions.test.ts` (write) and
//     `planTimelineMerge.test.ts` (read).
//
// What is left is exactly the assembled-seam work:
//
//   1. **NO PLAN MUTATION ESCAPES THE TRAIL** — derived STRUCTURALLY from the
//      service's own source rather than from a list that rots, so a SEVENTH
//      mutation added later fails this test instead of silently shipping
//      untracked. That is the failure mode the whole story exists to close, and
//      it is the one no percentage can report: a mutation with no revision write
//      has no uncovered line.
//   2. **THE WHOLE SEAM, END TO END** — every one of the six mutations driven in
//      one plan's life, and the result read back through the READ path's DTO.
//      Each card's own units stop at its half; this is where the halves have to
//      agree.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Block 1 · the structural guard ──────────────────────────────────────────

const SERVICE_PATH = join(process.cwd(), 'lib/services/plansService.ts');

/**
 * Every named function body in `plansService.ts` — the module-level declarations
 * AND the methods of the exported service object — keyed by name.
 *
 * Parsed with the TypeScript AST rather than matched with a regular expression,
 * because the property this guard holds is only worth as much as its derivation:
 * a brace-counting scan that silently misses a method reports a clean sweep over
 * a set it never saw.
 */
function functionBodies(): Map<string, ts.Node> {
  const source = ts.createSourceFile(
    SERVICE_PATH,
    readFileSync(SERVICE_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const bodies = new Map<string, ts.Node>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      bodies.set(stmt.name.text, stmt.body);
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'plansService') continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      for (const member of decl.initializer.properties) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
          bodies.set(member.name.text, member.body);
        }
      }
    }
  }
  return bodies;
}

/** Every name this body CALLS — a bare identifier, or the tail of `x.y(...)`. */
function calleeNames(body: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        names.add(callee.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return names;
}

/**
 * What one service method reaches, following in-module delegation.
 *
 * ⚠️ TRANSITIVE, and it has to be: `updateProposal` and `deepenProposal` are
 * one-liners over the shared `editAddProposal`, and `approvePlanForWorkItem`
 * resolves a plan id and hands off to `approvePlan`. A guard that read each
 * method's own body would call three of the service's mutation doors reads and
 * pass while they wrote nothing.
 */
function reaches(entry: string, bodies: Map<string, ts.Node>): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const body = bodies.get(name);
    if (!body) return;
    for (const called of calleeNames(body)) {
      out.add(called);
      if (bodies.has(called)) visit(called);
    }
  };
  visit(entry);
  return out;
}

/**
 * The service's MUTATION doors, derived from the source.
 *
 * The discriminator is `withWorkspaceContext` — the wrapper that opens a write
 * transaction and binds the tenancy GUCs — as against `withWorkspaceServiceContext`,
 * which is this codebase's READ binding. It is a real structural signal rather
 * than a naming convention: every plan write in the file goes through it, and no
 * read does.
 */
function mutationDoors(): { bodies: Map<string, ts.Node>; mutations: string[]; reads: string[] } {
  const bodies = functionBodies();
  const serviceMethods = Object.keys(plansService);
  const mutations: string[] = [];
  const reads: string[] = [];
  for (const name of serviceMethods) {
    if (!bodies.has(name)) continue;
    (reaches(name, bodies).has('withWorkspaceContext') ? mutations : reads).push(name);
  }
  return { bodies, mutations, reads };
}

describe('no plan mutation escapes the trail', () => {
  it('DERIVES the mutation set from the service source, and the derivation discriminates', () => {
    const { mutations, reads } = mutationDoors();

    // Non-vacuity, in both directions. A guard whose derived set is empty passes
    // for ever and tells you nothing; one that classifies EVERYTHING as a
    // mutation passes for the wrong reason. Neither is asserted as a fixed list,
    // because a fixed list is the thing this test exists not to be.
    expect(mutations.length).toBeGreaterThanOrEqual(6);
    expect(reads.length).toBeGreaterThan(0);
    // The pure reads must not be in it — `getPlan` is the plainest of them.
    expect(mutations).not.toContain('getPlan');
    expect(reads).toContain('getPlan');
  });

  it('every derived mutation reaches a revision write — a SEVENTH one fails here', () => {
    const { bodies, mutations } = mutationDoors();

    // ⚠️ PHASES OF ONE ACT ARE JUDGED AS THAT ACT (Story MOTIR-6012 · MOTIR-6035; ADR
    // `approval-gates.md` §11.5). Approve is split into three named phases so the plan
    // gate's handler can run them around the decide door's own transaction:
    // `prepareApprovePlan` (before — its only write is the lazy `stale` backstop),
    // `approvePlanWithin` (the body, which writes the `approved` revision) and
    // `approveFailure` (after a rollback — the same `stale` backstop). The `stale` flip is
    // a lifecycle status with no trail row by design (`planDriftService`, the eager
    // mover, writes none either), so a before/after phase is tracked exactly when the
    // BODY it brackets is. That is only true while each phase is composed with its body,
    // so the pairing is asserted below, not assumed.
    const PHASE_OF: Record<string, string> = {
      prepareApprovePlan: 'approvePlanWithin',
      approveFailure: 'approvePlanWithin',
    };
    const handler = readFileSync(
      join(process.cwd(), 'lib/approvalGates/planApprovalHandler.ts'),
      'utf8',
    );
    for (const [phase, act] of Object.entries(PHASE_OF)) {
      // A stale entry (a phase that is no longer a mutation) fails, so the map cannot rot.
      expect(mutations, `${phase} is no longer a derived mutation`).toContain(phase);
      // The body runs inside the CALLER's transaction (it takes `tx`), so it is not a
      // derived mutation door itself — but it must exist, and it must write the row.
      expect(Object.keys(plansService)).toContain(act);
      expect(reaches(act, bodies).has('recordRevision'), `${act} writes no revision`).toBe(true);
      // …and the one caller that runs the phases runs the body with them.
      expect(handler).toContain(`.${phase}(`);
      expect(handler).toContain(`.${act}(`);
    }

    // ⚠️ A PLANNER'S IN-FLIGHT STEP IS NOT A PLAN CHANGE (Story MOTIR-7820 · MOTIR-7822,
    // MOTIR-7824). `recordPlanStep` / `endPlanStep` (and `reportPlanStep`, the one dispatch
    // both step doors make) take the plan row's lock and stamp `lastActivityAt`, so they
    // derive as mutations — but they write only the ephemeral `plan_step` row saying which
    // step a running session is on, which the read drops the moment the plan leaves
    // `generating`. Nothing about what the plan PROPOSES changes, and a trail row per step
    // would bury the plan's real history under hundreds of "started drafting X" entries.
    // Named here so the exemption is a decision on the record; a stale entry fails below.
    const NOT_A_PLAN_CHANGE = new Set(['recordPlanStep', 'endPlanStep', 'reportPlanStep']);
    for (const name of NOT_A_PLAN_CHANGE) {
      expect(mutations, `${name} is no longer a derived mutation`).toContain(name);
      expect(
        reaches(name, bodies).has('upsertForSession') ||
          reaches(name, bodies).has('deleteForSession'),
        `${name} no longer writes a plan step`,
      ).toBe(true);
    }

    // ⚠️ NOR IS A PLANNER'S NARRATION (Story MOTIR-8060 · MOTIR-8062). `recordPlanNarration`
    // takes the same lock and appends the session's own sentences to `plan_narration` — what
    // the planner SAID while it worked, kept for the chat panel. It changes nothing the plan
    // proposes either, and a trail row per sentence would bury the history the same way.
    const NOT_A_PLAN_CHANGE_NARRATION = new Set(['recordPlanNarration']);
    for (const name of NOT_A_PLAN_CHANGE_NARRATION) {
      expect(mutations, `${name} is no longer a derived mutation`).toContain(name);
      expect(reaches(name, bodies).has('maxSeq'), `${name} no longer appends narration`).toBe(true);
    }

    // ⚠️ NOR IS A PROVIDER-RETRY WAIT (Story MOTIR-9540 · MOTIR-9619). `recordProviderRetry`
    // takes the same lock and sets — or clears — the wait columns on the session's own
    // `plan_step` row while the model provider refuses a call. Like the step it rides on, it is
    // ephemeral and says nothing about what the plan proposes; a trail row per retry would bury
    // the history the same way.
    const NOT_A_PLAN_CHANGE_WAIT = new Set(['recordProviderRetry']);
    for (const name of NOT_A_PLAN_CHANGE_WAIT) {
      expect(mutations, `${name} is no longer a derived mutation`).toContain(name);
      expect(
        reaches(name, bodies).has('setProviderWait'),
        `${name} no longer writes the wait`,
      ).toBe(true);
    }

    // ⚠️ NOR IS WHAT A PLANNER SESSION READ (MOTIR-10122). `recordPlanCodeReads` takes the
    // same lock and appends to `plan_code_read` which files and queries a session read, at
    // which commit — evidence about how the plan was written, not a change to what it
    // proposes; a trail row per read would bury the history the same way narration would.
    const NOT_A_PLAN_CHANGE_CODE_READS = new Set(['recordPlanCodeReads']);
    for (const name of NOT_A_PLAN_CHANGE_CODE_READS) {
      expect(mutations, `${name} is no longer a derived mutation`).toContain(name);
      expect(reaches(name, bodies).has('maxSeq'), `${name} no longer appends code reads`).toBe(
        true,
      );
    }

    const untracked = mutations.filter(
      (name) =>
        !NOT_A_PLAN_CHANGE.has(name) &&
        !NOT_A_PLAN_CHANGE_CODE_READS.has(name) &&
        !NOT_A_PLAN_CHANGE_NARRATION.has(name) &&
        !NOT_A_PLAN_CHANGE_WAIT.has(name) &&
        !reaches(name, bodies).has('recordRevision') &&
        !(name in PHASE_OF && reaches(PHASE_OF[name]!, bodies).has('recordRevision')),
    );

    // The message is the point of the failure: whoever adds a plan mutation
    // without a trail row learns it here, by name, rather than by a reader
    // eventually noticing a plan whose history is missing an act.
    expect(untracked, `plan mutations that write no revision: ${untracked.join(', ')}`).toEqual([]);
  });

  it('the guard is not satisfiable by the mere PRESENCE of the import', async () => {
    // A source-shaped guard can pass vacuously — the import sits at the top of
    // the file and every method "contains" it if you look at the wrong scope. So
    // the same claim is made once against live rows: driving the mutations
    // actually produces the trail the guard says exists.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Guarded' }, fx.ctx);
    expect(await adminDb.planRevision.count({ where: { planId: plan.id } })).toBe(1);
  });
});

// ── Block 2 · the assembled seam ────────────────────────────────────────────

describe('the whole seam — six mutations written, one timeline read back', () => {
  it('every act reaches the trail, and the timeline reads the two the lifecycle cannot say', async () => {
    const fx = await makeWorkItemFixture();

    // ONE plan's whole life, through every door the service has.
    const plan = await plansService.createPlan(
      fx.projectId,
      {
        title: 'Every door',
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'One', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'Two', kind: 'task' } },
      ],
      fx.ctx,
    );
    await plansService.deepenProposal(plan.id, appended.items[0]!.id, { storyPoints: 3 }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.updateProposal(
      plan.id,
      appended.items[1]!.id,
      { title: 'Two, edited' },
      fx.ctx,
    );
    await plansService.approvePlan(plan.id, fx.ctx);

    // The TRAIL is complete — six acts, six rows, in the order they happened.
    const rows = await adminDb.planRevision.findMany({
      where: { planId: plan.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.map((r) => r.changeKind)).toEqual([
      'created',
      'appended',
      'edited',
      'planned',
      'edited',
      'approved',
    ]);

    // …and the TIMELINE is the reading of it: the four lifecycle events the
    // columns already say, plus the two content acts they cannot, in one
    // sequence. This is the assertion neither card's own units can make — each
    // sees one half.
    const { history } = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual([
      'created',
      'appended',
      'edited',
      'planned',
      'edited',
      'approved',
    ]);

    // The edit that happened AFTER the plan was closed for review sits between
    // `planned` and `approved`, which is the whole point of the story: a
    // reviewer can see that what they approved is not what they read.
    const lateEdit = history[4]!;
    expect(lateEdit.kind).toBe('edited');
    expect(Date.parse(lateEdit.at!)).toBeGreaterThanOrEqual(Date.parse(history[3]!.at!));
    expect(Date.parse(lateEdit.at!)).toBeLessThanOrEqual(Date.parse(history[5]!.at!));

    // And the two edits are NOT collapsed into one row, because a lifecycle
    // event stands between them — the rule, exercised on real data rather than
    // on a hand-built list.
    expect(history[2]!.count).toBe(1);
    expect(lateEdit.count).toBe(1);
  });

  it('a rolled-back mutation leaves the timeline unchanged, not merely the table', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Rollback' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    const before = (await planReviewService.getPlanReview(plan.id, fx.ctx)).history;

    // A refused mutation: `markPlanned` twice. The second is rejected under the
    // plan lock, which rolls its transaction back — and the seam's claim is that
    // the SURFACE is unchanged, not just that a row is absent.
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(plansService.markPlanned(plan.id, fx.ctx)).rejects.toThrow();

    const after = (await planReviewService.getPlanReview(plan.id, fx.ctx)).history;
    expect(after.filter((e) => e.kind === 'planned')).toHaveLength(1);
    expect(after.slice(0, before.length).map((e) => e.id)).toEqual(before.map((e) => e.id));
  });
});
