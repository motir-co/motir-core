import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planRepository } from '@/lib/repositories/planRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3235 — the READ half of the tabbed, streamed Plans list: the status
// predicate, the ten-a-page default, and the per-status counts the tab strip
// renders. Real Postgres (no mocks), per CLAUDE.md.
//
// The three properties worth a test each are all seams where a plausible
// cheaper implementation is WRONG:
//   • the status is applied in the repository's `where`, not by the caller —
//     a caller-side filter shrinks the cursor page and leaves `nextCursor`
//     claiming there is more than there is;
//   • the count map is TOTAL over the status vocabulary — a `groupBy` returns
//     only the statuses that have rows, so a tab for an empty status would
//     render `undefined` rather than `0`;
//   • an UNFILTERED page is byte-identical to what it was before the option
//     existed — the widening must not re-order or re-filter the read every
//     caller predating the tabs still makes.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A plan in the given lifecycle status, created through the real service path
 *  as far as each status allows. `generating` is where `createPlan` leaves it;
 *  `planned` is one `markPlanned` on; `approved` / `declined` are the two
 *  decisions. Returns the plan id. */
async function planIn(
  fx: WorkItemFixture,
  // ⚠️ `stale` IS ABSENT ON PURPOSE (MOTIR-3578). This helper reaches each
  // status "through the real service path", and NOTHING transitions into the
  // fifth one yet — that is MOTIR-3579's card. Adding an arm here would have to
  // write the status directly, which is exactly the shortcut this helper's
  // contract exists to avoid; `planStatusStale.test.ts` owns the direct write
  // and says so where it makes it.
  status: 'generating' | 'planned' | 'approved' | 'declined',
  title: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  if (status === 'generating') return plan.id;
  // ⚠️ ONE PROPOSAL, ALWAYS (MOTIR-4124). A close over a plan holding NOTHING
  // DISCARDS it — `declined` / `discarded` — so a helper that appended nothing
  // could not reach `planned` at all, and every status above it would be the
  // wrong one. The proposal is fixture scaffolding, not a subject of these
  // cases.
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: `${title} — a proposal`, kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return plan.id;
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

describe('plansService.listPlans — the status predicate', () => {
  it('narrows the page to one status, and the unfiltered page is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const generating = await planIn(fx, 'generating', 'still going');
    const planned = await planIn(fx, 'planned', 'awaiting review');
    const approved = await planIn(fx, 'approved', 'accepted');
    const declined = await planIn(fx, 'declined', 'rejected');

    const plannedOnly = await plansService.listPlans(fx.projectId, fx.ctx, { status: 'planned' });
    expect(plannedOnly.plans.map((p) => p.id)).toEqual([planned]);
    expect(plannedOnly.nextCursor).toBeNull();

    const generatingOnly = await plansService.listPlans(fx.projectId, fx.ctx, {
      status: 'generating',
    });
    expect(generatingOnly.plans.map((p) => p.id)).toEqual([generating]);

    // Omitted ⇒ the whole project, newest first — exactly what this read
    // returned before the option existed.
    const all = await plansService.listPlans(fx.projectId, fx.ctx);
    expect(all.plans.map((p) => p.id)).toEqual([declined, approved, planned, generating]);
    expect(all.nextCursor).toBeNull();

    // An explicit `null` means the same thing as omitting it.
    const allExplicitNull = await plansService.listPlans(fx.projectId, fx.ctx, { status: null });
    expect(allExplicitNull.plans.map((p) => p.id)).toEqual(all.plans.map((p) => p.id));
  });

  it('applies the status in the WHERE — a filtered page is full, not a shrunken one', async () => {
    const fx = await makeWorkItemFixture();
    // Interleave the two statuses so a caller-side filter over a `limit + 1`
    // page would return fewer rows than asked for while still reporting more.
    for (let i = 0; i < 6; i += 1) {
      await planIn(fx, 'generating', `generating ${i}`);
      await planIn(fx, 'planned', `planned ${i}`);
    }

    const page = await plansService.listPlans(fx.projectId, fx.ctx, {
      status: 'planned',
      limit: 4,
    });
    expect(page.plans).toHaveLength(4);
    expect(page.plans.every((p) => p.status === 'planned')).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('pages correctly WITHIN a status: disjoint pages, newest first, a null last cursor', async () => {
    const fx = await makeWorkItemFixture();
    // More than 10 rows in ONE status — the size the default page is cut at, so
    // the `take: limit + 1` seam is exercised at its own boundary.
    const ids: string[] = [];
    for (let i = 0; i < 13; i += 1) ids.push(await planIn(fx, 'planned', `planned ${i}`));
    for (let i = 0; i < 4; i += 1) await planIn(fx, 'declined', `declined ${i}`);
    const newestFirst = [...ids].reverse();

    const first = await plansService.listPlans(fx.projectId, fx.ctx, { status: 'planned' });
    expect(first.plans.map((p) => p.id)).toEqual(newestFirst.slice(0, 10));
    expect(first.nextCursor).toBe(newestFirst[9]);

    const second = await plansService.listPlans(fx.projectId, fx.ctx, {
      status: 'planned',
      cursor: first.nextCursor,
    });
    expect(second.plans.map((p) => p.id)).toEqual(newestFirst.slice(10));
    expect(second.nextCursor).toBeNull();

    // Disjoint: the two pages together are the whole status, with no repeats.
    const seen = new Set([...first.plans, ...second.plans].map((p) => p.id));
    expect(seen.size).toBe(13);
  });

  it('defaults to TEN a page, with a cursor when more exist', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 11; i += 1) await planIn(fx, 'generating', `p${i}`);

    const page = await plansService.listPlans(fx.projectId, fx.ctx);
    expect(page.plans).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('plansService.countPlansByStatus', () => {
  it('is TOTAL over the status vocabulary — an empty status reads 0, not undefined', async () => {
    const fx = await makeWorkItemFixture();
    await planIn(fx, 'planned', 'a');
    await planIn(fx, 'planned', 'b');
    await planIn(fx, 'generating', 'c');

    const counts = await plansService.countPlansByStatus(fx.projectId, fx.ctx);
    expect(counts).toEqual({
      generating: 1,
      planned: 2,
      approving: 0,
      stale: 0,
      approved: 0,
      declined: 0,
    });
    // Every member of the vocabulary has a key, and every value is a number —
    // the property a tab strip rendering `{counts[tab]}` depends on.
    for (const status of PLAN_STATUS_DTO_VALUES) {
      expect(typeof counts[status]).toBe('number');
    }
  });

  it('counts nothing for a project with no plans, still totally', async () => {
    const fx = await makeWorkItemFixture();
    const counts = await plansService.countPlansByStatus(fx.projectId, fx.ctx);
    expect(counts).toEqual({
      generating: 0,
      planned: 0,
      approving: 0,
      stale: 0,
      approved: 0,
      declined: 0,
    });
  });

  it('the repository read is ONE groupBy that returns only the present statuses', async () => {
    const fx = await makeWorkItemFixture();
    await planIn(fx, 'planned', 'a');
    await planIn(fx, 'declined', 'b');

    // Read inside the workspace context the service wraps it in — the plan
    // policy keys on the per-transaction workspace GUC, so an unbound read of
    // this table sees nothing at all.
    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.countByStatus(fx.projectId, fx.workspaceId, tx),
    );
    // The repository does NOT zero-fill — that is the service's mapping job,
    // and this asserts the split rather than duplicating the fill one layer
    // down where the DTO vocabulary is not in scope.
    expect(rows.map((r) => r.status).sort()).toEqual(['declined', 'planned']);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });
});

describe('the two reads are workspace-scoped', () => {
  it('another workspace sees neither this project’s page nor its counts', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await planIn(mine, 'planned', 'mine');

    // The other tenant's context cannot browse this project at all — the gate
    // both reads assert before touching a row.
    await expect(
      plansService.listPlans(mine.projectId, theirs.ctx, { status: 'planned' }),
    ).rejects.toThrow();
    await expect(plansService.countPlansByStatus(mine.projectId, theirs.ctx)).rejects.toThrow();

    // And their own project is empty rather than showing ours.
    const theirCounts = await plansService.countPlansByStatus(theirs.projectId, theirs.ctx);
    expect(theirCounts).toEqual({
      generating: 0,
      planned: 0,
      approving: 0,
      stale: 0,
      approved: 0,
      declined: 0,
    });
  });
});
