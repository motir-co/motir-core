import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  makeWorkItemFixture as makeFixture,
  createTestProject,
  createTestLink,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';

// Subtask 7.5.1 — the plan-tree GRAPH-TRAVERSAL read family (get_item /
// get_subtree / walk_blocking) at the service level, against a REAL Postgres.
// Proves the DEPTH reads the planner walks: bounded (depth-clamped subtree,
// node/-depth-capped blocking closure, paginated comments + history), cycle-safe,
// and 404-not-403 across tenants (finding #26).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workItemsService.getBoundedSubtree', () => {
  it('bounds the subtree to `depth` descendant levels', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Sub', parentId: story.id },
      fx.ctx,
    );

    // depth 0 → the root alone.
    const d0 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 0);
    expect(d0.depth).toBe(0);
    expect(d0.nodes.map((n) => n.identifier)).toEqual([epic.identifier]);

    // depth 1 → root + direct children (the story), NOT the grandchild subtask.
    const d1 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 1);
    expect(d1.nodes.map((n) => n.identifier).sort()).toEqual(
      [epic.identifier, story.identifier].sort(),
    );

    // depth 2 → the whole three-level chain.
    const d2 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 2);
    expect(d2.nodes.map((n) => n.identifier).sort()).toEqual(
      [epic.identifier, story.identifier, sub.identifier].sort(),
    );
  });

  it('clamps an omitted / oversized depth (never a whole-tree read)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );

    const dflt = await workItemsService.getBoundedSubtree(epic.id, fx.ctx); // omitted → default 2
    expect(dflt.depth).toBe(2);

    const clamped = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 999); // → max 10
    expect(clamped.depth).toBe(10);
  });

  it('404s (WorkItemNotFoundError) a cross-tenant root', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bEpic = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'epic', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.getBoundedSubtree(bEpic.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('workItemsService.getBlockingClosure', () => {
  // Helper: make `from` is_blocked_by `to` (a dependency edge).
  async function blockedBy(
    fx: Awaited<ReturnType<typeof makeFixture>>,
    fromId: string,
    toId: string,
  ) {
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId,
      toId,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });
  }

  it('walks the transitive is_blocked_by closure', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id); // A blocked_by B
    await blockedBy(fx, b.id, c.id); // B blocked_by C

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx);
    expect(closure.nodes.map((n) => n.identifier).sort()).toEqual(
      [b.identifier, c.identifier].sort(),
    );
    expect(closure.truncated).toBe(false);
    // edges spell A→B and B→C.
    const edgeSet = new Set(closure.edges.map((e) => `${e.blockedId}->${e.blockerId}`));
    expect(edgeSet.has(`${a.id}->${b.id}`)).toBe(true);
    expect(edgeSet.has(`${b.id}->${c.id}`)).toBe(true);
  });

  it('is cycle-safe — the visited-set dedups a node reached by multiple paths', async () => {
    // The core enforces the is_blocked_by graph acyclic (a real A↔B insert is
    // rejected by the DB trigger — WI_LINK_CYCLE), so the visited-set defense is
    // exercised by a DIAMOND: D is reached via BOTH B and C. The second discovery
    // hits the `visited.has` guard — the exact branch that makes a walk terminate
    // on a (hypothetical) cycle: a node is expanded at most once, never looped.
    const fx = await makeFixture();
    const [a, b, c, d] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'D' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id); // A blocked_by B
    await blockedBy(fx, a.id, c.id); // A blocked_by C
    await blockedBy(fx, b.id, d.id); // B blocked_by D
    await blockedBy(fx, c.id, d.id); // C blocked_by D  (D reached twice)

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx);
    // D appears exactly once despite two paths to it; the walk terminates.
    expect(closure.nodes.map((n) => n.identifier).sort()).toEqual(
      [b.identifier, c.identifier, d.identifier].sort(),
    );
    expect(closure.nodes.filter((n) => n.identifier === d.identifier)).toHaveLength(1);
    expect(closure.truncated).toBe(false);
  });

  it('node-caps the closure and flags `truncated`', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id);
    await blockedBy(fx, b.id, c.id);

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx, { maxNodes: 2 });
    // root(1) + B(2) reaches the cap; C is dropped.
    expect(closure.nodes.map((n) => n.identifier)).toEqual([b.identifier]);
    expect(closure.truncated).toBe(true);
  });

  it('depth-caps the walk and flags `truncated`', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id);
    await blockedBy(fx, b.id, c.id);

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx, { maxDepth: 1 });
    expect(closure.nodes.map((n) => n.identifier)).toEqual([b.identifier]); // only level 1
    expect(closure.truncated).toBe(true);
  });

  it('excludes a cross-project blocker (reads only the token’s project)', async () => {
    const fx = await makeFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const root = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Root' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'story', title: 'Foreign' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: root.id,
      toId: foreign.id, // same workspace, DIFFERENT project
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const closure = await workItemsService.getBlockingClosure(root.id, fx.ctx);
    expect(closure.nodes).toEqual([]); // the cross-project blocker is out of scope
    expect(closure.edges).toEqual([]);
    expect(closure.truncated).toBe(false);
  });

  it('404s a cross-tenant root', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bItem = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.getBlockingClosure(bItem.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('workItemsService.listRevisionsPage', () => {
  it('cursor-paginates the change log newest-first', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'V0' },
      fx.ctx,
    );
    // createWorkItem records a `created` revision; two updates add two more.
    await workItemsService.updateWorkItem(item.id, { title: 'V1' }, fx.ctx);
    await workItemsService.updateWorkItem(item.id, { title: 'V2' }, fx.ctx);

    const page1 = await workItemsService.listRevisionsPage(item.id, fx.ctx, { take: 1 });
    expect(page1.revisions).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await workItemsService.listRevisionsPage(item.id, fx.ctx, {
      take: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.revisions).toHaveLength(1);
    // distinct revisions across pages (no repeat at the boundary).
    expect(page2.revisions[0]!.id).not.toBe(page1.revisions[0]!.id);

    // A big take returns everything with no next cursor.
    const all = await workItemsService.listRevisionsPage(item.id, fx.ctx);
    expect(all.revisions.length).toBeGreaterThanOrEqual(3);
    expect(all.nextCursor).toBeNull();
  });

  it('404s a cross-tenant work item', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bItem = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.listRevisionsPage(bItem.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('workItemsService.getRelationshipLinks', () => {
  it('returns the WHOLE graph when no project restriction is given', async () => {
    const fx = await makeFixture();
    // The unrestricted arm is what a caller with a real VIEWER uses — the item
    // page, the MCP — where a cross-project link is a legitimate thing to see.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Target' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Across the boundary' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: target.id,
      toId: foreign.id,
      kind: 'clones',
      createdById: fx.ownerId,
    });

    const links = await workItemsService.getRelationshipLinks(target.id, fx.ctx);
    expect(links.clones.map((l) => l.item.identifier)).toEqual([foreign.identifier]);
    expect(links.blockedBy).toEqual([]);
  });
});

describe('aiBoundaryService — the graph-traversal boundary', () => {
  it('getItem returns the item, and comments/history only when asked', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Item' },
      fx.ctx,
    );
    await commentsService.addComment(item.id, { bodyMd: 'first note' }, fx.ctx);

    const bare = await aiBoundaryService.getItem(fx.projectId, item.identifier, fx.ctx);
    expect(bare.item.identifier).toBe(item.identifier);
    expect(bare.comments).toBeUndefined();
    expect(bare.history).toBeUndefined();

    const rich = await aiBoundaryService.getItem(fx.projectId, item.identifier, fx.ctx, {
      withComments: true,
      withHistory: true,
    });
    expect(rich.comments?.threads).toHaveLength(1);
    expect(rich.history?.revisions.length).toBeGreaterThanOrEqual(1);
  });

  // ── MOTIR-4063 — the WHOLE link set crosses the AI boundary ──────────────
  // The planner read a TREE while the product keeps a GRAPH: `get-item`
  // resolved through the LIGHT work-item shape, so `relates_to` / `duplicates`
  // / `clones` reached motir-ai not at all, and `blocks` did not either —
  // it was assumed reachable because `blocked_by` is, via `walk-blocking`,
  // which has no inverse (planning bug MOTIR-4090).

  /** Seed the target plus one far end per link kind, in `fx`'s project. */
  async function seedAllFiveLinkKinds(fx: Awaited<ReturnType<typeof makeFixture>>): Promise<{
    target: Awaited<ReturnType<typeof workItemsService.createWorkItem>>;
    far: Record<'blockedBy' | 'blocks' | 'relatesTo' | 'duplicates' | 'clones', string>;
  }> {
    const make = (title: string) =>
      workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);
    const target = await make('Target');
    const blocker = await make('Blocker');
    const blocked = await make('Blocked');
    const related = await make('Related');
    const duplicate = await make('Duplicate');
    const clone = await make('Clone');
    const link = (
      fromId: string,
      toId: string,
      kind: 'is_blocked_by' | 'relates_to' | 'duplicates' | 'clones',
    ) =>
      createTestLink({
        workspaceId: fx.workspaceId,
        fromId,
        toId,
        kind,
        createdById: fx.ownerId,
      });
    // `blockedBy` is the OUT edge of `is_blocked_by`; `blocks` is the SAME kind
    // read from the other end — which is exactly why it needs the item payload
    // and cannot ride the one-direction blocking closure.
    await link(target.id, blocker.id, 'is_blocked_by');
    await link(blocked.id, target.id, 'is_blocked_by');
    await link(target.id, related.id, 'relates_to');
    await link(target.id, duplicate.id, 'duplicates');
    await link(target.id, clone.id, 'clones');
    return {
      target,
      far: {
        blockedBy: blocker.identifier,
        blocks: blocked.identifier,
        relatesTo: related.identifier,
        duplicates: duplicate.identifier,
        clones: clone.identifier,
      },
    };
  }

  it('getItem carries ALL FIVE link kinds — asserted per kind, not per group', async () => {
    const fx = await makeFixture();
    const { target, far } = await seedAllFiveLinkKinds(fx);

    const res = await aiBoundaryService.getItem(fx.projectId, target.identifier, fx.ctx);

    // Per KIND. A test covering only `relatesTo` would let the other four
    // regress unseen, which is how `blocks` went missing in the first place.
    for (const kind of ['blockedBy', 'blocks', 'relatesTo', 'duplicates', 'clones'] as const) {
      expect(
        res.item[kind].map((l) => l.item.identifier),
        kind,
      ).toEqual([far[kind]]);
    }
  });

  it('getItem gives every link the KEY, title, kind and STATUS a planner acts on', async () => {
    const fx = await makeFixture();
    const { target, far } = await seedAllFiveLinkKinds(fx);

    const res = await aiBoundaryService.getItem(fx.projectId, target.identifier, fx.ctx);

    // A link to a `done` item and a link to a `todo` item mean opposite things;
    // a bare key would force a second read to find out which.
    expect(res.item.relatesTo[0]?.item).toMatchObject({
      identifier: far.relatesTo,
      title: 'Related',
      kind: 'story',
      status: 'todo',
    });
    // The edge's own id rides along, so a caller can name the link, not just
    // its far end.
    expect(res.item.relatesTo[0]?.linkId).toEqual(expect.any(String));
    expect(res.item.relatesTo[0]?.linkId).not.toBe('');
  });

  it('getItem is ADDITIVE — the shape it carried before is untouched', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Alone' },
      fx.ctx,
    );

    const res = await aiBoundaryService.getItem(fx.projectId, item.identifier, fx.ctx);

    // The pre-existing item fields are unchanged, so a motir-ai that predates
    // the widening reads exactly what it always did and ignores the new keys —
    // which is what lets the two repositories deploy in either order.
    // `decision` (MOTIR-5958) is the next additive key: null on an item that is not a
    // `human` decision, which is every item here.
    // `supersedes` / `supersededBy` (MOTIR-6580) are two more additive link keys.
    // `inFlightCode` / `mergedRepos` (MOTIR-6618) are the next: EMPTY arrays on an
    // item with no delivery anywhere in its chain.
    // `todos` (MOTIR-10316) is the next: an EMPTY array on an item with no steps.
    const {
      blockedBy,
      blocks,
      relatesTo,
      duplicates,
      clones,
      supersedes,
      supersededBy,
      decision,
      inFlightCode,
      mergedRepos,
      todos,
      ...before
    } = res.item;
    expect(decision).toBeNull();
    expect(inFlightCode).toEqual([]);
    expect(mergedRepos).toEqual([]);
    expect(todos).toEqual([]);
    expect(before).toEqual(
      await workItemsService.getWorkItemByIdentifier(fx.projectId, item.identifier, fx.ctx),
    );
    // An item with no links reports EMPTY arrays, never absent keys — the
    // consumer distinguishes "none" from "not readable" on exactly that.
    expect([blockedBy, blocks, relatesTo, duplicates, clones, supersedes, supersededBy]).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('getItem WITHHOLDS a link whose far end is in another project', async () => {
    const fx = await makeFixture();
    // A SECOND project in the SAME workspace: a relationship edge across
    // projects is legal in the UI, so this is a real case and not a
    // defensive one. The job token is scoped to `fx.projectId`.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Target' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Somebody else’s secret' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: target.id,
      toId: foreign.id,
      kind: 'relates_to',
      createdById: fx.ownerId,
    });

    const res = await aiBoundaryService.getItem(fx.projectId, target.identifier, fx.ctx);
    expect(res.item.relatesTo).toEqual([]);

    // ...and the SAME edge is fully visible to the item page, which has a real
    // viewer rather than a project-scoped token. The withholding is the
    // boundary's rule, not a property of the link.
    const detail = await workItemsService.getIssueDetail(fx.projectId, target.identifier, fx.ctx);
    expect(detail.relatesTo.map((l) => l.item.identifier)).toEqual([foreign.identifier]);
  });

  it('getItem assembles the link set in a CONSTANT number of reads — no N+1', async () => {
    const fx = await makeFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Target' },
      fx.ctx,
    );
    // SIX far ends on one kind, so a per-link round trip would show up as six
    // resolves rather than one.
    for (let i = 0; i < 6; i += 1) {
      const related = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: `Related ${i}` },
        fx.ctx,
      );
      await createTestLink({
        workspaceId: fx.workspaceId,
        fromId: target.id,
        toId: related.id,
        kind: 'relates_to',
        createdById: fx.ownerId,
      });
    }

    const fromItem = vi.spyOn(workItemLinkRepository, 'findByFromItem');
    const toItem = vi.spyOn(workItemLinkRepository, 'findByToItem');
    const byIds = vi.spyOn(workItemRepository, 'findByIds');
    try {
      const res = await aiBoundaryService.getItem(fx.projectId, target.identifier, fx.ctx);
      expect(res.item.relatesTo).toHaveLength(6);
      // Five OUT-edge batches + two IN-edge batches (`blocks`, `supersededBy` —
      // MOTIR-6580) + seven far-end resolves. The link COUNT does not appear in
      // any of those numbers.
      expect(fromItem).toHaveBeenCalledTimes(5);
      expect(toItem).toHaveBeenCalledTimes(2);
      expect(byIds).toHaveBeenCalledTimes(7);
    } finally {
      fromItem.mockRestore();
      toItem.mockRestore();
      byIds.mockRestore();
    }
  });

  it('getSubtree returns the skeleton neighborhood with parentKey resolved', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );

    const res = await aiBoundaryService.getSubtree(fx.projectId, epic.identifier, 1, fx.ctx);
    expect(res.root).toBe(epic.identifier);
    expect(res.depth).toBe(1);
    const byKey = new Map(res.nodes.map((n) => [n.key, n]));
    expect(byKey.get(epic.identifier)).toMatchObject({ parentKey: null });
    expect(byKey.get(story.identifier)).toMatchObject({ parentKey: epic.identifier });
  });

  it('walkBlocking maps the closure to identifier keys', async () => {
    const fx = await makeFixture();
    const [a, b] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
    ]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const res = await aiBoundaryService.walkBlocking(fx.projectId, a.identifier, fx.ctx);
    expect(res.root).toBe(a.identifier);
    expect(res.nodes.map((n) => n.key)).toEqual([b.identifier]);
    expect(res.edges).toEqual([{ blockedKey: a.identifier, blockerKey: b.identifier }]);
    expect(res.truncated).toBe(false);
  });
});

