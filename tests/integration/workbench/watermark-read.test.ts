import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma as PrismaNs } from '@/generated/prisma/client';
import { adminDb } from '../../helpers/adminDb';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import { homeService, type HomeActorContext } from '@/lib/services/homeService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { WORKBENCH_TAB_KEYS, type WorkbenchTabKey } from '@/lib/dto/workbench';
import { encodeWatermarkCursor } from '@/lib/workbench/watermarkCursor';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';

// THE WATERMARK READ (Story MOTIR-5238 · Subtask MOTIR-5240), against a real
// Postgres (the motir-core no-mocks rule).
//
// The read answers one question per tab — *has anything you can see changed?* —
// and it has exactly two ways to be wrong, both silent:
//
//   · TOO NARROW. A watermark taken over a smaller set than its tab renders
//     means the list goes stale and NOTHING EVER NUDGES. Nothing goes red,
//     because the list is still correct whenever anybody reloads. So every tab
//     here gets a POSITIVE case driven through the product's own write paths.
//   · TOO WIDE. A watermark taken over a larger set nudges on rows the reader
//     cannot see — wasteful, and a claim about access that is not true. So every
//     tab also gets a NEGATIVE case, and the access case uses a fixture whose
//     VIEW AND TRUE POPULATION DIFFER; with an actor who sees everything, a
//     scoped read and an unscoped one return the same answer and prove nothing.
//
// ⚠️ AND THE EDIT CASE IS THE ONE A COUNT-ONLY WATERMARK PASSES EVERY NAIVE TEST
// WITHOUT. Arrivals and departures move a count; a row that stays exactly where
// it is while its content changes does not — and that is precisely the
// situation the stale-approval work exists for.
//
// ⚠️ ROWS ARE MOVED THROUGH THE SERVICE, never by writing `work_item.status`
// with `adminDb`: `completedAt` is stamped by the transition (MOTIR-4780), and a
// fixture that sets the column directly makes the finished-window assertions
// pass for the wrong reason.

let fx: WorkItemFixture;
/** A story for subtasks to hang under (`lib/issues/parentRules.ts`). */
let storyId: string;

beforeEach(async () => {
  // The status paths emit `work-item/transitioned` post-commit and the test env
  // has no Inngest key — the comments-suite pattern.
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WMK' });
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The live Workbench' },
    fx.ctx,
  );
  storyId = story.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = (): HomeActorContext => ({ ...fx.ctx, projectId: fx.projectId });

/** A card the reader reports — created THROUGH the service, so it lands in the project's initial status. */
async function card(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/**
 * A card somebody ELSE files — reported, assigned and WATCHED by them alone.
 *
 * ⚠️ IT MUST BE CREATED UNDER THEIR OWN CONTEXT, not created here and handed
 * over. `createWorkItem` AUTO-WATCHES its creator (`watcherRepository`'s
 * auto-watch hooks), so a card this fixture files and then re-assigns is still
 * one the reader watches — which is correct product behaviour and quietly
 * destroys every assertion below that says the reader cannot see it. The three
 * failures that found this were all in the Watching tab.
 */
async function theirCard(title: string, userId: string): Promise<{ id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    {
      userId,
      workspaceId: fx.workspaceId,
    },
  );
  return { id: item.id };
}

/** Move a card the way the product does. */
async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

/** One card carrying one awaiting gate, routed by the columns §2 reads. */
async function gateOn(opts: {
  title: string;
  assigneeId?: string | null;
  reporterId?: string;
  kind?: 'design_result' | 'pull_request_approval';
}) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: storyId, title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: opts.assigneeId ?? null,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
    },
  });
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: opts.kind ?? 'design_result',
        subjectId: `evidence-${item.id}`,
      },
      tx,
    ),
  );
  return { item, gate };
}

/** Hand a card to somebody else entirely — off the reader's membership `OR`. */
async function handTo(id: string, userId: string): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: { assigneeId: userId, reporterId: userId },
  });
}

async function watch(workItemId: string, userId: string): Promise<void> {
  await withWorkspaceContext(fx.ctx, (tx) => watcherRepository.add(workItemId, userId, tx));
}

