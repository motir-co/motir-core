import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ProjectTreeRowDto, WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { consentedVisitor } from './_consentedVisitor';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The in-app COLLECTION reads, as a Visitor reads them (Story MOTIR-6170 ·
// MOTIR-6644; `epic-privacy.md` §3–§5), through the real resolver and datastore.
// The fixture: a public project with ONE private epic (two children, one
// grandchild) and ONE ordinary epic with a child. Every read called with a
// Visitor context returns none of the three hidden ids and counts only what it
// shows; called with a member's context it returns exactly what it always did,
// hidden rows included.

// Each case builds a whole public project with a private subtree and then drives
// several multi-read services; under a parallel run the first case of the file
// also pays module warm-up, and it measured 12s against the 15s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function publicFixture() {
  const identifier = `VC${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VC ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  const privateEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
  const hiddenA = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden story A',
    parentId: privateEpic.id,
  });
  const hiddenB = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden story B',
    parentId: privateEpic.id,
  });
  const hiddenGrand = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Hidden subtask',
    parentId: hiddenA.id,
  });
  const openEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Open epic' });
  const openStory = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Visible story',
    parentId: openEpic.id,
  });
  const all = [privateEpic, hiddenA, hiddenB, hiddenGrand, openEpic, openStory];
  for (const w of all) {
    await adminDb.workItem.update({ where: { id: w.id }, data: { status: 'todo' } });
  }
  await adminDb.workItem.update({
    where: { id: privateEpic.id },
    data: { publicChildrenHidden: true, storyPoints: 13, estimateMinutes: 240 },
  });
  const visitorCtx = await consentedVisitor(identifier);
  return {
    fx,
    visitor: visitorCtx,
    privateEpic,
    openEpic,
    openStory,
    hiddenIds: [hiddenA.id, hiddenB.id, hiddenGrand.id],
    visibleIds: [privateEpic.id, openEpic.id, openStory.id],
    allIds: all.map((w) => w.id),
  };
}

function flattenForest(nodes: WorkItemTreeNodeDto[]): WorkItemTreeNodeDto[] {
  return nodes.flatMap((n) => [n, ...flattenForest(n.children)]);
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const itemRows = (rows: ProjectTreeRowDto[]) => rows.filter((r) => r.kind !== 'folder');

describe('the items list and its FilterAST search', () => {
  it('a Visitor sees and counts only visible rows; the private epic is marked with its sizing nulled', async () => {
    const t = await publicFixture();
    const list = await workItemsService.getProjectIssuesList(
      t.fx.projectId,
      { sort: DEFAULT_SORT },
      t.visitor,
    );
    expect(ids(list.items)).toEqual([...t.visibleIds].sort());
    expect(list.total).toBe(t.visibleIds.length);
    const epic = list.items.find((i) => i.id === t.privateEpic.id)!;
    expect(epic.childrenHidden).toBe(true);
    expect(epic.storyPoints).toBeNull();
    expect(epic.estimateMinutes).toBeNull();

    const search = await workItemsService.getProjectIssuesList(
      t.fx.projectId,
      { sort: DEFAULT_SORT, filter: { text: 'Hidden' } },
      t.visitor,
    );
    expect(search.items).toEqual([]);
    expect(search.total).toBe(0);
  });

  it('a member reads every row, hidden ones included, with no marker', async () => {
    const t = await publicFixture();
    const list = await workItemsService.getProjectIssuesList(
      t.fx.projectId,
      { sort: DEFAULT_SORT },
      t.fx.ctx,
    );
    expect(ids(list.items)).toEqual([...t.allIds].sort());
    expect(list.total).toBe(t.allIds.length);
    expect(list.items.some((i) => 'childrenHidden' in i)).toBe(false);
    const search = await workItemsService.getProjectIssuesList(
      t.fx.projectId,
      { sort: DEFAULT_SORT, filter: { text: 'Hidden' } },
      t.fx.ctx,
    );
    expect(search.total).toBe(3);
  });
});

describe('the tree', () => {
  it('the lazy root keeps the private epic with no drill, and its child level is empty', async () => {
    const t = await publicFixture();
    const root = await workItemsService.listRootIssues(
      t.fx.projectId,
      { sort: DEFAULT_SORT },
      t.visitor,
    );
    const epic = itemRows(root.rows).find((r) => r.id === t.privateEpic.id) as {
      hasChildren: boolean;
      childrenHidden?: true;
      storyPoints: number | null;
    };
    expect(epic.childrenHidden).toBe(true);
    expect(epic.hasChildren).toBe(false);
    expect(epic.storyPoints).toBeNull();
    for (const id of t.hiddenIds) expect(ids(itemRows(root.rows))).not.toContain(id);

    const level = await workItemsService.listChildIssues(
      t.privateEpic.id,
      { sort: DEFAULT_SORT },
      t.visitor,
    );
    expect(level.rows).toEqual([]);
    expect(level.total).toBe(0);

    // A hidden id is not a parent a Visitor can drill into.
    await expect(
      workItemsService.listChildIssues(t.hiddenIds[0]!, { sort: DEFAULT_SORT }, t.visitor),
    ).rejects.toThrow();
  });

  it('the filtered forest drops every hidden node', async () => {
    const t = await publicFixture();
    const forest = flattenForest(
      await workItemsService.getProjectTree(t.fx.projectId, {}, t.visitor),
    );
    expect(ids(forest)).toEqual([...t.visibleIds].sort());
    const epic = forest.find((n) => n.id === t.privateEpic.id)!;
    expect(epic.childrenHidden).toBe(true);
    expect(epic.children).toEqual([]);
  });

  it('a member drills the private epic and sees its children', async () => {
    const t = await publicFixture();
    const level = await workItemsService.listChildIssues(
      t.privateEpic.id,
      { sort: DEFAULT_SORT },
      t.fx.ctx,
    );
    expect(level.total).toBe(2);
    const forest = flattenForest(
      await workItemsService.getProjectTree(t.fx.projectId, {}, t.fx.ctx),
    );
    expect(ids(forest)).toEqual([...t.allIds].sort());
  });
});

describe('the board', () => {
  it('no column holds a hidden card, and every count is over visible cards', async () => {
    const t = await publicFixture();
    const board = await boardsService.getBoard(t.fx.projectId, t.visitor);
    const cards = board.columns.flatMap((c) => c.cards);
    for (const id of t.hiddenIds) expect(cards.map((c) => c.id)).not.toContain(id);
    const total = board.columns.reduce((sum, c) => sum + c.totalCount, 0);
    expect(total).toBe(cards.length);
    expect(ids(cards)).toEqual([...t.visibleIds].sort());

    // MOTIR-6648 — the private epic's card is marked for the Visitor, never for a member.
    expect(cards.find((c) => c.id === t.privateEpic.id)?.childrenHidden).toBe(true);
    // …and reads childless, as the roadmap root does (MOTIR-10534).
    expect(cards.find((c) => c.id === t.privateEpic.id)?.hasChildren).toBe(false);
    const memberBoard = await boardsService.getBoard(t.fx.projectId, t.fx.ctx);
    expect(memberBoard.columns.flatMap((c) => c.cards).some((c) => 'childrenHidden' in c)).toBe(
      false,
    );
    expect(ids(memberBoard.columns.flatMap((c) => c.cards))).toEqual([...t.allIds].sort());
    expect(
      memberBoard.columns.flatMap((c) => c.cards).find((c) => c.id === t.privateEpic.id)
        ?.hasChildren,
    ).toBe(true);
  });
});

describe('the quick view', () => {
  it("the Visitor's peek of the private epic is marked Not public; a member's is not (MOTIR-10534)", async () => {
    const t = await publicFixture();
    const peek = await workItemsService.getVisitorQuickView(
      t.privateEpic.identifier,
      t.visitor,
      'en',
    );
    expect(peek.childrenHidden).toBe(true);
    const memberPeek = await workItemsService.getQuickView(
      t.fx.projectId,
      t.privateEpic.identifier,
      'workspace',
      t.fx.ctx,
      'en',
    );
    expect('childrenHidden' in memberPeek).toBe(false);
  });
});

describe('the roadmap', () => {
  it('the root keeps the private epic with no drill or progress; its level is empty', async () => {
    const t = await publicFixture();
    const root = await workItemsService.getProjectRoadmap(t.fx.projectId, null, t.visitor);
    const epic = root.nodes.find((n) => n.id === t.privateEpic.id)!;
    expect(epic.childrenHidden).toBe(true);
    expect(epic.hasChildren).toBe(false);
    expect(epic.progress).toBeNull();
    const level = await workItemsService.getProjectRoadmap(
      t.fx.projectId,
      t.privateEpic.id,
      t.visitor,
    );
    expect(level.nodes).toEqual([]);
    expect(level.levelTotal).toBe(0);

    const memberLevel = await workItemsService.getProjectRoadmap(
      t.fx.projectId,
      t.privateEpic.id,
      t.fx.ctx,
    );
    expect(memberLevel.levelTotal).toBe(2);
  });

  // The card's `motir fix` action reads each node's fix reason (MOTIR-10509). A
  // member's read carries it; a Visitor has no command to copy, so theirs never does.
  it('a member sees each node’s fix reason; a Visitor never does', async () => {
    const t = await publicFixture();
    await adminDb.workItem.update({
      where: { id: t.openStory.id },
      data: { status: 'in_review', fixReason: 'changes_requested' },
    });
    const member = await workItemsService.getProjectRoadmap(
      t.fx.projectId,
      t.openEpic.id,
      t.fx.ctx,
    );
    expect(member.nodes.find((n) => n.id === t.openStory.id)!.fixReason).toBe('changes_requested');
    const visitor = await workItemsService.getProjectRoadmap(
      t.fx.projectId,
      t.openEpic.id,
      t.visitor,
    );
    expect(visitor.nodes.find((n) => n.id === t.openStory.id)!.fixReason).toBeNull();
    // A node with nothing to fix carries `null` on the member read too.
    const root = await workItemsService.getProjectRoadmap(t.fx.projectId, null, t.fx.ctx);
    expect(root.nodes.find((n) => n.id === t.openEpic.id)!.fixReason).toBeNull();
  });
});

describe('the Ready set', () => {
  it('a Visitor never sees a hidden leaf; a member does', async () => {
    const t = await publicFixture();
    const visitorReady = await workItemsService.listReady(t.fx.projectId, {}, t.visitor);
    for (const id of t.hiddenIds) expect(visitorReady.items.map((i) => i.id)).not.toContain(id);
    const memberReady = await workItemsService.listReady(t.fx.projectId, {}, t.fx.ctx);
    expect(memberReady.items.map((i) => i.id)).toContain(t.hiddenIds[1]);
  });
});

describe('the Visitor gate', () => {
  it('another project id is the same not-found a stranger gets', async () => {
    const t = await publicFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: `OT${seq++}` });
    await expect(
      workItemsService.getProjectIssuesList(other.projectId, { sort: DEFAULT_SORT }, t.visitor),
    ).rejects.toThrow(/not found/i);
    await expect(boardsService.getBoard(other.projectId, t.visitor)).rejects.toThrow(/not found/i);
  });
});
