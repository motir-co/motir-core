import { isTypeableKind } from '@/lib/issues/executorDefaults';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { plansService } from '@/lib/services/plansService';
import { sprintsService } from '@/lib/services/sprintsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueType } from '@/lib/issues/parentRules';
import {
  isCoverageAdvisory,
  isMislabelledLinkAdvisory,
  isReferenceAdvisory,
} from '@/lib/dto/workItems';
import type { ExecutorDto, WorkItemTypeDto, WorkItemValidityDto } from '@/lib/dto/workItems';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import {
  MOTIR_6236_DESIGN_CARD_CRITERIA,
  MOTIR_6241_DESIGN_CARD_CRITERIA,
} from '../fixtures/designCardCriteria';
import { createTestProject } from '../fixtures/projectFixtures';
import { fixture as sectionsFixture } from '../unit/workItems/sections/helpers/sectionFixture';
import { adminDb } from '../helpers/adminDb';
import { seedBlockedBy } from '../helpers/seedBlockedBy';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// `validate_work_item` (Subtask 7.8.23) over real Postgres — the single-item
// analogue of `validate_sprint`: is a work item's whole SUBTREE finishable? We
// assert the engine (`workItemsService.validateWorkItem`) directly for the
// rule's branches — in-subtree blocker (valid) / external not-done (invalid both
// conditions) / external DONE (valid loose, invalid tight) / deep grandchild /
// done-member skip / archived blocker ignored / the typed not-found — then the
// MCP tool round-trip + summary branches through the in-memory client.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'validate-work-item', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// Typed so the fixture is not UNDER-AUTHORED (MOTIR-5427): a bare leaf carries that
// advisory, and these suites assert on the OTHER families.
const mk = (
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  title: string,
  kind: IssueType,
  parentId?: string,
) =>
  workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      parentId,
      ...(isTypeableKind(kind) ? { type: 'code' as const } : {}),
    },
    fx.ctx,
  );

// Written BELOW the link door: this file tests the VALIDATOR over whatever edges
// the tree carries, and most of its "outside the subtree" blockers are ROOT
// tasks — a different depth from the members they gate. Such an edge is a
// `crossLevelEdges` entry (MOTIR-6509), so a case asserting `valid: true` wires
// a same-level edge instead.
const link = (fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, fromId: string, toId: string) =>
  seedBlockedBy(fx, fromId, toId);

const markDone = (id: string) =>
  adminDb.workItem.update({ where: { id }, data: { status: 'done' } });

describe('workItemsService.validateWorkItem — the subtree finishability rule', () => {
  it('a childless target with no blockers is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Lonely task', 'task');
    const result = await workItemsService.validateWorkItem(fx.projectId, task.identifier, fx.ctx);
    expect(result).toEqual({
      key: task.identifier,
      valid: true,
      blockers: [],
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [],
      sectionFindings: expect.any(Array),
    });
  });

  it('a target whose blockers are all IN its SUBTREE is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const childA = await mk(fx, 'Child A', 'subtask', story.id);
    const childB = await mk(fx, 'Child B', 'subtask', story.id);
    await link(fx, childA.id, childB.id); // A blocked_by B — both inside the subtree

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('a NOT-done blocker OUTSIDE the subtree is INVALID under BOTH loose and tight', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External todo', 'task'); // out of subtree, todo
    await link(fx, child.id, external.id);

    const expected = [
      {
        item: child.identifier,
        blockedBy: external.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ];
    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(false);
    expect(loose.blockers).toEqual(expected);

    const tight = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers).toEqual(expected);
  });

  it('a DONE blocker OUTSIDE the subtree satisfies loose but gates tight', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    // Root → root: the same level, so only the finishability rule is asked
    // (a subtask → root task would be `crossLevelEdges`, MOTIR-6509).
    await link(fx, story.id, externalDone.id);

    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(true);
    expect(loose.blockers).toEqual([]);

    const tight = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers).toEqual([
      {
        item: story.identifier,
        blockedBy: externalDone.identifier,
        blockerStatus: 'done',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DEEP grandchild gated by out-of-subtree work surfaces at the grandchild', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const task = await mk(fx, 'Task', 'task', story.id); // story → task
    const grandchild = await mk(fx, 'Grandchild', 'subtask', task.id); // task → subtask
    const external = await mk(fx, 'External todo', 'task');
    await link(fx, grandchild.id, external.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual([
      {
        item: grandchild.identifier,
        blockedBy: external.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DONE in-subtree member needs no check — its open external blocker no longer gates', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External todo', 'task');
    await link(fx, child.id, external.id);
    await markDone(child.id);
    await markDone(story.id); // the whole subtree is done — nothing left to finish

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('an ARCHIVED external blocker never gates the target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External archived', 'task');
    await link(fx, child.id, external.id);
    await adminDb.workItem.update({ where: { id: external.id }, data: { archivedAt: new Date() } });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('condition defaults to loose when omitted', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    await link(fx, story.id, externalDone.id); // root → root: same level

    const omitted = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(omitted).toEqual(loose);
    expect(omitted.valid).toBe(true);
  });

  it('an unknown key → WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.validateWorkItem(fx.projectId, 'PROD-999999', fx.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('a cross-workspace key reads as not-found (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    // A's item, validated through the OUTSIDER's context → 404, never a success.
    await expect(
      workItemsService.validateWorkItem(fx.projectId, story.identifier, outsider.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });
});

// MOTIR-6354 / MOTIR-6368 — `softBlocks`: an ANCESTOR's open blocker reaches the
// target only through the readiness cascade (overridable with
// `--allow-soft-block`). It is REPORTED, never gating: `valid` stays "can this
// subtree finish".
describe('workItemsService.validateWorkItem — softBlocks (MOTIR-6368)', () => {
  it('a story whose epic is blocked_by an open epic is VALID with one softBlocks entry naming the epic', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Parent epic', 'epic');
    const openEpic = await mk(fx, 'Open epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    await link(fx, epic.id, openEpic.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result).toEqual({
      key: story.identifier,
      valid: true,
      blockers: [],
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [
        {
          via: { key: epic.identifier, title: 'Parent epic' },
          blockedBy: { key: openEpic.identifier, title: 'Open epic' },
          blockerStatus: 'todo',
        },
      ],
      sectionFindings: expect.any(Array),
    });
  });

  it('walks the WHOLE ancestor chain, skips a DONE ancestor blocker, and sorts by via then blocker', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    const subtask = await mk(fx, 'Subtask', 'subtask', story.id);
    const epicBlocker = await mk(fx, 'Epic blocker', 'task');
    const storyBlocker = await mk(fx, 'Story blocker', 'task');
    const doneBlocker = await mk(fx, 'Done blocker', 'task');
    await markDone(doneBlocker.id);
    await link(fx, story.id, storyBlocker.id);
    await link(fx, epic.id, epicBlocker.id);
    await link(fx, epic.id, doneBlocker.id); // satisfied — not a soft block
    // The subtask is done: the verdict short-circuits, softBlocks is still read.
    await markDone(subtask.id);

    const result = await workItemsService.validateWorkItem(
      fx.projectId,
      subtask.identifier,
      fx.ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.softBlocks).toEqual([
      {
        via: { key: epic.identifier, title: 'Epic' },
        blockedBy: { key: epicBlocker.identifier, title: 'Epic blocker' },
        blockerStatus: 'todo',
      },
      {
        via: { key: story.identifier, title: 'Story' },
        blockedBy: { key: storyBlocker.identifier, title: 'Story blocker' },
        blockerStatus: 'todo',
      },
    ]);
  });

  it('an UNBLOCKED ancestor chain reports no soft blocks', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.softBlocks).toEqual([]);
  });

  it('soft blocks never change the verdict — an INVALID target keeps its own blockers and lists the soft ones beside them, in the MCP text too', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    const openEpic = await mk(fx, 'Open epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    // A story under the OTHER epic: the same level as `story`, and its parents'
    // edge (epic → openEpic) is carried, so only finishability is asked.
    const outside = await mk(fx, 'Outside story', 'story', openEpic.id);
    await link(fx, epic.id, openEpic.id);
    await link(fx, story.id, outside.id); // the story's OWN out-of-subtree blocker

    const client = await connectClient(fx.ctx);
    const invalid = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    const body = invalid.structuredContent as unknown as WorkItemValidityDto;
    expect(body.valid).toBe(false);
    expect(body.blockers.map((b) => b.blockedBy)).toEqual([outside.identifier]);
    expect(body.softBlocks).toHaveLength(1);
    const invalidText = JSON.stringify(invalid.content);
    expect(invalidText).toContain('Soft blocks (1, do NOT affect validity)');
    expect(invalidText).toContain(
      `${epic.identifier} \\"Epic\\" is blocked by ${openEpic.identifier}`,
    );

    await markDone(outside.id);
    const valid = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect((valid.structuredContent as unknown as WorkItemValidityDto).valid).toBe(true);
    const validText = JSON.stringify(valid.content);
    expect(validText).toContain('is VALID');
    expect(validText).toContain('Soft blocks (1, do NOT affect validity)');
  });
});