// ── MOTIR-6618 — the card's IN-FLIGHT CODE on the planner's item read ─────────
// Where a card's unmerged code lives, per repository: its own OPEN pull request's
// branch, else the nearest ancestor's — off the delivery rows, no provider call.
describe('aiBoundaryService.getItem — inFlightCode', () => {
  type Fx = Awaited<ReturnType<typeof makeFixture>>;

  async function addRepo(fx: Fx, name: string): Promise<{ id: string }> {
    const inst = await adminDb.githubInstallation.upsert({
      where: { installationId: `inst-${fx.workspaceId}` },
      create: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
      update: {},
    });
    return adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: `repo-${randomToken(8)}`,
        owner: 'moooon',
        name,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
      select: { id: true },
    });
  }

  let nextPrNumber = 700;

  async function addPr(
    repoId: string,
    opts: { headRef: string; merged?: boolean; draft?: boolean; baseRef?: string },
  ): Promise<{ id: string; number: number }> {
    const number = nextPrNumber++;
    const row = await adminDb.githubPullRequest.create({
      data: {
        repoId,
        number,
        state: opts.merged ? 'closed' : 'open',
        merged: opts.merged ?? false,
        headRef: opts.headRef,
        baseRef: opts.baseRef ?? 'main',
        draft: opts.draft ?? null,
        provider: 'github',
      },
      select: { id: true },
    });
    return { id: row.id, number };
  }

  async function deliver(fx: Fx, workItemId: string, prId: string, repoId: string) {
    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemDeliveryRepository.add(
        { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: prId, repoId },
        tx,
      ),
    );
  }

  async function chain(fx: Fx) {
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Sub', parentId: story.id },
      fx.ctx,
    );
    return { epic, story, sub };
  }

  it('names an OPEN own delivery — branch is the headRef, source own', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Card' },
      fx.ctx,
    );
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: 'subtask/MOTIR-9-own', draft: true });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'deadbeef',
        checkName: 'build',
        checkSuiteId: '',
        conclusion: 'success',
      },
    });
    await deliver(fx, card.id, pr.id, repo.id);

    const res = await aiBoundaryService.getItem(fx.projectId, card.identifier, fx.ctx);
    expect(res.item.inFlightCode).toEqual([
      {
        repo: 'moooon/motir-core',
        branch: 'subtask/MOTIR-9-own',
        headSha: 'deadbeef',
        prNumber: pr.number,
        prUrl: `https://github.com/moooon/motir-core/pull/${pr.number}`,
        draft: true,
        baseRef: 'main',
        source: 'own',
      },
    ]);
    expect(res.item.mergedRepos).toEqual([]);
  });

  it('a child with no delivery INHERITS its parent story’s open branch, fromKey = the story', async () => {
    const fx = await makeFixture();
    const { story, sub } = await chain(fx);
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: `parent/${story.identifier}-story` });
    await deliver(fx, story.id, pr.id, repo.id);

    const res = await aiBoundaryService.getItem(fx.projectId, sub.identifier, fx.ctx);
    expect(res.item.inFlightCode).toEqual([
      expect.objectContaining({
        repo: 'moooon/motir-core',
        branch: `parent/${story.identifier}-story`,
        prNumber: pr.number,
        source: 'inherited',
        fromKey: story.identifier,
      }),
    ]);
    expect(res.item.mergedRepos).toEqual([]);
  });

  it('own in motir-ai + parent in motir-core → TWO entries, own and inherited', async () => {
    const fx = await makeFixture();
    const { story, sub } = await chain(fx);
    const core = await addRepo(fx, 'motir-core');
    const ai = await addRepo(fx, 'motir-ai');
    const storyPr = await addPr(core.id, { headRef: `parent/${story.identifier}-story` });
    const ownPr = await addPr(ai.id, { headRef: `subtask/${sub.identifier}-ai` });
    await deliver(fx, story.id, storyPr.id, core.id);
    await deliver(fx, sub.id, ownPr.id, ai.id);

    const res = await aiBoundaryService.getItem(fx.projectId, sub.identifier, fx.ctx);
    expect(
      res.item.inFlightCode.map((e) => ({
        repo: e.repo,
        source: e.source,
        branch: e.branch,
        fromKey: e.source === 'inherited' ? e.fromKey : undefined,
      })),
    ).toEqual([
      {
        repo: 'moooon/motir-ai',
        source: 'own',
        branch: `subtask/${sub.identifier}-ai`,
        fromKey: undefined,
      },
      {
        repo: 'moooon/motir-core',
        source: 'inherited',
        branch: `parent/${story.identifier}-story`,
        fromKey: story.identifier,
      },
    ]);
  });

  it('merged is not in-flight: [] plus mergedRepos; nothing anywhere: two empty arrays', async () => {
    const fx = await makeFixture();
    const merged = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Merged' },
      fx.ctx,
    );
    const untouched = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Untouched' },
      fx.ctx,
    );
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: 'subtask/MOTIR-1-done', merged: true });
    await deliver(fx, merged.id, pr.id, repo.id);

    const m = await aiBoundaryService.getItem(fx.projectId, merged.identifier, fx.ctx);
    expect(m.item.inFlightCode).toEqual([]);
    expect(m.item.mergedRepos).toEqual(['moooon/motir-core']);

    const u = await aiBoundaryService.getItem(fx.projectId, untouched.identifier, fx.ctx);
    expect(u.item.inFlightCode).toEqual([]);
    expect(u.item.mergedRepos).toEqual([]);
  });

  it('the ancestor walk is ONE batched delivery read however deep the chain', async () => {
    const fx = await makeFixture();
    const { epic, story, sub } = await chain(fx);
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: `parent/${epic.identifier}-epic` });
    await deliver(fx, epic.id, pr.id, repo.id);

    const batched = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks');
    const perCard = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemWithChecks');
    const perCardLean = vi.spyOn(workItemDeliveryRepository, 'listByWorkItem');
    try {
      const res = await aiBoundaryService.getItem(fx.projectId, sub.identifier, fx.ctx);
      // Two levels up, still one read — carrying the card AND both ancestors.
      expect(res.item.inFlightCode).toEqual([
        expect.objectContaining({ source: 'inherited', fromKey: epic.identifier }),
      ]);
      expect(batched).toHaveBeenCalledTimes(1);
      expect([...batched.mock.calls[0]![0]].sort()).toEqual([epic.id, story.id, sub.id].sort());
      expect(perCard).not.toHaveBeenCalled();
      expect(perCardLean).not.toHaveBeenCalled();
    } finally {
      batched.mockRestore();
      perCard.mockRestore();
      perCardLean.mockRestore();
    }
  });

  it('the WORKSPACE BINDING is what makes the rows visible — unbound, the same read is empty', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Card' },
      fx.ctx,
    );
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: 'subtask/MOTIR-5-bound' });
    await deliver(fx, card.id, pr.id, repo.id);

    // The repository read the service issues, WITHOUT the workspace GUC: the policy
    // hides the row and nothing raises — the failure that looks like an answer.
    const unbound = await db.$transaction((tx) =>
      workItemDeliveryRepository.listByWorkItemsWithChecks([card.id], tx),
    );
    expect(unbound).toEqual([]);

    // The service binds `ctx.workspaceId`, so the same row IS read.
    const res = await aiBoundaryService.getItem(fx.projectId, card.identifier, fx.ctx);
    expect(res.item.inFlightCode).toHaveLength(1);
    expect(res.item.inFlightCode[0]).toMatchObject({
      source: 'own',
      branch: 'subtask/MOTIR-5-bound',
    });
  });
});