/** Somebody else in the same workspace — the far side of every negative case. */
async function stranger(email: string): Promise<string> {
  const user = await createTestUser({ email, name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user.id;
}

describe('every tab NUDGES on a change its own list would show', () => {
  it('toDo — an arrival', async () => {
    const before = await workbenchWatermarkService.read(ctx());
    await card('Something new to do');
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('toDo');
    expect(after.tabs.toDo.count).toBe(before.tabs.toDo.count + 1);
  });

  it('inProgress — an arrival, which is also toDo DEPARTING', async () => {
    const moving = await card('About to start');
    const before = await workbenchWatermarkService.read(ctx());
    await move(moving.id, 'in_progress');
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    // ⚠️ BOTH TABS, from one write. A row that leaves one tab and arrives in
    // another is two lists going stale, and a frame that named only the
    // destination would leave the origin showing a row that is no longer there.
    expect(after.moved).toEqual(expect.arrayContaining(['toDo', 'inProgress']));
    expect(after.tabs.toDo.count).toBe(before.tabs.toDo.count - 1);
    expect(after.tabs.inProgress.count).toBe(before.tabs.inProgress.count + 1);
  });

  it('recentlyFinished — a card finishing inside the window', async () => {
    const shipping = await card('About to land');
    await move(shipping.id, 'in_progress');
    const before = await workbenchWatermarkService.read(ctx());
    await move(shipping.id, 'done');
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('recentlyFinished');
    expect(after.tabs.recentlyFinished.count).toBe(before.tabs.recentlyFinished.count + 1);
  });

  it('approvals — a gate arriving, routed to the reader', async () => {
    const before = await workbenchWatermarkService.read(ctx());
    await gateOn({ title: 'Waiting on me', assigneeId: fx.ownerId });
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('approvals');
    expect(after.tabs.approvals.count).toBe(1);
  });

  it('watching — a watch arriving on an item the reader does not own', async () => {
    const other = await stranger('watched-owner@ex.com');
    const theirs = await theirCard('Somebody else’s card', other);
    const before = await workbenchWatermarkService.read(ctx());
    await watch(theirs.id, fx.ownerId);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('watching');
    expect(after.tabs.watching.count).toBe(before.tabs.watching.count + 1);
  });
});

describe('a change a tab would NOT show moves nothing', () => {
  it('another person’s card is invisible to every tab', async () => {
    const other = await stranger('elsewhere@ex.com');
    const theirs = await theirCard('Not mine', other);

    const before = await workbenchWatermarkService.read(ctx());
    await workItemsService.updateWorkItem(theirs.id, { title: 'Still not mine' }, fx.ctx);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toEqual([]);
  });

  it('a gate routed to somebody ELSE does not move the approvals tab', async () => {
    const other = await stranger('their-decision@ex.com');
    const before = await workbenchWatermarkService.read(ctx());
    await gateOn({ title: 'Waiting on them', assigneeId: other, reporterId: other });
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).not.toContain('approvals');
    expect(after.tabs.approvals.count).toBe(0);
  });

  it('a card finished LONGER ago than the window does not move recentlyFinished', async () => {
    const old = await card('Finished in June');
    await move(old.id, 'in_progress', 'done');
    await adminDb.workItem.update({
      where: { id: old.id },
      data: { completedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    });

    const before = await workbenchWatermarkService.read(ctx());
    // Re-touching an old row must not bring it back: the window is on
    // `completedAt`, and the watermark reads the same predicate the list does.
    await adminDb.workItem.update({ where: { id: old.id }, data: { updatedAt: new Date() } });
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).not.toContain('recentlyFinished');
    expect(after.tabs.recentlyFinished.count).toBe(0);
  });

  it('an ARCHIVED card leaves the watermark exactly as its list leaves it', async () => {
    const doomed = await card('About to be archived');
    const before = await workbenchWatermarkService.read(ctx());
    await workItemsService.archiveWorkItem(doomed.id, fx.ctx);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    // The row leaves the tab, so the tab MOVED — and the new reading agrees with
    // what the list now returns, which is the assertion that matters.
    expect(after.moved).toContain('toDo');
    expect(after.tabs.toDo.count).toBe((await homeService.listToDo(ctx())).total);
  });
});

describe('THE ACCESS FIXTURE — a reader who may not browse their own active project', () => {
  it('reads an empty watermark while the true population is NOT empty, on every tab', async () => {
    // ⚠️ THE VIEW AND THE POPULATION DIFFER, which is the only way this can
    // distinguish a scoped read from an unscoped one. A plain workspace member —
    // RLS admits them — with work, a watch and a gate genuinely theirs, inside a
    // PRIVATE project they hold no role on.
    const outsider = await stranger('outsider@ex.com');
    const theirs = await card('Genuinely theirs');
    await handTo(theirs.id, outsider);
    await watch(theirs.id, outsider);
    await gateOn({ title: 'Genuinely their decision', assigneeId: outsider });

    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    // Joining a workspace enrols a user in its projects, so the revocation is
    // what actually creates the state the scope resolver is written for.
    await adminDb.projectMembership.deleteMany({
      where: { userId: outsider, projectId: fx.projectId },
    });

    const trueWork = await adminDb.workItem.count({ where: { assigneeId: outsider } });
    const trueGates = await adminDb.approvalGate.count({
      where: { state: 'awaiting', workItem: { assigneeId: outsider } },
    });
    const trueWatches = await adminDb.watcher.count({ where: { userId: outsider } });
    expect([trueWork, trueGates, trueWatches].every((n) => n > 0)).toBe(true);

    const reading = await workbenchWatermarkService.read({
      userId: outsider,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    for (const key of WORKBENCH_TAB_KEYS) {
      expect(reading.tabs[key]).toEqual({ count: 0, latest: null });
    }
  });
});

describe('an EDIT moves the watermark — the case a count-only watermark misses', () => {
  it('a re-titled card moves toDo while its count stands still', async () => {
    const edited = await card('First title');
    const before = await workbenchWatermarkService.read(ctx());
    await workItemsService.updateWorkItem(edited.id, { title: 'Second title' }, fx.ctx);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('toDo');
    expect(after.tabs.toDo.count).toBe(before.tabs.toDo.count);
    expect(after.tabs.toDo.latest).not.toBe(before.tabs.toDo.latest);
  });

  it('a gate edited in place moves approvals while its count stands still', async () => {
    const { gate } = await gateOn({ title: 'Waiting on me', assigneeId: fx.ownerId });
    const before = await workbenchWatermarkService.read(ctx());
    // The shape a REPUBLISH leaves behind: the question is still one row waiting
    // on this reader, and what changed is the row. `updatedAt` is what carries
    // it; the count cannot.
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { subjectId: `evidence-v2-${gate.id}` },
    });
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('approvals');
    expect(after.tabs.approvals.count).toBe(before.tabs.approvals.count);
    expect(after.tabs.approvals.latest).not.toBe(before.tabs.approvals.latest);
  });

  it('an edit to a WATCHED item the reader does not own moves the watching tab', async () => {
    const other = await stranger('their-card@ex.com');
    const theirs = await theirCard('Watched, not owned', other);
    await watch(theirs.id, fx.ownerId);

    const before = await workbenchWatermarkService.read(ctx());
    await adminDb.workItem.update({
      where: { id: theirs.id },
      data: { title: 'Changed under me' },
    });
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toEqual(['watching']);
    expect(after.tabs.watching.count).toBe(before.tabs.watching.count);
  });
});

describe('the RESUME contract — absent, replayed, and unreadable are three answers', () => {
  it('names nothing when no cursor is presented', async () => {
    await card('Something to see');
    const first = await workbenchWatermarkService.read(ctx());
    expect(first.moved).toEqual([]);
  });

  it('names nothing when the SAME cursor is replayed — a reconnect is neither a replay nor a gap', async () => {
    await card('Something to see');
    const first = await workbenchWatermarkService.read(ctx());
    const again = await workbenchWatermarkService.read(ctx(), first.cursor);
    const thrice = await workbenchWatermarkService.read(ctx(), first.cursor);

    expect(again.moved).toEqual([]);
    expect(thrice.moved).toEqual([]);
    expect(thrice.cursor).toBe(first.cursor);
  });

  it('names EVERY tab for an unreadable cursor — one redundant re-read beats a list that stops updating', async () => {
    const reading = await workbenchWatermarkService.read(ctx(), 'w0.not-this-format');
    expect(reading.moved).toEqual([...WORKBENCH_TAB_KEYS]);
  });

  it('names only what moved since a STALE cursor, however many readings ago it was minted', async () => {
    const other = await stranger('noise@ex.com');
    const stale = (await workbenchWatermarkService.read(ctx())).cursor;
    await card('One');
    await workbenchWatermarkService.read(ctx());
    await card('Two');
    await theirCard('Not mine either', other);
    await workbenchWatermarkService.read(ctx());

    const after = await workbenchWatermarkService.read(ctx(), stale);
    // ⚠️ TWO TABS, and the second is not noise: filing a card AUTO-WATCHES its
    // creator, so a reader who files work is watching it. The other person's
    // card moves neither — which is what makes this a comparison against the
    // stale cursor rather than a re-read of everything.
    expect(after.moved).toEqual(['toDo', 'watching']);
  });
});

describe('the payload is a SIGNAL — bounded, and carrying no row content', () => {
  it('is five pairs whatever the project holds', async () => {
    for (let i = 0; i < 40; i += 1) {
      const row = await card(`Bulk ${i}`);
      if (i % 4 === 0) await move(row.id, 'in_progress');
      if (i % 5 === 0) await watch(row.id, fx.ownerId);
    }
    await gateOn({ title: 'And a decision', assigneeId: fx.ownerId });

    const reading = await workbenchWatermarkService.read(ctx());

    expect(Object.keys(reading.tabs).sort()).toEqual([...WORKBENCH_TAB_KEYS].sort());
    for (const key of WORKBENCH_TAB_KEYS) {
      // Every tab is exactly two fields — a size and a freshness. Nothing here
      // grows with the project, which is the property that makes polling this
      // once a second affordable.
      expect(Object.keys(reading.tabs[key as WorkbenchTabKey]).sort()).toEqual(['count', 'latest']);
    }
    expect(Object.keys(reading).sort()).toEqual(['cursor', 'moved', 'tabs']);
  });

  it('mentions no title, identifier or id of anything it counted', async () => {
    const named = await card('A very distinctive title');
    await watch(named.id, fx.ownerId);
    await gateOn({ title: 'Another distinctive title', assigneeId: fx.ownerId });

    const serialised = JSON.stringify(await workbenchWatermarkService.read(ctx()));

    expect(serialised).not.toContain('A very distinctive title');
    expect(serialised).not.toContain('Another distinctive title');
    expect(serialised).not.toContain(named.id);
    expect(serialised).not.toContain(named.identifier);
    expect(serialised).not.toContain(fx.projectId);
  });
});

describe('the watermark AGREES with the reads it is derived from', () => {
  it('matches every tab count the strip renders, over a mixed fixture', async () => {
    const waiting = await card('Waiting');
    const moving = await card('Moving');
    await move(moving.id, 'in_progress');
    const shipped = await card('Shipped');
    await move(shipped.id, 'in_progress', 'done');
    await watch(waiting.id, fx.ownerId);
    await gateOn({ title: 'Decide me', assigneeId: fx.ownerId });

    const counts = await homeService.tabCounts(ctx());
    const approvals = await approvalGatesService.countAwaitingMe(ctx());
    const reading = await workbenchWatermarkService.read(ctx());

    // ⚠️ THE POINT OF THIS ASSERTION IS THE PREDICATE, NOT THE ARITHMETIC. The
    // badge, the list and the watermark are three readers of one question per
    // tab; a number that disagrees here is a fourth definition of who sees what,
    // which is the drift this card was written to make impossible.
    expect(reading.tabs.toDo.count).toBe(counts.toDo);
    expect(reading.tabs.inProgress.count).toBe(counts.inProgress);
    expect(reading.tabs.recentlyFinished.count).toBe(counts.recentlyFinished);
    expect(reading.tabs.watching.count).toBe(counts.watching);
    expect(reading.tabs.approvals.count).toBe(counts.approvals);
    expect(reading.tabs.approvals.count).toBe(approvals);
  });
});

describe('COST — this read runs once a second per open Workbench', () => {
  /**
   * Every Prisma operation issued inside the poll, in order.
   *
   * The service reaches the database through ONE `withWorkspaceContext`, which
   * is `db.$transaction`; wrapping that transaction's client is what makes the
   * count observable through the service rather than by re-deriving it from the
   * repositories. `$`-prefixed calls are counted too, because the three
   * `set_config` binds are real round trips and pretending otherwise would
   * understate the poll.
   */
  async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const real = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, opts: unknown) => {
      if (typeof fn !== 'function') return (real as (...a: unknown[]) => unknown)(fn, opts);
      return (real as (...a: unknown[]) => unknown)(async (tx: PrismaNs.TransactionClient) => {
        const proxy = new Proxy(tx as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof prop !== 'string') return value;
            if (prop.startsWith('$') && typeof value === 'function') {
              return (...args: unknown[]) => {
                seen.push(prop);
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            if (typeof value === 'object' && value !== null) {
              return new Proxy(value, {
                get(delegate, method, r) {
                  const fn2 = Reflect.get(delegate, method, r);
                  if (typeof fn2 !== 'function') return fn2;
                  return (...args: unknown[]) => {
                    seen.push(`${prop}.${String(method)}`);
                    return (fn2 as (...a: unknown[]) => unknown).apply(delegate, args);
                  };
                },
              });
            }
            return value;
          },
        }) as PrismaNs.TransactionClient;
        return (fn as (t: PrismaNs.TransactionClient) => unknown)(proxy);
      }, opts);
    }) as never);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  const REMEDY =
    'This read is polled once a second per open Workbench, so its statement count is a ' +
    'standing cost rather than a detail. If this list has grown, say WHY in the change: a ' +
    'per-tab second round trip is five more statements per second per reader. The shape to ' +
    'keep is ONE aggregate per tab (`_count` + `_max` over one `where`), with Watching the ' +
    'one documented exception — `watcher` carries no `updatedAt`, so its freshness lives ' +
    'across a relation Prisma cannot `_max` through.';

  it('is ONE transaction of nineteen statements, and the shape is the point', async () => {
    for (let i = 0; i < 10; i += 1) await card(`Bulk ${i}`);
    await gateOn({ title: 'Decide me', assigneeId: fx.ownerId });

    const seen = await statementsOf(() => workbenchWatermarkService.read(ctx()));

    expect(seen, REMEDY).toEqual([
      // The workspace context — three `set_config` binds, shared with every
      // Workbench read and not this card's to remove.
      '$executeRaw',
      '$executeRaw',
      '$executeRaw',
      // The project SCOPE — the access decision and the project's own status
      // partition, resolved ONCE for all five tabs because it is the expensive
      // half and every tab needs the same one.
      'project.findUnique',
      'workspaceMembership.findUnique',
      'workflowStatus.findMany',
      // The plans a revision holds right now (MOTIR-7988) — they leave the
      // approvals count for Planning, so the approvals aggregate needs their ids.
      // One indexed prefilter on `plan` (planned + a trail row inside the lease
      // window); the trail itself is read ONLY when that finds a candidate, which
      // in the steady state — no revision in flight — it does not.
      'plan.findMany',
      // The planning sessions that still wait on their person (MOTIR-7913), which the
      // approvals aggregate needs too — a gate's subject is an opaque id the aggregate
      // cannot join, so the live set rides in as `IN (…)`. Read BESIDE the held plans
      // and BEFORE the fan-out, never awaited inside it (Bug MOTIR-8284).
      'planChangeSession.findMany',
      // The seven tabs. Five work tabs, one aggregate each — To fix (MOTIR-6604)
      // and To resume (MOTIR-7707) are each one more slice of the same membership
      // read and so one more aggregate rather than a second round trip…
      'workItem.aggregate',
      'workItem.aggregate',
      'workItem.aggregate',
      'workItem.aggregate',
      'workItem.aggregate',
      // …the approvals queue on the gate's own predicate…
      'approvalGate.aggregate',
      // …Watching, the one tab that costs two…
      'watcher.count',
      'watcher.findFirst',
      // …and the reader's failed planning sessions, folded into To resume's pair
      // (MOTIR-7914) so a new failure moves the tab's change detector as it moves the badge.
      'planChangeSession.aggregate',
      // …and the sessions that ended `failed` before MOTIR-7905 yet hold a waiting plan (MOTIR-7939).
      'planChangeSession.aggregate',
      // …and the REVIEW of the approve-and-merge rows (Bug MOTIR-10504): which of the
      // approvals are approve-and-merge rows, on the gate's own predicate. A review that
      // writes no gate (a gate-off pass, a GitHub approval at the head) changes those rows'
      // review line and badge, and the approvals aggregate cannot see it. With no such
      // row — this fixture's gate is a design result — the review reading itself is
      // skipped, so the steady-state cost is this one statement.
      'approvalGate.findMany',
    ]);
  });

  it('an approve-and-merge row costs ONE more: the review reading over its cards', async () => {
    await gateOn({ title: 'Merge me', assigneeId: fx.ownerId, kind: 'pull_request_approval' });

    const seen = await statementsOf(() => workbenchWatermarkService.read(ctx()));

    // ⚠️ TWO statements for the review, never one per row: the cards come from one
    // `findMany` on the gate predicate, and their verdict records, dismissals, deliveries
    // and GitHub reviews from ONE raw query over those cards (MOTIR-10504).
    expect(seen.slice(-2), REMEDY).toEqual(['approvalGate.findMany', '$queryRaw']);
    expect(seen).toHaveLength(20);

    // A second row adds no statement.
    await gateOn({ title: 'Merge me too', assigneeId: fx.ownerId, kind: 'pull_request_approval' });
    expect(await statementsOf(() => workbenchWatermarkService.read(ctx()))).toHaveLength(20);
  });

  it('costs TWO statements more than the count read the strip already does — the control', async () => {
    for (let i = 0; i < 10; i += 1) await card(`Bulk ${i}`);

    const watermark = await statementsOf(() => workbenchWatermarkService.read(ctx()));
    const counts = await statementsOf(() => homeService.tabCounts(ctx()));

    // ⚠️ THE CONTROL IS WHAT MAKES THE NUMBER MEAN ANYTHING. Nineteen statements is
    // not obviously cheap or expensive in the abstract; what settles it is that
    // the strip ALREADY issues seventeen to render its badges for the tabs this
    // read covers, and this read answers strictly more — every tab's freshness as
    // well as its size — for one more.
    //
    // The strip's Planning badge (MOTIR-7828) is left out of the comparison: the
    // Planning tab carries no freshness (design/workbench § 36 draws no dot — its
    // rows move on their own poll), so the watermark has no slice for it and its
    // `plan.count` is not a statement this read could share.
    expect(counts.filter((s) => s === 'plan.count')).toHaveLength(1);
    const comparable = counts.filter((s) => s !== 'plan.count');
    // …and one more again for the approve-and-merge rows' REVIEW (Bug MOTIR-10504): which
    // approvals are merge rows. The strip counts rows and draws no review, so it has no
    // statement to share; the review reading itself is skipped while no such row waits.
    expect(watermark.length - comparable.length).toBe(2);
  });

  it('is bounded by the PROJECT, not by its size', async () => {
    for (let i = 0; i < 40; i += 1) {
      const row = await card(`Bulk ${i}`);
      if (i % 3 === 0) await watch(row.id, fx.ownerId);
    }
    const big = await statementsOf(() => workbenchWatermarkService.read(ctx()));
    expect(big).toHaveLength(19);
  });

  it('runs on indexes that are actually present', async () => {
    // ⚠️ PRESENCE, NOT A PLAN. `EXPLAIN` on a test database of a few dozen rows
    // reports a sequential scan whatever indexes exist, so a plan assertion here
    // would measure the fixture's size. What CAN be checked, and is what the
    // card asks for, is that every predicate this read issues has its index in
    // the deployed schema.
    const rows = await adminDb.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('work_item','watcher','approval_gate')`,
    );
    const present = new Set(rows.map((r) => r.indexname));
    for (const index of [
      // toDo / inProgress — the per-project status partition.
      'work_item_projectId_status_idx',
      // Recently finished — the window, on the axis it orders by.
      'work_item_projectId_completedAt_idx',
      // To fix — the stored reason, carved out of In progress (MOTIR-6604).
      'work_item_projectId_fixReason_idx',
      // The membership arm of all three work tabs.
      'work_item_projectId_assigneeId_idx',
      // Watching — `model Watcher`'s own "the issues I watch" index.
      'watcher_user_id_idx',
      // The approvals queue — one project's awaiting rows.
      'approval_gate_project_id_state_idx',
    ]) {
      expect(present, `missing index: ${index}`).toContain(index);
    }
  });
});

describe('the cursor a caller presents is the one this service mints', () => {
  it('accepts a cursor built from a reading it returned', async () => {
    await card('One');
    const reading = await workbenchWatermarkService.read(ctx());
    const rebuilt = encodeWatermarkCursor(reading.tabs);

    expect(rebuilt).toBe(reading.cursor);
    expect((await workbenchWatermarkService.read(ctx(), rebuilt)).moved).toEqual([]);
  });
});

// ⚠️ THE READ'S ARMS SETTLE BEFORE ITS TRANSACTION ENDS (Bug MOTIR-8284).
//
// Production threw `TypeError: Cannot read properties of undefined (reading
// '_count')` out of `watermarkByAssigneeOrReporterInWorkspace`, reported as an
// UNHANDLED rejection. No input makes `aggregate` answer `undefined` — an empty
// match answers `{ _count: { _all: 0 } }`, pinned below. What does is the
// TRANSACTION: Prisma resolves a query still queued on an interactive
// transaction that has already rolled back to `undefined`. The fan-out awaited
// a read INSIDE its own argument list, after the five work-tab aggregates had
// started and before `Promise.all` was called, so when that read failed the
// transaction rolled back under five aggregates nobody was awaiting. Each one
// then dereferenced the `undefined` it was handed and rejected into the void.
describe('a failing arm cannot strand its siblings on a closed transaction (MOTIR-8284)', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  /** What every work-tab aggregate that did NOT come back with a reading threw. */
  function strandedReads(spy: { mock: { settledResults: { type: string; value: unknown }[] } }) {
    return spy.mock.settledResults
      .filter((r) => r.type !== 'fulfilled')
      .map((r) => String(r.value));
  }

  /** Let any rejection nobody handled reach `unhandledRejection`. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 20));
  }

  it('a reader with NO matching card reads zeros — an empty match is not the trigger', async () => {
    await card("Somebody else's");
    const other = await stranger('nobody-matches@example.com');
    await adminDb.workItem.updateMany({
      where: { projectId: fx.projectId },
      data: { assigneeId: other, reporterId: other },
    });

    const reading = await workbenchWatermarkService.read(ctx());

    for (const tab of ['toDo', 'inProgress', 'toFix', 'recentlyFinished'] as const) {
      expect(reading.tabs[tab]).toEqual({ count: 0, latest: null });
    }
  });

  it('the awaiting-sessions read failing rejects the read with ITS error, and nothing is left unhandled', async () => {
    await card('Something to count');
    const failure = new Error('awaiting-sessions read failed');
    vi.spyOn(planChangeSessionRepository, 'listAwaitingPersonIdsInProjects').mockImplementation(
      async () => {
        // Fail AFTER a turn, so the work-tab aggregates are genuinely in flight.
        await new Promise((r) => setTimeout(r, 5));
        throw failure;
      },
    );
    const watermark = vi.spyOn(workItemRepository, 'watermarkByAssigneeOrReporterInWorkspace');

    await expect(workbenchWatermarkService.read(ctx())).rejects.toBe(failure);
    await drain();

    expect(rejections.map(String)).toEqual([]);
    // Every work-tab aggregate that started also FINISHED, on an open transaction.
    // (The spy observes each promise, so it is THIS assertion that sees the
    // stranded aggregates; `unhandledRejection` is what production saw.)
    expect(strandedReads(watermark)).toEqual([]);
    expect(watermark.mock.settledResults).toHaveLength(watermark.mock.calls.length);
  });

  it('an arm of the fan-out failing waits for every sibling before the transaction ends', async () => {
    await card('Something to count');
    const failure = new Error('watching read failed');
    vi.spyOn(watcherRepository, 'watermarkByUser').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw failure;
    });
    const watermark = vi.spyOn(workItemRepository, 'watermarkByAssigneeOrReporterInWorkspace');

    await expect(workbenchWatermarkService.read(ctx())).rejects.toBe(failure);
    await drain();

    expect(rejections.map(String)).toEqual([]);
    expect(watermark).toHaveBeenCalledTimes(5);
    expect(strandedReads(watermark)).toEqual([]);
    expect(watermark.mock.settledResults).toHaveLength(5);
  });
});