describe('validate_work_item MCP tool round-trip', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('reports a VALID work item via the client (lowercase key resolves)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier.toLowerCase() },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(struct(res).valid).toBe(true);
    expect(struct(res).key).toBe(story.identifier);
    expect(text(res)).toContain('is VALID');
    await client.close();
  });

  it('condition: tight reports a done out-of-subtree blocker the loose default accepts', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    await link(fx, story.id, externalDone.id); // root → root: same level

    const client = await connectClient(fx.ctx);
    const loose = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect(struct(loose).valid).toBe(true);

    const tight = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier, condition: 'tight' },
    })) as CallToolResult;
    expect(tight.isError).toBeFalsy();
    expect(struct(tight).valid).toBe(false);
    expect(struct(tight).blockers).toHaveLength(1);
    expect(text(tight)).toContain('is INVALID');
    await client.close();
  });

  it('renders an out-of-subtree blocker that sits in a SPRINT with its sprint id', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External in a sprint', 'task'); // out of subtree, todo
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    await adminDb.workItem.update({ where: { id: external.id }, data: { sprintId: sprint.id } });
    await link(fx, child.id, external.id);

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect(struct(res).valid).toBe(false);
    expect(struct(res).blockers[0]).toMatchObject({
      item: child.identifier,
      blockedBy: external.identifier,
      blockerSprintId: sprint.id,
    });
    // the "sprint <id>" summary branch (vs "backlog") renders.
    expect(text(res)).toContain(`sprint ${sprint.id}`);
    await client.close();
  });

  it('surfaces WORK_ITEM_NOT_FOUND as a clean tool error for an unknown key', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: 'PROD-999999' },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('WORK_ITEM_NOT_FOUND');
    await client.close();
  });
});

// ── The PROSE-vs-GRAPH advisory (MOTIR-1969) ─────────────────────────────────
//
// A card's body NAMES a not-`done` work item it carries no `blocked_by` edge to.
// The advisory rides a SEPARATE channel: it NEVER changes `valid` / `blockers`,
// and never `ready` / `openBlockers`. Fixtures are named after the six real
// misses the check was filed from (MOTIR-1936 · MOTIR-1942/MOTIR-1785 ·
// MOTIR-1826 · MOTIR-1834 · MOTIR-1806 · MOTIR-2011/MOTIR-2007).

/** A `[label](motir:<id>)` reference token, as every card in this family carries. */
const ref = (label: string, id: string) => `[${label}](motir:${id})`;

const mkBody = (
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  title: string,
  kind: IssueType,
  descriptionMd: string,
  parentId?: string,
) =>
  workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      descriptionMd,
      parentId,
      ...(isTypeableKind(kind) ? { type: 'code' as const } : {}),
    },
    fx.ctx,
  );

describe('workItemsService.validateWorkItem — the prose-vs-graph advisory', () => {
  it('MOTIR-1785: a body naming a not-done item with only a `relates_to` edge advises — and stays VALID', async () => {
    const fx = await makeWorkItemFixture();
    // MOTIR-1900's requirement written INTO MOTIR-1785's body as prose: the body
    // reference auto-creates a `relates_to`, which is PRECISELY what the miss
    // looks like — a `relates_to` where a `blocked_by` belonged.
    const requirement = await mk(fx, 'MOTIR-1900 the surface it consumes', 'task');
    const card = await mkBody(
      fx,
      'MOTIR-1785 E2E',
      'task',
      `This walks the recipe built by ${ref('MOTIR-1900', requirement.id)}.`,
    );

    // The `relates_to` edge really is there — the advisory is not firing because
    // the graph is empty, it is firing because the graph has the WRONG edge.
    const detail = await workItemsService.getIssueDetail(fx.projectId, card.identifier, fx.ctx);
    expect(detail.relatesTo.map((l) => l.item.identifier)).toContain(requirement.identifier);
    expect(detail.blockedBy).toEqual([]);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.advisories).toEqual([
      {
        item: card.identifier,
        referenced: requirement.identifier,
        referencedStatus: 'todo',
        severity: 'advisory',
      },
    ]);
  });

  it('MOTIR-2011: a reference inside the ACCEPTANCE CRITERIA is `likely-missing-edge`, deduped across occurrences', async () => {
    const fx = await makeWorkItemFixture();
    // Two of MOTIR-2011's five ACs named MOTIR-2007's unmerged deliverables.
    const deliverable = await mk(fx, 'MOTIR-2007 deadline plumbing', 'bug');
    const card = await mkBody(
      fx,
      'MOTIR-2011 boot deadlines',
      'bug',
      [
        '## Acceptance criteria',
        `- reuses the FLEET_TIME_BUDGETS shape from ${ref('MOTIR-2007', deliverable.id)}`,
        `- the poll/settle shape matches ${ref('MOTIR-2007', deliverable.id)}`,
        '- three more criteria that name nothing',
      ].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories).toEqual([
      {
        item: card.identifier,
        referenced: deliverable.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
    ]);
  });

  it('the SAME item named only OUTSIDE the acceptance-criteria section is the plain `advisory` tier', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Other', 'task');
    const card = await mkBody(
      fx,
      'Names it in context only',
      'task',
      [
        `Context: the owner of the other half is ${ref('OTHER', other.id)}.`,
        '',
        '## Acceptance criteria',
        '- nothing named here',
      ].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories.map((a) => a.severity)).toEqual(['advisory']);
  });

  it('a card with NO acceptance-criteria heading emits plain `advisory` and no error', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Other', 'task');
    const card = await mkBody(
      fx,
      'ACs inline in prose',
      'task',
      `It is done when ${ref('OTHER', other.id)} is wired. No headings anywhere.`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    // The section heuristic DEGRADES — it never suppresses the advisory.
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]?.severity).toBe('advisory');
  });

  it('NO TIER IS A BLOCKER — a `likely-missing-edge` card is still valid AND ready with no open blockers', async () => {
    // The load-bearing design decision. Three real shapes would be FALSELY
    // BLOCKED if this were a gate, and all three are legitimate:
    //   1. a boundary-CONTRACT card whose ACs name both halves of a two-PR split
    //      (`run.md` guard #5 explicitly blesses this shape);
    //   2. an AC that names a card for CONTRAST ("unlike MOTIR-X, this does not…");
    //   3. an AC naming a card that will be `done` before this one is dispatched.
    // Blocking any of them produces the write-WORSE-cards incentive the advisory
    // exists to avoid, so severity — not enforcement — is the honest instrument.
    const fx = await makeWorkItemFixture();
    const half = await mk(fx, 'The other half of the contract', 'task');
    const card = await mkBody(
      fx,
      'Boundary-contract card',
      'task',
      `## Acceptance criteria\n- the producer in ${ref('OTHER', half.id)} and this consumer agree`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories[0]?.severity).toBe('likely-missing-edge');
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);

    const detail = await workItemsService.getIssueDetail(fx.projectId, card.identifier, fx.ctx);
    expect(detail.readiness.ready).toBe(true);
    expect(detail.readiness.openBlockers).toEqual([]);
  });

  it('NO advisory for a DONE referenced item, a SELF-reference, an ANCESTOR, or an existing `blocked_by`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Parent story', 'story');
    const finished = await mk(fx, 'Already shipped', 'task');
    await markDone(finished.id);
    // One level down under a root of its own, at the card's depth, so the real
    // edge is same-level and raises no cross-level advisory (MOTIR-6411).
    const gate = await mk(fx, 'A real dependency', 'task', (await mk(fx, 'Elsewhere', 'story')).id);
    const card = await mk(fx, 'The card', 'subtask', story.id);
    await link(fx, card.id, gate.id); // a REAL blocked_by edge

    await workItemsService.updateWorkItem(
      card.id,
      {
        descriptionMd: [
          `Builds on ${ref('DONE', finished.id)} (done — nothing to warn about).`,
          `Itself: ${ref('SELF', card.id)}.`,
          `Its parent: ${ref('PARENT', story.id)}.`,
          `Its real gate: ${ref('GATE', gate.id)}.`,
        ].join('\n'),
      },
      fx.ctx,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.advisories).toEqual([]);
  });

  it('MOTIR-1936: validating an EPIC surfaces a DESCENDANT card’s missing edge (the family this was filed from)', async () => {
    // The whole point of scanning the subtree, not just the validated root: the
    // planner validates the STORY/EPIC after a re-plan, while every miss in this
    // family sat in a LEAF card's body (MOTIR-1907 named the fleet's provisioning
    // path; MOTIR-1920/1921/1922 were todo with no edge).
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    const owner = await mk(fx, 'MOTIR-1920 the provisioning path', 'subtask', story.id);
    const donor = await mkBody(
      fx,
      'MOTIR-1907 the legible stop',
      'subtask',
      `## Acceptance criteria\n- disables actions via the path ${ref('MOTIR-1920', owner.id)} builds`,
      story.id,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, epic.identifier, fx.ctx);
    expect(result.valid).toBe(true); // an in-subtree blocker never gates
    expect(result.advisories).toEqual([
      {
        item: donor.identifier,
        referenced: owner.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
    ]);
  });

  it('MULTIPLE advisories are ordered deterministically — by scanned card, then by reference', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const alpha = await mk(fx, 'Alpha dependency', 'task');
    const beta = await mk(fx, 'Beta dependency', 'task');
    // TWO references in ONE card (the tie-break) …
    const first = await mkBody(
      fx,
      'First child',
      'subtask',
      `## Acceptance criteria\n- needs ${ref('B', beta.id)} and ${ref('A', alpha.id)}`,
      story.id,
    );
    // … and a THIRD in a sibling card (the primary sort key).
    const second = await mkBody(
      fx,
      'Second child',
      'subtask',
      `Context: ${ref('A', alpha.id)}.`,
      story.id,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.advisories).toEqual([
      {
        item: first.identifier,
        referenced: alpha.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
      {
        item: first.identifier,
        referenced: beta.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
      {
        item: second.identifier,
        referenced: alpha.identifier,
        referencedStatus: 'todo',
        severity: 'advisory',
      },
    ]);
  });

  it('a DONE member is not scanned — its prose is history, not an unmet dependency', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Still open', 'task');
    const card = await mkBody(fx, 'Shipped card', 'task', `Names ${ref('OTHER', other.id)}.`);
    await markDone(card.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories).toEqual([]);
  });

  it('a MALFORMED id is body text — ignored; an UNKNOWN id is a dead link, never an error (MOTIR-9007)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await mkBody(
      fx,
      'Bad refs',
      'task',
      ['[X](motir:)', `${ref('GHOST', 'cl_does_not_exist')}`, '[Y(motir:nope)'].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    // The two MALFORMED tokens are not links at all. The well-formed one opens
    // nothing — no REFERENCE advisory (there is no far end), but the link itself
    // is reported, as a shape advisory with no target.
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: 'GHOST',
        targetId: 'cl_does_not_exist',
        targetKey: null,
      },
    ]);
    expect(result.valid).toBe(true);
  });

  it('an id in ANOTHER WORKSPACE is omitted (no cross-tenant leak)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other tenant', identifier: 'ZULU' });
    const foreign = await mk(other, 'Foreign item', 'task');
    const card = await mkBody(
      fx,
      'Names a foreign id',
      'task',
      `See ${ref('ZULU-1', foreign.id)}.`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    // No reference advisory, and the dead-link advisory reads EXACTLY as an
    // unknown id does — `targetKey: null`, nothing about the other tenant.
    expect(result.advisories.filter(isReferenceAdvisory)).toEqual([]);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: 'ZULU-1',
        targetId: foreign.id,
        targetKey: null,
      },
    ]);
  });

  it('an id in a project the caller cannot BROWSE is omitted (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    // A PRIVATE sibling project in the same workspace: a plain workspace member
    // (no project role) cannot browse it, so its items must never be named.
    const secretProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SECRET',
    });
    await adminDb.project.update({
      where: { id: secretProject.id },
      data: projectAccessData('members'),
    });
    const secretItem = await workItemsService.createWorkItem(
      { projectId: secretProject.id, kind: 'task', title: 'Classified' },
      fx.ctx,
    );
    const card = await mkBody(
      fx,
      'Names a private item',
      'task',
      `## Acceptance criteria\n- needs ${ref('SECRET-1', secretItem.id)}`,
    );

    // The OWNER sees it (an always-pass role) …
    const asOwner = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(asOwner.advisories.filter(isReferenceAdvisory).map((a) => a.referenced)).toEqual([
      secretItem.identifier,
    ]);

    // … a plain workspace member does not.
    const plain = await usersService.createUser({
      email: `plain-${secretProject.id}@ex.com`,
      password: 'correct-horse-battery-staple',
      name: 'Plain',
    });
    await workspacesService.addMember({ userId: plain.id, workspaceId: fx.workspaceId });
    const plainCtx: ServiceContext = { userId: plain.id, workspaceId: fx.workspaceId };
    const asPlain = await workItemsService.validateWorkItem(
      fx.projectId,
      card.identifier,
      plainCtx,
    );
    // No reference advisory — and the link reads as a dead one, byte-identical
    // to an id that exists nowhere, so it leaks nothing about SECRET-1.
    expect(asPlain.advisories.filter(isReferenceAdvisory)).toEqual([]);
    expect(asPlain.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: 'SECRET-1',
        targetId: secretItem.id,
        targetKey: null,
      },
    ]);
    // The owner, who CAN open it, sees a correctly labelled link — nothing.
    expect(asOwner.advisories.filter(isMislabelledLinkAdvisory)).toEqual([]);
  });
});

describe('validate_work_item MCP tool — advisories in the dual content', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('a VALID item with a `likely-missing-edge` advisory still reads VALID, with the advisory named', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Unwired dependency', 'task');
    const card = await mkBody(
      fx,
      'Card',
      'task',
      `## Acceptance criteria\n- consumes ${ref('OTHER', other.id)}`,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    expect(struct(res).advisories).toHaveLength(1);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain('IN ITS ACCEPTANCE CRITERIA');
    expect(text(res)).toContain(other.identifier);
    await client.close();
  });

  it('an INVALID item ALSO reports its advisories — the two channels are independent', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    // Out of subtree, todo — one level down under its own root, at the child's
    // depth, so the edge is same-level (MOTIR-6411).
    const external = await mk(fx, 'External gate', 'task', (await mk(fx, 'Elsewhere', 'story')).id);
    const named = await mk(fx, 'Named but unwired', 'task');
    const child = await mkBody(
      fx,
      'Child',
      'subtask',
      `## Acceptance criteria\n- consumes ${ref('NAMED', named.id)}`,
      story.id,
    );
    await link(fx, child.id, external.id); // a REAL out-of-subtree blocker

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(false);
    expect(struct(res).blockers).toHaveLength(1);
    expect(struct(res).advisories).toEqual([
      {
        item: child.identifier,
        referenced: named.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
    ]);
    expect(text(res)).toContain('is INVALID');
    expect(text(res)).toContain('unaffected'); // the advisory block's INVALID phrasing
    await client.close();
  });

  it('an item with no advisories carries an empty array and no advisory prose', async () => {
    const fx = await makeWorkItemFixture();
    const card = await mk(fx, 'Clean card', 'task');
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).advisories).toEqual([]);
    expect(text(res)).not.toContain('NOT a blocker');
    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MISLABELLED-LINK ADVISORY (MOTIR-9007) — a `[label](motir:<id>)` link whose
// label names one key while the id opens another card, or opens none. The
// projected (`planId`) half is pinned in
// `tests/integration/plans/planValidityService.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

describe('workItemsService.validateWorkItem — the MISLABELLED-LINK advisory', () => {
  const mislabelled = (r: WorkItemValidityDto) => r.advisories.filter(isMislabelledLinkAdvisory);

  it('AC1: a link labelled with one key that opens ANOTHER card names the label, the id and the real key', async () => {
    const fx = await makeWorkItemFixture();
    const meant = await mk(fx, 'The card the label names', 'task'); // PROD-1
    const opened = await mk(fx, 'The card the id opens', 'task'); // PROD-2
    const card = await mkBody(
      fx,
      'Card with a crossed link',
      'task',
      `See ${ref(meant.identifier, opened.id)} for the gateway address.`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: meant.identifier,
        targetId: opened.id,
        targetKey: opened.identifier,
      },
    ]);
    // An advisory, never a blocker.
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('AC1: a link whose label MATCHES its target raises nothing — in any case', async () => {
    const fx = await makeWorkItemFixture();
    const target = await mk(fx, 'Target', 'task');
    const card = await mkBody(
      fx,
      'Card with good links',
      'task',
      `${ref(target.identifier, target.id)} and ${ref(target.identifier.toLowerCase(), target.id)}`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([]);
  });

  it('AC2: a link to an id that names NO card reports `targetKey: null`, whatever its label', async () => {
    const fx = await makeWorkItemFixture();
    const card = await mkBody(
      fx,
      'Card with dead links',
      'task',
      `${ref('PROD-4202', 'cmtehjd4s00kjhwphdoxk2mwz')} and ${ref('the ReDoS guard', 'cl_nowhere')}`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([
      // Ordered by target id, then label — `cl_…` sorts before `cm…`.
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: 'the ReDoS guard',
        targetId: 'cl_nowhere',
        targetKey: null,
      },
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: 'PROD-4202',
        targetId: 'cmtehjd4s00kjhwphdoxk2mwz',
        targetKey: null,
      },
    ]);
  });

  it('AC4: a NAME label on an existing card, or a key-shaped word no project carries, raises nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await mk(fx, 'Target', 'task');
    const card = await mkBody(
      fx,
      'Card with name labels',
      'task',
      `${ref('Epic 10', target.id)}, ${ref('the export flow', target.id)}, ${ref('UTF-8 handling', target.id)}`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([]);
  });

  it("a key in ANOTHER project of the workspace is a key too — the target's own prefix is not the only one", async () => {
    const fx = await makeWorkItemFixture();
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ZETA',
    });
    await workItemsService.createWorkItem(
      { projectId: sibling.id, kind: 'task', title: 'Over there' },
      fx.ctx,
    );
    const here = await mk(fx, 'Here', 'task');
    // The service may normalize the requested key, so read the one it stored.
    const otherKey = `${sibling.identifier}-1`;
    const card = await mkBody(fx, 'Card', 'task', `See ${ref(otherKey, here.id)}.`);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result).map((a) => [a.label, a.targetKey])).toEqual([
      [otherKey, here.identifier],
    ]);
  });

  it('AC4: a body with MANY links resolves every id in ONE read, not one per link', async () => {
    const fx = await makeWorkItemFixture();
    const targets: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 6; i++) targets.push(await mk(fx, `Target ${i}`, 'task'));
    const body = [
      ...targets.map((t, i) => ref(targets[(i + 1) % targets.length]!.identifier, t.id)),
      ref('PROD-999', 'cl_missing_one'),
      ref('PROD-998', 'cl_missing_two'),
    ].join('\n');
    const card = await mkBody(fx, 'Card with many links', 'task', body);

    const spy = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');
    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(spy.mock.calls[0]![0])).toEqual(
      new Set([...targets.map((t) => t.id), 'cl_missing_one', 'cl_missing_two']),
    );
    // Every one of the eight is mislabelled: six crossed, two dead.
    expect(mislabelled(result)).toHaveLength(8);
  });

  it('a DONE member is not scanned — its links are history', async () => {
    const fx = await makeWorkItemFixture();
    const card = await mkBody(fx, 'Shipped', 'task', ref('PROD-77', 'cl_gone'));
    await markDone(card.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([]);
  });
});

// Bug MOTIR-9825 — link syntax quoted in code renders as literal text, so it is
// not a link and the advisory never judges it.
describe('workItemsService.validateWorkItem — the MISLABELLED-LINK advisory ignores code', () => {
  const mislabelled = (r: WorkItemValidityDto) => r.advisories.filter(isMislabelledLinkAdvisory);
  const DEAD = 'cmtehjd4s00kjhwphdoxk2mwz';

  it('AC1: a dead link quoted in an inline code span raises nothing, whatever the backtick run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await mkBody(
      fx,
      'Card quoting a bad link',
      'task',
      `The defect was \`${ref('PROD-4202', DEAD)}\`, and \`\` \` ${ref('PROD-1', 'cl_nowhere')} \`\`.`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([]);
  });

  it('AC2: a dead link inside a fenced or an indented code block raises nothing', async () => {
    const fx = await makeWorkItemFixture();
    const body = [
      'Fenced:',
      '',
      '```md',
      ref('PROD-4202', DEAD),
      '```',
      '',
      'Indented:',
      '',
      `    ${ref('PROD-1', 'cl_nowhere')}`,
    ].join('\n');
    const card = await mkBody(fx, 'Card quoting bad links in blocks', 'task', body);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([]);
  });

  it('AC4: a quoted token and a real link to the same id raise exactly ONE advisory, for the real link', async () => {
    const fx = await makeWorkItemFixture();
    const meant = await mk(fx, 'The card the label names', 'task');
    const opened = await mk(fx, 'The card the id opens', 'task');
    const bad = ref(meant.identifier, opened.id);
    const card = await mkBody(
      fx,
      'Card quoting and using a link',
      'task',
      `It was written \`${bad}\`. Still wrong here: ${bad}.`,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(mislabelled(result)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-mislabelled-link',
        label: meant.identifier,
        targetId: opened.id,
        targetKey: opened.identifier,
      },
    ]);
  });
});

describe('validate_work_item (MCP) — the MISLABELLED-LINK advisory reaches the author', () => {
  const text = (r: CallToolResult) =>
    (r.content as { text: string }[]).map((c) => c.text).join('\n');

  it('renders the crossed link with the real key, and the dead link as opening nothing — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const meant = await mk(fx, 'Meant', 'task');
    const opened = await mk(fx, 'Opened', 'task');
    const card = await mkBody(
      fx,
      'Card',
      'task',
      `${ref(meant.identifier, opened.id)} and ${ref('PROD-404', 'cl_dead')}`,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain(
      `${card.identifier} links "${meant.identifier}" to motir:${opened.id}, which is ${opened.identifier}.`,
    );
    expect(text(res)).toContain(
      `${card.identifier} links "PROD-404" to motir:cl_dead, which opens NO work item.`,
    );
    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDERING ADVISORY (MOTIR-2175) — gate 14's third axis, on the surface the
// SEALING AUTHOR reads. `buildDispatchProseAdvisories`' half is pinned in
// `tests/dispatch/dispatchAdvisories.test.ts`; this suite pins the subtree walk
// and the `validate_work_item` rendering.
// ─────────────────────────────────────────────────────────────────────────────

/** MOTIR-2162's shape: criterion 5 turns on the card's OWN merge, naming nobody. */
const POST_MERGE_BODY = [
  '## Acceptance criteria',
  '- the ADR gains an offboarding section',
  '- it names the order and the idempotency requirement',
  '- the core→ai trigger is pinned as a named seam',
  '- every deferral it writes is a card filed in the same action',
  "- `src/services/codeRepoService.ts`'s header block … is updated to point at the decision " +
    '**once it lands**, so the pointer does not outlive the gap.',
].join('\n');

describe('workItemsService.validateWorkItem — the ORDERING advisory', () => {
  const typed = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    title: string,
    descriptionMd: string,
    fields: { type?: WorkItemTypeDto; executor?: ExecutorDto } = {},
    parentId?: string,
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title, descriptionMd, parentId, ...fields },
      fx.ctx,
    );

  it('MOTIR-2162 REGRESSION: names criterion 5, its phrase, and nothing else', async () => {
    const fx = await makeWorkItemFixture();
    const card = await typed(fx, 'Offboarding decision', POST_MERGE_BODY);

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-ordering-violation',
        phrase: 'once it lands',
        criterionIndex: 5,
      },
    ]);
  });

  it('⚠️ `valid` and `blockers` are BYTE-IDENTICAL whether or not it is emitted', async () => {
    // The never-a-blocker invariant, asserted as an equality between two runs
    // that differ ONLY by the offending words.
    const fx = await makeWorkItemFixture();
    const flagged = await typed(fx, 'Flagged', POST_MERGE_BODY);
    const clean = await typed(fx, 'Clean', POST_MERGE_BODY.replace(' **once it lands**,', ','));

    const a = await workItemsService.validateWorkItem(fx.projectId, flagged.identifier, fx.ctx);
    const b = await workItemsService.validateWorkItem(fx.projectId, clean.identifier, fx.ctx);
    expect(a.advisories).toHaveLength(1);
    expect(b.advisories).toEqual([]);
    expect({ valid: a.valid, blockers: a.blockers }).toEqual({
      valid: b.valid,
      blockers: b.blockers,
    });
    expect(a.valid).toBe(true);
    expect(a.blockers).toEqual([]);

    // …and the same for the issue-detail readiness both surfaces gate on.
    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(flagged.identifier)).toEqual(await readinessOf(clean.identifier));
  });

  it("EXEMPTS the release trio's CUT leg — `type: deploy` / `executor: human`", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Release @motir/cli 0.1.1', 'story');
    // The trio, authored in the shape gate 14 prescribes: prep (code) is clean,
    // cut (deploy/human) legitimately needs the merge and must NOT be reported.
    await typed(
      fx,
      'prep — version bump + release workflow',
      '## Acceptance criteria\n- `package.json` version is 0.1.1',
      { type: 'code', executor: 'coding_agent' },
      story.id,
    );
    await typed(
      fx,
      'cut — push the tag, watch the lanes',
      '## Acceptance criteria\n- `cli-v0.1.1` is pushed once this lands on `main`\n' +
        '- the published image is pullable by digest',
      { type: 'deploy', executor: 'human' },
      story.id,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    // The ORDERING check stays quiet on the cut leg (its remedy read back). The
    // leg's PLACEMENT is the POST-MERGE-CHILD check's question (MOTIR-8863): a
    // card that needs the merge cannot be a child of the story that ships it, so
    // that one advisory — and only that one — names it.
    expect(result.advisories.filter((a) => a.severity === 'likely-ordering-violation')).toEqual([]);
    expect(result.advisories.map((a) => a.severity)).toEqual([
      'likely-post-merge-child-under-container',
    ]);
  });

  it('a DONE member is not scanned for it either — its prose is history', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const shipped = await typed(fx, 'Already shipped', POST_MERGE_BODY, {}, story.id);
    await markDone(shipped.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.advisories).toEqual([]);
  });

  it('orders SHAPE before REFERENCE within one card, then by reference', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Unwired dependency', 'task');
    const card = await typed(
      fx,
      'Both defects',
      [
        '## Acceptance criteria',
        `- consumes ${ref('OTHER', other.id)}`,
        '- the row is visible on `main`',
      ].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-ordering-violation',
        phrase: 'on main',
        criterionIndex: 2,
      },
      {
        item: card.identifier,
        referenced: other.identifier,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
    ]);
  });
});

describe('validate_work_item (MCP) — the ORDERING advisory reaches the author', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('renders the criterion index, the phrase, and the CUT remedy — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Offboarding decision',
        descriptionMd: POST_MERGE_BODY,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    expect(struct(res).advisories).toHaveLength(1);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain('criterion 5 says \\"once it lands\\"');
    expect(text(res)).toContain('Cut the card at that criterion');
    await client.close();
  });

  it('renders BOTH families as separate blocks when a card carries both', async () => {
    const fx = await makeWorkItemFixture();
    const other = await mk(fx, 'Unwired dependency', 'task');
    const card = await mkBody(
      fx,
      'Both defects',
      'task',
      [
        '## Acceptance criteria',
        `- consumes ${ref('OTHER', other.id)}`,
        '- the row is visible on `main`',
      ].join('\n'),
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).advisories).toHaveLength(2);
    // The reference block's sentence …
    expect(text(res)).toContain('have no blocked_by edge from it');
    // … and the shape block's, which is about the card itself.
    expect(text(res)).toContain("which exists only AFTER the card's own PR has merged");
    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REPO-STRADDLE ADVISORY (MOTIR-2177) — gate 1's repo column, on the same
// surface the SEALING AUTHOR reads. The dispatch half is pinned in
// `tests/dispatch/dispatchAdvisories.test.ts`; this suite pins the subtree walk
// and the `validate_work_item` rendering.
// ─────────────────────────────────────────────────────────────────────────────

/** MOTIR-2162's other defect: criteria discharged in a SECOND repo. */
const STRADDLE_BODY = [
  '## Acceptance criteria',
  '- `motir-core/docs/decisions/code-graph-index-fleet.md` gains an offboarding section',
  '- `motir-ai/src/services/codeRepoService.ts` removes the durable snapshot',
  '- `motir-ai/tests/codeRepoService.test.ts` covers the removal branch',
].join('\n');

/** Connect a repo to the fixture's workspace — the candidate set the check reads. */
async function connectRepo(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  name: string,
): Promise<void> {
  const installationId = `inst-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
}

describe('workItemsService.validateWorkItem — the REPO-STRADDLE advisory', () => {
  const pinned = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    title: string,
    descriptionMd: string,
    targetRepo: string | null,
    parentId?: string,
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title, descriptionMd, targetRepo, parentId },
      fx.ctx,
    );

  it('MOTIR-2162 REGRESSION: pinned motir-core, criteria in motir-ai — names the FIRST', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await pinned(fx, 'Code-graph offboarding', STRADDLE_BODY, 'motir-core');

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-repo-straddle',
        path: 'motir-ai/src/services/codeRepoService.ts',
        repo: 'motir-ai',
        reason: 'contradiction',
        criterionIndex: 2,
      },
    ]);
  });

  it('⚠️ `valid` and `blockers` are BYTE-IDENTICAL whether or not it is emitted', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const flagged = await pinned(fx, 'Flagged', STRADDLE_BODY, 'motir-core');
    const clean = await pinned(
      fx,
      'Clean',
      STRADDLE_BODY.replaceAll('motir-ai/', 'motir-core/'),
      'motir-core',
    );

    const a = await workItemsService.validateWorkItem(fx.projectId, flagged.identifier, fx.ctx);
    const b = await workItemsService.validateWorkItem(fx.projectId, clean.identifier, fx.ctx);
    expect(a.advisories).toHaveLength(1);
    expect(b.advisories).toEqual([]);
    expect({ valid: a.valid, blockers: a.blockers }).toEqual({
      valid: b.valid,
      blockers: b.blockers,
    });
    expect(a.valid).toBe(true);
    expect(a.blockers).toEqual([]);

    // …and the same for the issue-detail readiness both surfaces gate on.
    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(flagged.identifier)).toEqual(await readinessOf(clean.identifier));
  });

  it('scans a whole SUBTREE — the story reports its straddling child', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const story = await mk(fx, 'Code-graph offboarding', 'story');
    const child = await pinned(fx, 'The removal seam', STRADDLE_BODY, 'motir-core', story.id);
    await pinned(
      fx,
      'The clean sibling',
      '## Acceptance criteria\n- `motir-core/lib/x.ts` changes',
      'motir-core',
      story.id,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories.map((a) => a.item)).toEqual([child.identifier]);
  });

  it('a DONE member is not scanned for it either — its prose is history', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const story = await mk(fx, 'Story', 'story');
    const shipped = await pinned(fx, 'Already shipped', STRADDLE_BODY, 'motir-core', story.id);
    await markDone(shipped.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.advisories).toEqual([]);
  });
});

describe('validate_work_item (MCP) — the REPO-STRADDLE advisory reaches the author', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('renders the criterion, the PATH, its repo and the SPLIT remedy — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Code-graph offboarding',
        descriptionMd: STRADDLE_BODY,
        targetRepo: 'motir-core',
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    expect(struct(res).advisories).toHaveLength(1);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain(
      'criterion 2 names motir-ai/src/services/codeRepoService.ts (motir-ai)',
    );
    expect(text(res)).toContain('while the card pins a different targetRepo');
    expect(text(res)).toContain('Split the card per repo');
    // The two knowingly-uncovered forms are stated to the reader, so nobody
    // concludes gate 1's prose has been retired (MOTIR-2177's own AC).
    expect(text(res)).toContain('BOUNDARY-CONTRACT');
    expect(text(res)).toContain('bare-SYMBOL');
    await client.close();
  });

  it('says UNPINNABLE rather than "a different targetRepo" when the card pins nothing', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Unpinnable',
        descriptionMd: STRADDLE_BODY,
        targetRepo: null,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(text(res)).toContain('check whether it is UNPINNABLE rather than unpinned');
    expect(text(res)).not.toContain('while the card pins a different targetRepo');
    await client.close();
  });

  it('renders BOTH shape members as separate blocks when a card carries both', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Both shape defects',
        descriptionMd: [
          '## Acceptance criteria',
          '- `motir-ai/src/x.ts` is updated',
          '- the row is visible on `main`',
        ].join('\n'),
        targetRepo: 'motir-core',
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).advisories).toHaveLength(2);
    // The ORDERING block's sentence …
    expect(text(res)).toContain("which exists only AFTER the card's own PR has merged");
    // … and the STRADDLE block's, which asks a different question and has a
    // different remedy — neither is folded into the other.
    expect(text(res)).toContain("discharged in a repo that is not the card's own");
    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ESTIMATION-GATE ADVISORY (MOTIR-3110) — the third SHAPE member, on the
// surface the SEALING AUTHOR reads. This is the surface whose `valid: true` +
// empty `advisories` array is the observation the check exists to invert:
// MOTIR-3068 was answered exactly that way at 13 SP / 600 min, the fourth card
// to discharge this gate in prose instead of in the plan (`notes.html` #323).
// The dispatch half is pinned in `tests/dispatch/dispatchAdvisories.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

describe('workItemsService.validateWorkItem — THE ESTIMATION GATE advisory', () => {
  /** A card with a clean body, so ONLY its two sizing columns can be at fault. */
  const sized = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    title: string,
    sizing: { storyPoints?: number | null; estimateMinutes?: number | null },
    fields: { type?: WorkItemTypeDto; executor?: ExecutorDto } = {
      type: 'code',
      executor: 'coding_agent',
    },
    placement: { kind?: IssueType; parentId?: string } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: placement.kind ?? 'task',
        title,
        descriptionMd: '## Acceptance criteria\n\n- the thing is built and covered.',
        parentId: placement.parentId,
        ...sizing,
        ...fields,
      },
      fx.ctx,
    );

  it('MOTIR-3068 REGRESSION: `valid: true` no longer means `advisories: []`', async () => {
    const fx = await makeWorkItemFixture();
    const card = await sized(fx, 'The faint-ink sweep', {
      storyPoints: 13,
      estimateMinutes: 600,
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-over-gate-sizing',
        threshold: 'both',
        storyPoints: 13,
        estimateMinutes: 600,
      },
    ]);
  });

  it('fires on each ceiling independently, and says nothing about a right-sized card', async () => {
    const fx = await makeWorkItemFixture();
    const points = await sized(fx, 'Points only', { storyPoints: 13, estimateMinutes: 45 });
    const minutes = await sized(fx, 'Minutes only', { storyPoints: 3, estimateMinutes: 90 });
    const fine = await sized(fx, 'Right-sized', { storyPoints: 3, estimateMinutes: 45 });

    const advisoriesOf = async (identifier: string) =>
      (await workItemsService.validateWorkItem(fx.projectId, identifier, fx.ctx)).advisories;
    expect(await advisoriesOf(points.identifier)).toMatchObject([{ threshold: 'story_points' }]);
    expect(await advisoriesOf(minutes.identifier)).toMatchObject([
      { threshold: 'estimate_minutes' },
    ]);
    expect(await advisoriesOf(fine.identifier)).toEqual([]);
  });

  it('EXEMPTS a human / manual executor, and a card that HOLDS children', async () => {
    const fx = await makeWorkItemFixture();
    const human = await sized(
      fx,
      'Flip the package to public',
      { storyPoints: 13, estimateMinutes: 600 },
      { type: 'manual', executor: 'human' },
    );
    const container = await sized(fx, 'Container', { storyPoints: 13, estimateMinutes: 600 });
    await sized(
      fx,
      'Right-sized child',
      { storyPoints: 3, estimateMinutes: 45 },
      { type: 'code', executor: 'coding_agent' },
      { kind: 'subtask', parentId: container.id },
    );

    const advisoriesOf = async (identifier: string) =>
      (await workItemsService.validateWorkItem(fx.projectId, identifier, fx.ctx)).advisories;
    expect(await advisoriesOf(human.identifier)).toEqual([]);
    // Validating the CONTAINER scans its whole subtree — so an empty array here
    // says both that the container is exempt and that its child is right-sized.
    expect(await advisoriesOf(container.identifier)).toEqual([]);
  });

  it('⚠️ `valid` and `blockers` are BYTE-IDENTICAL whether or not it is emitted', async () => {
    const fx = await makeWorkItemFixture();
    const oversized = await sized(fx, 'Oversized', { storyPoints: 13, estimateMinutes: 600 });
    const clean = await sized(fx, 'Clean', { storyPoints: 3, estimateMinutes: 45 });

    const a = await workItemsService.validateWorkItem(fx.projectId, oversized.identifier, fx.ctx);
    const b = await workItemsService.validateWorkItem(fx.projectId, clean.identifier, fx.ctx);
    expect(a.advisories).toHaveLength(1);
    expect(b.advisories).toEqual([]);
    expect({ valid: a.valid, blockers: a.blockers }).toEqual({
      valid: b.valid,
      blockers: b.blockers,
    });

    // …and the same for the issue-detail readiness both surfaces gate on: a
    // legitimately large card mid-re-plan stays claimable.
    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(oversized.identifier)).toEqual(await readinessOf(clean.identifier));
    expect((await readinessOf(oversized.identifier)).ready).toBe(true);
  });

  it('scans a whole SUBTREE — the story reports its oversized child', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The story' },
      fx.ctx,
    );
    const child = await sized(
      fx,
      'Oversized child',
      { storyPoints: 13, estimateMinutes: 600 },
      { type: 'code', executor: 'coding_agent' },
      { kind: 'subtask', parentId: story.id },
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories).toMatchObject([
      { item: child.identifier, severity: 'likely-over-gate-sizing' },
    ]);
  });
});

describe('validate_work_item (MCP) — THE ESTIMATION GATE advisory reaches the author', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('renders the two observed numbers, which ceiling, and the SPLIT remedy — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'The faint-ink sweep',
        descriptionMd: '## Acceptance criteria\n\n- the population is empty.',
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 13,
        estimateMinutes: 600,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    expect(struct(res).advisories).toMatchObject([
      { kind: 'shape', severity: 'likely-over-gate-sizing', threshold: 'both' },
    ]);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain('sized OVER the estimation gate');
    expect(text(res)).toContain('13 points / 600 minutes (over: both ceilings)');
    expect(text(res)).toContain('SPLIT the card before it is dispatched');
    // The remedy names the thing the four prior instances actually did, so the
    // reader cannot mistake writing it down for having done it.
    expect(text(res)).toContain('expect this to');
    await client.close();
  });

  it('renders ALL THREE shape members as separate blocks when one card carries them all', async () => {
    // The families are distinguished by their REMEDIES — cut here, split per
    // repo, split by size — so each keeps its own block rather than being folded
    // into a shared sentence.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'All three shape defects',
        descriptionMd: [
          '## Acceptance criteria',
          '- `motir-ai/src/x.ts` is updated',
          '- the row is visible on `main`',
        ].join('\n'),
        targetRepo: 'motir-core',
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 21,
        estimateMinutes: 480,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: card.identifier },
    })) as CallToolResult;

    expect(struct(res).advisories).toHaveLength(3);
    expect(text(res)).toContain("which exists only AFTER the card's own PR has merged");
    expect(text(res)).toContain("discharged in a repo that is not the card's own");
    expect(text(res)).toContain('sized OVER the estimation gate');
    // Still VALID: three advisories, no blockers, at every severity.
    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    await client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SELF-BLOCKING-DESIGN ADVISORY (MOTIR-3178) — the fourth SHAPE member, on
// the surface the SEALING AUTHOR reads.
//
// This is the surface whose `valid: true` is the observation the check exists to
// invert. MOTIR-3154 carried a `design/ai-planning/` three-file amendment as
// criterion 1 and the UI built against that drawing as criteria 4-5; readiness
// was `true`, `openBlockers` `[]`, and `validate_work_item` returned `valid:
// true` with one unrelated `reference` advisory (`notes.html` #329; planning bug
// MOTIR-3158). Read literally the planning-time design gate was SATISFIED —
// the `type: design` subtask a UI card must be linked to WAS the card.
//
// The wire half is pinned in `tests/api/v1/dispatch-prompt-route.test.ts` and
// the dispatch half in `tests/dispatch/dispatchAdvisories.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MOTIR-3154's criteria set, RECONSTRUCTED — it is not available verbatim and
 * cannot be quoted. `get_work_item_activity` records a `descriptionMd` edit at
 * 2026-08-19T20:53:52.716Z (that card's re-plan `modify`, fifteen minutes after
 * MOTIR-3158 was filed), and the tenant keeps no prior body: activity parts carry
 * `from`/`to` for `status`, `priority` and links only. `notes.html` #329 and the
 * `motir run MOTIR-3154` comment both PARAPHRASE criteria 1 / 4 / 5.
 *
 * So this is rebuilt from the table in MOTIR-3178's own body — its durable source
 * — and is SYNTHETIC on purpose: it consumes nothing MOTIR-3154 produces, so it
 * cannot rot when that card is re-scoped again.
 */
const RECONSTRUCTED_SELF_BLOCKING_BODY = [
  '## Acceptance criteria',
  '',
  '1. a `design/ai-planning/` three-file amendment — the accepted and declined node',
  '   treatments, plus an explicit re-decision of what the plan-detail canvas pane',
  '   holds after approve',
  '2. decline no longer deletes the proposal rows',
  '3. approve leaves the pane on the plan rather than handing it to the establish step',
  '4. the plan-detail canvas draws a DECIDED plan — one node per approved `add`, in',
  '   the treatment the design decides',
  '5. the planning-workspace canvas KEEPS its decided overlay',
].join('\n');

describe('workItemsService.validateWorkItem — the SELF-BLOCKING-DESIGN advisory', () => {
  const card = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    title: string,
    descriptionMd: string,
    placement: { kind?: IssueType; parentId?: string } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: placement.kind ?? 'task',
        title,
        descriptionMd,
        parentId: placement.parentId,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 3,
        estimateMinutes: 45,
      },
      fx.ctx,
    );

  it('MOTIR-3154 REGRESSION: `valid: true` no longer means the composition is invisible', async () => {
    const fx = await makeWorkItemFixture();
    const item = await card(fx, 'A decided plan on the canvas', RECONSTRUCTED_SELF_BLOCKING_BODY);

    const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories).toEqual([
      {
        kind: 'shape',
        item: item.identifier,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 4,
      },
    ]);
  });

  it('MOTIR-4477: an AMENDMENT to an existing design document is a design criterion too', async () => {
    // The false NEGATIVE this widening closes. Criterion 1 is MOTIR-4472's own,
    // quoted verbatim and held here as a literal — it names no `design/<area>/`
    // path, no `.mock.html`, no `design-notes.md` and no *mock* / *artboard* /
    // *design asset*, so every one of the eight ASSET matchers missed it and the
    // card sealed with `advisories: []` while being its own design blocker.
    const fx = await makeWorkItemFixture();
    const item = await card(
      fx,
      'A decided plan peek',
      [
        '## Acceptance criteria',
        '',
        '1. A design section exists amending Part XIV with the decided axis for `modify`',
        '   and `remove`, naming the chosen answer and the copy for every string that',
        '   changes — read before the code is written.',
        '2. The peek opened from a DECIDED plan renders the past tense, asserted as a',
        '   component test over the rendered dialog.',
        '3. The same assertion runs through the CANVAS door on the same proposal.',
      ].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(result.advisories).toContainEqual({
      kind: 'shape',
      item: item.identifier,
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 2,
    });
  });

  it('MOTIR-4477: a DOCS card amending a decision record is NOT a design criterion', async () => {
    // The false-positive floor, at the advisory tier. Both strings carry an
    // amendment verb and a section reference and neither commissions a drawing —
    // the first is drawn from MOTIR-3687, a real `type: content` card.
    const fx = await makeWorkItemFixture();
    const item = await card(
      fx,
      'Amend the transfer-basis ADR',
      [
        '## Acceptance criteria',
        '',
        '1. `docs/decisions/ai-upstream-transfer-basis.md` is amended: §6 item 4 records',
        '   that D2 and D3 are SUPERSEDED, with the date the finding was withdrawn.',
        '2. The settings page renders the subprocessor list from the amended record.',
      ].join('\n'),
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(result.advisories.filter((a) => a.severity === 'likely-self-blocking-design')).toEqual(
      [],
    );
  });

  it('says nothing when only ONE of the two roles is present — the quiet direction', async () => {
    const fx = await makeWorkItemFixture();
    const designOnly = await card(
      fx,
      'Draw the plan canvas',
      [
        '## Acceptance criteria',
        '',
        '1. `design/ai-planning/plan-canvas.mock.html` is built from the real design system',
        '2. `design/ai-planning/design-notes.md` names the primitives and the access path',
      ].join('\n'),
    );
    const surfaceOnly = await card(
      fx,
      'Build the plan canvas',
      [
        '## Acceptance criteria',
        '',
        '1. the plan-detail canvas draws one node per approved add',
        '2. the planning-workspace canvas renders the decided overlay',
      ].join('\n'),
    );

    const advisoriesOf = async (identifier: string) =>
      (await workItemsService.validateWorkItem(fx.projectId, identifier, fx.ctx)).advisories;
    expect(await advisoriesOf(designOnly.identifier)).toEqual([]);
    expect(await advisoriesOf(surfaceOnly.identifier)).toEqual([]);
  });

  it('says nothing on a design card describing its own export — the near-miss', async () => {
    // The false-positive class the predicate must not have: a drawing's whole job
    // is to describe a surface, so a `design` card's criteria are full of surface
    // nouns and render verbs. Both roles on the SAME criterion is one card doing
    // one thing, which is exactly the shape the gate wants.
    const fx = await makeWorkItemFixture();
    const item = await card(
      fx,
      'Amend the work-items detail asset',
      [
        '## Acceptance criteria',
        '',
        '1. `design/work-items/design-notes.md` records the relationships panel treatment',
        '2. the `design/work-items/detail.png` export shows the panel with the picker open',
      ].join('\n'),
    );
    const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(result.advisories).toEqual([]);
  });

  it('EXEMPTS a card that HOLDS children — childless is the condition, not the kind', async () => {
    // A container's design child CAN be reviewed before its code children run,
    // which is precisely the shape this finding asks a leaf to be pushed into. So
    // the parent is never reported, whatever its own criteria say.
    const fx = await makeWorkItemFixture();
    const container = await card(
      fx,
      'A decided plan on the canvas',
      RECONSTRUCTED_SELF_BLOCKING_BODY,
    );
    await card(fx, 'A right-shaped child', '## Acceptance criteria\n\n- the thing is built.', {
      kind: 'subtask',
      parentId: container.id,
    });

    // Validating the container scans its whole subtree, so an empty array says
    // BOTH that the parent is exempt and that the child is clean.
    const result = await workItemsService.validateWorkItem(
      fx.projectId,
      container.identifier,
      fx.ctx,
    );
    expect(result.valid).toBe(true);
    expect(result.advisories).toEqual([]);
  });

  it('⚠️ `valid`, `blockers` and READINESS are identical whether or not it is emitted', async () => {
    const fx = await makeWorkItemFixture();
    const selfBlocking = await card(fx, 'Draws and builds', RECONSTRUCTED_SELF_BLOCKING_BODY);
    const clean = await card(fx, 'Clean', '## Acceptance criteria\n\n- the thing is built.');

    const a = await workItemsService.validateWorkItem(
      fx.projectId,
      selfBlocking.identifier,
      fx.ctx,
    );
    const b = await workItemsService.validateWorkItem(fx.projectId, clean.identifier, fx.ctx);
    expect(a.advisories).toHaveLength(1);
    expect(b.advisories).toEqual([]);
    expect({ valid: a.valid, blockers: a.blockers }).toEqual({
      valid: b.valid,
      blockers: b.blockers,
    });

    // …and the readiness both dispatch surfaces gate on: a card mid-re-plan, which
    // is exactly the card this finding describes, stays claimable.
    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(selfBlocking.identifier)).toEqual(await readinessOf(clean.identifier));
    expect((await readinessOf(selfBlocking.identifier)).ready).toBe(true);
  });

  it('says NOTHING about a SUBTREE child whose design is already LIFTED to a sibling', async () => {
    // HOLE 1 (MOTIR-3625) on the SUBTREE path — the path a planner actually
    // calls, and the one the three false entries came back on. The child is
    // shaped exactly as this advisory asks: its design lives in a `type: design`
    // sibling under the same story, and it carries the `blocked_by` edge to it.
    // Reporting it would tell a correctly-wired card to do what it has done.
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The planning canvas' },
      fx.ctx,
    );
    const design = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: story.id,
        title: 'Design — the plan canvas',
        type: 'design',
        executor: 'coding_agent',
      },
      fx.ctx,
    );
    const child = await card(
      fx,
      'Builds what the drawing decides',
      RECONSTRUCTED_SELF_BLOCKING_BODY,
      {
        kind: 'subtask',
        parentId: story.id,
      },
    );
    await workItemsService.linkWorkItems(
      { fromId: child.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories.filter((a) => a.severity === 'likely-self-blocking-design')).toEqual(
      [],
    );
  });

  it('MOTIR-6201: says NOTHING about a `type: design` card — a design card IS the design', async () => {
    // MOTIR-6044's own acceptance criteria, verbatim. Criterion 1 names the delta
    // mock (a design ASSET), and criterion 3 describes what the DRAWING shows —
    // `row` / `surface` + `drawn` — which the surface arm reads as building a
    // rendered surface. On a card whose whole deliverable is the design result,
    // the LIFT remedy has no meaning, so the card's TYPE settles it before any
    // criterion is scanned. The same body on a `code` card still emits: that is
    // the arm the check was built for.
    const body = [
      '## Acceptance criteria',
      '',
      "- This card's run publishes (`publish_design_result`) a design result carrying the delta mock and its notes section.",
      '- Every state above appears in the mock, in both themes. That includes the undecided MCP-authored row, the no-conversation row and the secondary link.',
      '- The undecided MCP-authored row is drawn as opening the **planning surface**, and the notes record that `noConversation.agent` is retired, citing `agent-authored-plans.md` AMENDMENT 20.',
      '- The notes state which parts of both base rows are inherited and not redrawn, citing them by path.',
      '- The copy is listed with its keys, and the access path is drawn for both destinations.',
    ].join('\n');
    const fx = await makeWorkItemFixture();
    const make = (type: 'design' | 'code') =>
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: `The row says where it goes (${type})`,
          descriptionMd: body,
          type,
          executor: 'coding_agent',
          storyPoints: 3,
          estimateMinutes: 45,
        },
        fx.ctx,
      );
    const design = await make('design');
    const code = await make('code');

    const selfBlockingOf = async (identifier: string) =>
      (await workItemsService.validateWorkItem(fx.projectId, identifier, fx.ctx)).advisories.filter(
        (a) => a.severity === 'likely-self-blocking-design',
      );
    expect(await selfBlockingOf(design.identifier)).toEqual([]);
    expect(await selfBlockingOf(code.identifier)).toEqual([
      {
        kind: 'shape',
        item: code.identifier,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 3,
      },
    ]);
  });

  it('scans a whole SUBTREE — the story reports its self-blocking child', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The planning canvas' },
      fx.ctx,
    );
    const child = await card(fx, 'Draws and builds', RECONSTRUCTED_SELF_BLOCKING_BODY, {
      kind: 'subtask',
      parentId: story.id,
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.advisories).toMatchObject([
      { item: child.identifier, severity: 'likely-self-blocking-design' },
    ]);
  });

  // THE TYPE SCOPE TEST (MOTIR-6245). A `type: design` card IS the card the LIFT
  // remedy would create, so the finding cannot be true of it — yet its own
  // criteria name panels by number (MOTIR-6236) or oblige it to render the
  // shipped surface first (MOTIR-6241), and the prose predicate reads both as
  // BUILDING a surface. 7 of the 16 open design cards carried the false entry.
  const typedCard = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    descriptionMd: string,
    type: WorkItemTypeDto,
    placement: { kind?: IssueType; parentId?: string } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: placement.kind ?? 'task',
        title: `A ${type} card`,
        descriptionMd,
        parentId: placement.parentId,
        type,
        executor: 'coding_agent',
        storyPoints: 3,
        estimateMinutes: 45,
      },
      fx.ctx,
    );

  it('MOTIR-6236 REGRESSION: says NOTHING about a childless `type: design` card, whatever its criteria say', async () => {
    const fx = await makeWorkItemFixture();
    for (const body of [MOTIR_6236_DESIGN_CARD_CRITERIA, MOTIR_6241_DESIGN_CARD_CRITERIA]) {
      const item = await typedCard(fx, body, 'design');
      const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
      expect(result.advisories.filter((a) => a.severity === 'likely-self-blocking-design')).toEqual(
        [],
      );
    }
  });

  it('…and on the SUBTREE path — a story no longer reports its design child', async () => {
    // The path MOTIR-6236 was reported through: `validate_work_item` on its story.
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The multi-line composer' },
      fx.ctx,
    );
    await typedCard(fx, MOTIR_6236_DESIGN_CARD_CRITERIA, 'design', {
      kind: 'subtask',
      parentId: story.id,
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.advisories.filter((a) => a.severity === 'likely-self-blocking-design')).toEqual(
      [],
    );
  });

  it('the SAME body on a non-design card still fires — the scope test reads the TYPE, not the prose', async () => {
    // The control: nothing about the body changed, only the card's type, so the
    // silence above is the scope test and not a narrowed predicate.
    const fx = await makeWorkItemFixture();
    const item = await typedCard(fx, MOTIR_6236_DESIGN_CARD_CRITERIA, 'code');

    const result = await workItemsService.validateWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(result.advisories).toContainEqual({
      kind: 'shape',
      item: item.identifier,
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 2,
    });
  });
});

describe('validate_work_item (MCP) — the SELF-BLOCKING-DESIGN advisory reaches the author', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('names BOTH criteria and the LIFT remedy — and the card is still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'A decided plan vanishes from the canvas',
        descriptionMd: RECONSTRUCTED_SELF_BLOCKING_BODY,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 5,
        estimateMinutes: 55,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: item.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    expect(struct(res).advisories).toMatchObject([
      {
        kind: 'shape',
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 4,
      },
    ]);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain('their OWN design blocker');
    expect(text(res)).toContain('criterion 1 produces a design asset');
    expect(text(res)).toContain('criterion 4 builds a rendered surface');
    // The remedy is a LIFT, not a cut — the distinction the other criterion
    // members' single index would have hidden.
    expect(text(res)).toContain('The remedy is a LIFT, not a cut');
    await client.close();
  });

  it('renders ALL FOUR shape members as separate blocks when one card carries them all', async () => {
    // Each member keeps its own block because each has a DIFFERENT remedy — cut
    // here, split per repo, split by size, lift the design out — and folding them
    // into a shared sentence would lose exactly that.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'All four shape defects',
        descriptionMd: [
          '## Acceptance criteria',
          '- `design/ai-planning/design-notes.md` records the node treatments',
          '- the plan-detail canvas draws the decided plan',
          '- `motir-ai/src/x.ts` is updated',
          '- the row is visible on `main`',
        ].join('\n'),
        targetRepo: 'motir-core',
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 21,
        estimateMinutes: 480,
      },
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: item.identifier },
    })) as CallToolResult;

    expect(struct(res).advisories).toHaveLength(4);
    expect(text(res)).toContain("which exists only AFTER the card's own PR has merged");
    expect(text(res)).toContain("discharged in a repo that is not the card's own");
    expect(text(res)).toContain('sized OVER the estimation gate');
    expect(text(res)).toContain('their OWN design blocker');
    // Still VALID: four advisories, no blockers, at every severity.
    expect(struct(res).valid).toBe(true);
    expect(struct(res).blockers).toEqual([]);
    await client.close();
  });
});

describe('workItemsService.validateWorkItem — the CONTAINER-COVERAGE advisory (MOTIR-5362)', () => {
  /** Criterion 1 names a seam no child's title carries; criterion 2 the refusal copy one child's does. */
  const COVERAGE_BODY = [
    '## Acceptance criteria',
    '',
    '- `GitProvider` declares `mergeChangeRequest` and the provider returns a typed result.',
    '- Every refusal renders in the merge control.',
  ].join('\n');

  const container = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    descriptionMd: string = COVERAGE_BODY,
    placement: { kind?: IssueType; parentId?: string } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: placement.kind ?? 'story',
        title: 'Motir merges the pull request',
        descriptionMd,
        parentId: placement.parentId,
      },
      fx.ctx,
    );

  /** Backdate a child a minute before its container, so it reads as ADOPTED. */
  const adopt = (childId: string, containerCreatedAt: string | Date) =>
    adminDb.workItem.update({
      where: { id: childId },
      data: { createdAt: new Date(new Date(containerCreatedAt).getTime() - 60_000) },
    });

  const coverageOf = (result: WorkItemValidityDto) => result.advisories.filter(isCoverageAdvisory);

  it('MOTIR-4882 SHAPE: a criterion no adopted child owns is reported — and the container stays VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await container(fx);
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      story.id,
    );
    await adopt(gate.id, story.createdAt);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(coverageOf(result)).toEqual([
      {
        kind: 'coverage',
        item: story.identifier,
        severity: 'likely-unowned-criterion',
        criterionIndex: 1,
        adoptedChildren: [gate.identifier],
      },
    ]);
  });

  it('says nothing when every child was written UNDER the container — adoption is the gate', async () => {
    const fx = await makeWorkItemFixture();
    const story = await container(fx);
    await mk(fx, 'The merge gate — every refusal renders in the control', 'subtask', story.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(coverageOf(result)).toEqual([]);
  });

  it('a DONE child still OWNS a criterion — finished work is delivery too', async () => {
    const fx = await makeWorkItemFixture();
    const story = await container(fx);
    const seam = await mk(fx, 'The `GitProvider.mergeChangeRequest` seam', 'subtask', story.id);
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      story.id,
    );
    await adopt(seam.id, story.createdAt);
    await adopt(gate.id, story.createdAt);
    await markDone(seam.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(coverageOf(result)).toEqual([]);
  });

  it('a container with no acceptance-criteria heading never fires, adopted child or not', async () => {
    const fx = await makeWorkItemFixture();
    const story = await container(
      fx,
      '## Verification\n\n- walk the GitProvider mergeChangeRequest recipe',
    );
    const gate = await mk(fx, 'Unrelated billing work', 'subtask', story.id);
    await adopt(gate.id, story.createdAt);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(coverageOf(result)).toEqual([]);
  });

  it('⚠️ `valid` and `blockers` are BYTE-IDENTICAL whether or not it is emitted', async () => {
    const fx = await makeWorkItemFixture();
    const story = await container(fx);
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      story.id,
    );
    await adopt(gate.id, story.createdAt);
    const external = await mk(fx, 'Work outside the subtree', 'task');
    await link(fx, gate.id, external.id);

    const withFinding = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(withFinding)).toHaveLength(1);

    // Give the criterion an owner: the finding goes, and nothing else moves.
    await adminDb.workItem.update({
      where: { id: gate.id },
      data: { title: 'The `GitProvider.mergeChangeRequest` seam and every refusal in the control' },
    });
    const without = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(coverageOf(without)).toEqual([]);
    expect(without.valid).toBe(false);
    expect(without.valid).toBe(withFinding.valid);
    expect(without.blockers).toEqual(withFinding.blockers);
  });

  it('scans a whole SUBTREE — validating the EPIC reports its story’s unowned criterion', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Approval gates', 'epic');
    const story = await container(fx, COVERAGE_BODY, { parentId: epic.id });
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      story.id,
    );
    await adopt(gate.id, story.createdAt);

    const result = await workItemsService.validateWorkItem(fx.projectId, epic.identifier, fx.ctx);
    expect(coverageOf(result)).toEqual([
      expect.objectContaining({ item: story.identifier, criterionIndex: 1 }),
    ]);
  });
});

describe('validate_work_item (MCP) — the CONTAINER-COVERAGE advisory reaches the author', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('names the criterion, the adopted children and the WIDEN-OR-FILE remedy — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'story',
        title: 'Motir merges the pull request',
        descriptionMd: [
          '## Acceptance criteria',
          '',
          '- `GitProvider` declares `mergeChangeRequest` and the provider returns a typed result.',
        ].join('\n'),
      },
      fx.ctx,
    );
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      story.id,
    );
    await adminDb.workItem.update({
      where: { id: gate.id },
      data: { createdAt: new Date(new Date(story.createdAt).getTime() - 60_000) },
    });

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).advisories.filter((a) => a.kind === 'coverage')).toMatchObject([
      { kind: 'coverage', severity: 'likely-unowned-criterion', criterionIndex: 1 },
    ]);
    expect(text(res)).toContain('is VALID');
    expect(text(res)).toContain('NOT a blocker');
    expect(text(res)).toContain('NO child');
    expect(text(res)).toContain(`${story.identifier} criterion 1 has no owning child`);
    expect(text(res)).toContain(`adopted: ${gate.identifier}`);
    expect(text(res)).toContain(
      'Widen the adopted work item on the record, or file the sibling that covers the difference',
    );
    await client.close();
  });
});

describe('validate_work_item (MCP) with `planId` — the COVERAGE advisory reaches the PLAN author (MOTIR-5403)', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('names the criterion a re-parented OLDER card does not own, over the projection — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'story',
        title: 'Motir merges the pull request',
        descriptionMd: [
          '## Acceptance criteria',
          '',
          '- `GitProvider` declares `mergeChangeRequest` and the provider returns a typed result.',
        ].join('\n'),
      },
      fx.ctx,
    );
    const home = await mk(fx, 'Where the gate was first filed', 'story');
    const gate = await mk(
      fx,
      'The merge gate — every refusal renders in the control',
      'subtask',
      home.id,
    );
    await adminDb.workItem.update({
      where: { id: gate.id },
      data: { createdAt: new Date(new Date(story.createdAt).getTime() - 60_000) },
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: gate.id, patch: { parentRef: story.id } }],
      fx.ctx,
    );

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier, planId: plan.id },
    })) as CallToolResult;

    expect(struct(res).valid).toBe(true);
    expect(struct(res).advisories.filter((a) => a.kind === 'coverage')).toMatchObject([
      {
        kind: 'coverage',
        item: story.identifier,
        criterionIndex: 1,
        adoptedChildren: [gate.identifier],
      },
    ]);
    expect(text(res)).toContain(`once plan ${plan.id} materializes`);
    expect(text(res)).toContain(`${story.identifier} criterion 1 has no owning child`);
    expect(text(res)).toContain(`adopted: ${gate.identifier}`);
    await client.close();
  });
});

describe('workItemsService.validateWorkItem — the POST-MERGE-CHILD advisory (MOTIR-8863)', () => {
  const make = (
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    kind: IssueType,
    title: string,
    over: {
      parentId?: string;
      type?: WorkItemTypeDto;
      executor?: ExecutorDto;
      descriptionMd?: string;
    } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind,
        title,
        parentId: over.parentId,
        descriptionMd: over.descriptionMd,
        type: over.type,
        executor: over.executor,
      },
      fx.ctx,
    );

  const VERIFY_BODY = [
    '## Context',
    '',
    'Earliest legal start: after the deploy that ships the controller has finished.',
  ].join('\n');

  it('reports a production-verify child laid inside the story whose merge it waits on', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, 'story', 'The graph service scales itself');
    const child = await make(fx, 'task', 'Run the seven verification steps on production', {
      parentId: story.id,
      type: 'verification',
      executor: 'human',
      descriptionMd: VERIFY_BODY,
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(
      result.advisories.filter((a) => a.severity === 'likely-post-merge-child-under-container'),
    ).toEqual([
      {
        kind: 'shape',
        item: child.identifier,
        severity: 'likely-post-merge-child-under-container',
        phrase: 'earliest legal start',
        container: story.identifier,
      },
    ]);
  });

  it('is quiet when the same card sits beside the story under an epic', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, 'epic', 'Planning capacity follows demand');
    await make(fx, 'task', 'Run the seven verification steps on production', {
      parentId: epic.id,
      type: 'verification',
      executor: 'human',
      descriptionMd: VERIFY_BODY,
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, epic.identifier, fx.ctx);
    expect(
      result.advisories.filter((a) => a.severity === 'likely-post-merge-child-under-container'),
    ).toEqual([]);
  });

  it('is quiet on an ordinary code child of a story', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, 'story', 'A story');
    await make(fx, 'task', 'Build it', {
      parentId: story.id,
      type: 'code',
      executor: 'coding_agent',
      descriptionMd: 'Read the live tenant in production.',
    });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(
      result.advisories.filter((a) => a.severity === 'likely-post-merge-child-under-container'),
    ).toEqual([]);
  });
});

describe('validate_work_item — SECTION findings, advisory (MOTIR-9032)', () => {
  const run = async (fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, key: string) => {
    const client = await connectClient(fx.ctx);
    return (await client.callTool({
      name: 'validate_work_item',
      arguments: { key },
    })) as CallToolResult;
  };

  it('names a bare child as UNSTRUCTURED in a VALID verdict, says it is advisory, and leaves `valid` true', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Bare child', 'task', story.id);

    const res = await run(fx, story.identifier);
    const body = res.structuredContent as unknown as WorkItemValidityDto;
    expect(body.valid).toBe(true);
    expect(body.sectionFindings.map((f) => f.item)).toContain(child.identifier);
    const finding = body.sectionFindings.find((f) => f.item === child.identifier)!;
    expect(finding.state).toBe('unstructured');
    expect(finding.missing.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.content);
    expect(text).toContain('is VALID');
    expect(text).toContain('advisory — they do NOT change VALID');
    expect(text).toContain(`${child.identifier} (task/code, unstructured)`);
  });

  it('is silent when every card carries its required sections', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'story',
        title: 'Story',
        sections: sectionsFixture('story', null) as never,
      },
      fx.ctx,
    );
    const res = await run(fx, story.identifier);
    const body = res.structuredContent as unknown as WorkItemValidityDto;
    expect(body.sectionFindings).toEqual([]);
    expect(JSON.stringify(res.content)).not.toContain('Section findings');
  });
});
