import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as getInternalSectionSets } from '@/app/api/internal/ai/section-sets/route';
import { GET as getV1SectionSets } from '@/app/api/v1/section-sets/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { mintJobToken } from '@/lib/ai/jobToken';
import { db } from '@/lib/db';
import { isUnderAuthoredAdvisory, type WorkItemValidityAdvisoryDto } from '@/lib/dto/workItems';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runValidatePlan } from '@/lib/mcp/tools/validatePlan';
import { runValidateWorkItem } from '@/lib/mcp/tools/validateWorkItem';
import { presentSectionSets } from '@/lib/api/v1/sectionSets/schema';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { acceptanceCriteriaSpan, acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';
import { parseSections } from '@/lib/workItems/sections/parse';
import { describeSectionSets, type WorkItemSections } from '@/lib/workItems/sections/registry';
import { renderSections } from '@/lib/workItems/sections/render';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkspace,
  createTestProject,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  DOOR_CELLS,
  GATE_BOUNDARY,
  GATE_CRITERIA,
  GATE_REF_PATHS,
  gateSections,
} from '../../helpers/sectionsGate';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { extractScopeBoundary } from '../../unit/workItems/sections/helpers/extractScopeBoundary';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE — the motir-core side of MOTIR-9023 (Subtask MOTIR-9036).
//
// Seven motir-core cards built "a typed sections WRITE interface over the free-text
// `descriptionMd`": the registry, the renderer, the parser, the registry read, the
// plan doors, the work-item doors, validation by parsing, the parsed read view.
// Each tested its own unit. This file drives the ASSEMBLED surface through its real
// entrances (the MCP tools, the v1 route, the services) against real Postgres, and
// compares one door's output with another's, with the three heading readers
// (`splitPlanBody`, `acceptanceCriteriaTexts`, the scope-boundary reader) and with
// the parse on two read surfaces.
//
// NOTHING STRUCTURED IS STORED (the story's decision): every seam is judged on the
// one `descriptionMd` body and on what is computed from it at read time.
//
// Case → where it is held:
//   seam 1  sections → render → readers ........ HERE (every cell × two doors, approve,
//                                                 the dispatch prompt)
//   seam 2  the `| ` gutter hides nothing ........ HERE
//   seam 3  round trip and free text ............. `sectionsFreeTextRoundTrip.test.ts`
//   seam 4  validation names a missing section .... HERE (plan); the corpus half is in
//                                                 `sectionsFreeTextRoundTrip.test.ts`
//   seam 5  one contract on every door ........... HERE
//
// Mocks: none. The MCP server, the v1 route, the internal route, job-token auth and
// Postgres are all real.
// ════════════════════════════════════════════════════════════════════════════

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'sections-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function openPlanViaTool(client: Client, fx: WorkItemFixture, title: string) {
  const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title,
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  return struct(opened)['id'] as string;
}

async function appendViaTool(
  client: Client,
  planId: string,
  proposals: { title: string; kind: string; type?: string | null; sections?: unknown }[],
): Promise<string[]> {
  const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: proposals.map((p) => ({
      op: 'add',
      proposedFields: {
        title: p.title,
        kind: p.kind,
        ...(p.type ? { type: p.type } : {}),
        ...(p.sections !== undefined ? { sections: p.sections } : {}),
      },
    })),
  });
  expect(res.isError, text(res)).toBeFalsy();
  return struct(res)['planItemIds'] as string[];
}

async function planItemBody(itemId: string): Promise<string> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return (row.proposedFields as Record<string, unknown>)['descriptionMd'] as string;
}

async function workItemBody(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).descriptionMd as string;
}

/** A criterion as `acceptanceCriteriaTexts` returns it — bullet marker and the
 *  trailing blank lines the span carries removed. */
const criterionText = (c: string) => c.replace(/^\s*-\s*/, '').trim();

// ── Seam 1 — sections → render → readers ──────────────────────────────────────

describe('seam 1 — a section written through a door is the section every reader finds', () => {
  it('every cell with acceptance criteria: the plan door and the work-item door store ONE body the readers agree on', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, 'Seam 1');
    expect(DOOR_CELLS.length).toBeGreaterThan(0);

    const itemIds = await appendViaTool(
      client,
      planId,
      DOOR_CELLS.map(({ kind, type }) => ({
        title: `Plan ${kind} ${type ?? 'none'}`,
        kind,
        type,
        sections: gateSections(kind, type),
      })),
    );
    expect(itemIds).toHaveLength(DOOR_CELLS.length);

    const planView = await runGetPlan({ planId, includeSections: true }, fx.ctx);
    const parsedByItem = struct(planView)['parsedSections'] as Record<
      string,
      ReturnType<typeof parseSections>
    >;

    for (const [index, { kind, type }] of DOOR_CELLS.entries()) {
      const label = `${kind} / ${type ?? 'none'}`;
      const written = gateSections(kind, type);
      const itemId = itemIds[index]!;

      // The plan door stored the rendered body and nothing structured.
      const stored = (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
        .proposedFields as Record<string, unknown>;
      expect(stored, label).not.toHaveProperty('sections');
      const planBody = stored['descriptionMd'] as string;
      expect(planBody, label).toBe(renderSections(kind, type, written));

      // Three independent heading readers find what was written.
      const split = splitPlanBody(planBody);
      expect(split.acceptanceCriteria.map(criterionText), label).toEqual(GATE_CRITERIA);
      expect(split.contextRefs, label).toEqual(GATE_REF_PATHS);
      expect(acceptanceCriteriaTexts(planBody), label).toHaveLength(
        split.acceptanceCriteria.length,
      );
      expect(acceptanceCriteriaTexts(planBody).map(criterionText), label).toEqual(GATE_CRITERIA);
      expect(extractScopeBoundary(planBody), label).toBe(GATE_BOUNDARY);

      // The parsed read view returns the sections that were written, nothing missing.
      const view = parsedByItem[itemId]!;
      expect(view.missing, label).toEqual([]);
      expect(view.signals, label).toEqual([]);
      expect(view.sections.scopeBoundary, label).toBe(GATE_BOUNDARY);
      expect(view.sections.acceptanceCriteria, label).toEqual(GATE_CRITERIA);
      expect(view.sections.contextRefs, label).toEqual(written.contextRefs);

      // The work-item door renders the same card the same way.
      const created = await runCreateWorkItem(
        {
          projectKey: fx.projectIdentifier,
          kind,
          title: `Door ${kind} ${type ?? 'none'}`,
          ...(type ? { type } : {}),
          sections: written,
        },
        fx.ctx,
      );
      expect(created.isError, `${label}: ${text(created)}`).toBeFalsy();
      const createdItem = struct(created) as { id: string; identifier: string };
      expect(await workItemBody(createdItem.id), label).toBe(planBody);

      const read = await runGetWorkItem(
        { key: createdItem.identifier, includeSections: true },
        fx.ctx,
      );
      const readView = struct(read)['parsedSections'] as ReturnType<typeof parseSections>;
      expect(readView.sections, label).toEqual(view.sections);
      expect(readView.missing, label).toEqual([]);
      expect(readView.signals, label).toEqual([]);
    }
    await client.close();
  });

  it('an epic with valid sections has no acceptance-criteria span', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, 'Epic');
    const [itemId] = await appendViaTool(client, planId, [
      {
        title: 'An epic',
        kind: 'epic',
        sections: gateSections('epic', null),
      },
    ]);
    const body = await planItemBody(itemId!);
    expect(body).toBe(renderSections('epic', null, gateSections('epic', null)));
    expect(acceptanceCriteriaSpan(body)).toBeNull();
    expect(acceptanceCriteriaTexts(body)).toEqual([]);
    await client.close();
  });

  it('approve carries the body across; the card reads clean; the dispatch prompt carries every criterion and ref', async () => {
    const fx = await makeWorkItemFixture();
    const written = gateSections('task', 'code');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Approve me' }, fx.ctx);
    const added = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Sectioned and approved',
            kind: 'task',
            type: 'code',
            sections: written,
          } as never,
        },
      ],
      fx.ctx,
    );
    const proposedBody = await planItemBody(added.appendedItemIds[0]!);
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const card = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Sectioned and approved' },
    });
    expect(card.descriptionMd).toBe(proposedBody);

    const validity = struct(await runValidateWorkItem({ key: card.identifier }, fx.ctx));
    expect(validity['sectionFindings']).toEqual([]);

    const prompt = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    for (const criterion of GATE_CRITERIA) expect(prompt.prompt).toContain(criterion);
    for (const ref of GATE_REF_PATHS) expect(prompt.prompt).toContain(ref);
  });
});

// ── Seam 2 — the `| ` gutter hides nothing ────────────────────────────────────

/** Every line of `md` prefixed `| ` (blank lines stay blank, as a pasted quote does). */
const gutter = (md: string) =>
  md
    .split('\n')
    .map((l) => (l === '' ? l : `| ${l}`))
    .join('\n');

describe('seam 2 — a `| `-gutter section hides nothing', () => {
  it('a gutter-prefixed framing sent through the plan door leaves every reader, validate_plan and the advisory clean', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, 'Gutter');
    const written = gateSections('task', 'code');
    const [itemId] = await appendViaTool(client, planId, [
      { title: 'Gutter card', kind: 'task', type: 'code', sections: written },
    ]);
    const before = await planItemBody(itemId!);

    // The defect of plan cmvez6dl300gmhmrffl127q95: an opening paragraph whose every
    // line starts `| `, containing the very headings the readers look for.
    const framing = [
      '| ## Acceptance criteria',
      '| - quoted, not a criterion',
      '| ## Scope BOUNDARY',
      '| quoted, not a boundary',
    ].join('\n');
    const updated = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: itemId,
      sections: { framing },
    });
    expect(updated.isError, text(updated)).toBeFalsy();

    const body = await planItemBody(itemId!);
    expect(body).not.toBe(before);
    expect(body).toContain(framing);
    // The quoted headings are not at the start of a line, so they are not headings.
    expect(body.split('\n').filter((l) => l === '## Acceptance criteria')).toHaveLength(1);
    expect(body.split('\n').filter((l) => l === '## Scope BOUNDARY')).toHaveLength(1);

    // All three readers still return the ORIGINAL sections.
    expect(extractScopeBoundary(body)).toBe(GATE_BOUNDARY);
    expect(splitPlanBody(body).acceptanceCriteria.map(criterionText)).toEqual(GATE_CRITERIA);
    expect(acceptanceCriteriaTexts(body).map(criterionText)).toEqual(GATE_CRITERIA);

    // The parsed view returns the new framing and the unchanged others.
    const view = (
      struct(await runGetPlan({ planId, includeSections: true }, fx.ctx))[
        'parsedSections'
      ] as Record<string, ReturnType<typeof parseSections>>
    )[itemId!]!;
    expect(view.sections.framing).toBe(framing);
    expect(view.sections.scopeBoundary).toBe(GATE_BOUNDARY);
    expect(view.sections.acceptanceCriteria).toEqual(GATE_CRITERIA);
    expect(view.missing).toEqual([]);

    // validate_plan names nothing for the card.
    await plansService.markPlanned(planId, fx.ctx);
    const verdict = struct(await runValidatePlan({ planId }, fx.ctx));
    expect(verdict['sectionFindings']).toEqual([]);
    await client.close();
  });

  it('the under-authored advisory reports nothing on the sections-written card, and no-heading on a whole-body gutter', async () => {
    const fx = await makeWorkItemFixture();
    const written = gateSections('task', null);
    const clean = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Written through sections',
        sections: { ...written, framing: gutter('Quoted opening.\nSecond quoted line.') },
      },
      fx.ctx,
    );
    const body = renderSections('task', null, written);
    const corrupted = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Gutter all over',
        descriptionMd: gutter(body),
      },
      fx.ctx,
    );
    // The advisory fires on a card with no sizing fields, no type and no executor.
    await adminDb.workItem.updateMany({
      where: { id: { in: [clean.id, corrupted.id] } },
      data: { type: null, executor: null, storyPoints: null, estimateMinutes: null },
    });

    const cleanVerdict = struct(await runValidateWorkItem({ key: clean.identifier }, fx.ctx));
    const cleanAdvisories = cleanVerdict['advisories'] as WorkItemValidityAdvisoryDto[];
    expect(cleanAdvisories.filter(isUnderAuthoredAdvisory)).toEqual([]);
    expect(cleanVerdict['sectionFindings']).toEqual([]);

    // Contrast: a plain `descriptionMd` that is the same body with every line gutter-
    // prefixed is stored as sent, and read as what it is — named, not passed.
    expect(await workItemBody(corrupted.id)).toBe(gutter(body));
    const verdict = struct(await runValidateWorkItem({ key: corrupted.identifier }, fx.ctx));
    const findings = verdict['sectionFindings'] as {
      item: string;
      missing: string[];
      signals: string[];
    }[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.item).toBe(corrupted.identifier);
    expect(findings[0]!.signals).toContain('quoted-gutter');
    expect(findings[0]!.missing).toEqual(
      expect.arrayContaining(['scopeBoundary', 'acceptanceCriteria']),
    );
    const advisories = (verdict['advisories'] as WorkItemValidityAdvisoryDto[]).filter(
      isUnderAuthoredAdvisory,
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.criteria).toBe('no-heading');
  });
});

// ── Seam 4 — validation names a missing section on read ───────────────────────

describe('seam 4 — validate_plan names a missing section by parsing, and never changes the verdict', () => {
  it('a title-only add and a heading-less add are named; the complete add is not; valid and the lists are unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    async function planOf(
      title: string,
      adds: { title: string; descriptionMd?: string; sections?: WorkItemSections }[],
    ): Promise<{ planId: string; itemIds: string[] }> {
      const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
      const appended = await plansService.addProposals(
        plan.id,
        adds.map((a) => ({
          op: 'add' as const,
          proposedFields: { kind: 'task', type: 'code', ...a } as never,
        })),
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      return { planId: plan.id, itemIds: appended.appendedItemIds };
    }

    const mixed = await planOf('Mixed', [
      { title: 'Title only' },
      { title: 'Complete', sections: gateSections('task', 'code') },
      { title: 'Heading-less', descriptionMd: 'Just a paragraph, nothing else.' },
    ]);
    const complete = await planOf('All complete', [
      { title: 'Title only', sections: gateSections('task', 'code') },
      { title: 'Complete', sections: gateSections('task', 'code') },
      { title: 'Heading-less', sections: gateSections('task', 'code') },
    ]);

    const verdict = struct(await runValidatePlan({ planId: mixed.planId }, fx.ctx));
    const findings = verdict['sectionFindings'] as {
      item: string;
      state: string;
      missing: string[];
    }[];
    const [titleOnly, completeId, headingLess] = mixed.itemIds;
    expect(findings.map((f) => f.item).sort()).toEqual(
      [`planItem:${titleOnly}`, `planItem:${headingLess}`].sort(),
    );
    expect(findings.find((f) => f.item === `planItem:${completeId}`)).toBeUndefined();
    const forTitleOnly = findings.find((f) => f.item === `planItem:${titleOnly}`)!;
    expect(forTitleOnly.state).toBe('unstructured');
    expect(forTitleOnly.missing).toEqual([
      'framing',
      'scopeBoundary',
      'acceptanceCriteria',
      'contextRefs',
    ]);
    const forHeadingLess = findings.find((f) => f.item === `planItem:${headingLess}`)!;
    expect(forHeadingLess.state).toBe('unstructured');
    expect(forHeadingLess.missing).toEqual(['scopeBoundary', 'acceptanceCriteria', 'contextRefs']);

    // The advisory channel never moves the verdict: the same plan with every card
    // complete (no findings) answers the same on every verdict field.
    const baseline = struct(await runValidatePlan({ planId: complete.planId }, fx.ctx));
    expect(baseline['sectionFindings']).toEqual([]);
    for (const field of ['valid', 'blockers', 'rejections', 'invalidEdges', 'crossLevelEdges']) {
      expect(verdict[field], field).toEqual(baseline[field]);
    }
    await client.close();
  });
});

// ── Seam 5 — one contract on every door ───────────────────────────────────────

describe('seam 5 — one missing or unknown section is refused with the same name on every door', () => {
  const BASE = 'http://localhost:3000/api/v1';

  /** The four doors, each answering "refused, naming `needle`, nothing written". */
  async function refusedEverywhere(args: {
    kind: string;
    type: string | null;
    sections: Record<string, unknown>;
    needle: string;
  }) {
    const { kind, type, sections, needle } = args;
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, `Refuse ${needle}`);
    const planItems = () => adminDb.planItem.count({ where: { planId } });
    const workItems = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const typeArg = type ? { type: type as never } : {};

    // 1 — add_plan_items
    const add = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'x', kind, ...typeArg, sections } }],
    });
    expect(add.isError).toBe(true);
    expect(text(add)).toContain('INVALID_PROPOSAL');
    expect(text(add)).toContain(needle);
    expect(await planItems()).toBe(0);

    // 2 — create_work_item
    const created = await runCreateWorkItem(
      { projectKey: fx.projectIdentifier, kind: kind as never, title: 'x', ...typeArg, sections },
      fx.ctx,
    );
    expect(created.isError).toBe(true);
    expect(JSON.stringify(created.content)).toContain('INVALID_SECTIONS');
    expect(JSON.stringify(created.content)).toContain(needle);
    const stillNone = await workItems();

    // 3 — POST /api/v1/projects/{projectKey}/work-items
    const caller = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
    });
    const posted = await POST(
      new Request(`${BASE}/projects/${caller.projectKey}/work-items`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind, title: 'x', ...typeArg, sections }),
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(posted.status).toBe(422);
    const postedBody = JSON.stringify(await posted.json());
    expect(postedBody).toContain('INVALID_SECTIONS');
    expect(postedBody).toContain(needle);

    expect(await adminDb.workItem.count({ where: { projectId: caller.fixture.projectId } })).toBe(
      0,
    );
    expect(await workItems()).toBe(stillNone);
    await client.close();
  }

  it('a task/code with acceptanceCriteria: [] names acceptanceCriteria on three doors and writes nothing', async () => {
    await refusedEverywhere({
      kind: 'task',
      type: 'code',
      sections: { ...gateSections('task', 'code'), acceptanceCriteria: [] },
      needle: 'acceptanceCriteria',
    });
  });

  it('a decision task missing its alternatives names alternatives on every door', async () => {
    const { alternatives: _omitted, ...withoutAlternatives } = gateSections('task', 'decision');
    await refusedEverywhere({
      kind: 'task',
      type: 'decision',
      sections: withoutAlternatives,
      needle: 'alternatives',
    });
  });

  it('an epic carrying acceptanceCriteria is refused naming it', async () => {
    await refusedEverywhere({
      kind: 'epic',
      type: null,
      sections: { ...gateSections('epic', null), acceptanceCriteria: ['not for an epic'] },
      needle: 'acceptanceCriteria',
    });
  });

  it('the correction door (update_plan_proposal) refuses the same missing section by the same name', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, 'Correct');
    const [itemId] = await appendViaTool(client, planId, [
      { title: 'Card', kind: 'task', type: 'code', sections: gateSections('task', 'code') },
    ]);
    const before = await planItemBody(itemId!);
    const refused = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      sections: { acceptanceCriteria: [] },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('acceptanceCriteria');
    expect(await planItemBody(itemId!)).toBe(before);
    await client.close();
  });

  it('sections together with descriptionMd are refused on the plan door and the work-item door, naming both keys', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlanViaTool(client, fx, 'Both');
    const both = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'x',
            kind: 'task',
            type: 'code',
            descriptionMd: 'free text',
            sections: gateSections('task', 'code'),
          },
        },
      ],
    });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('sections');
    expect(text(both)).toContain('descriptionMd');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);

    const created = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        kind: 'task',
        title: 'x',
        type: 'code',
        descriptionMd: 'free text',
        sections: gateSections('task', 'code'),
      },
      fx.ctx,
    );
    expect(created.isError).toBe(true);
    const createdText = JSON.stringify(created.content);
    expect(createdText).toContain('SECTIONS_AND_DESCRIPTION_CONFLICT');
    expect(createdText).toContain('sections');
    expect(createdText).toContain('descriptionMd');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    await client.close();
  });

  it('the three registry transports serve one descriptor, and the internal route’s ETag is its version', async () => {
    const SERVICE_SECRET = 'core-callback-secret-test';
    process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
    const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      identifier: 'SEC',
      name: 'Sections',
    });
    const internal = await getInternalSectionSets(
      new Request('http://core/api/internal/ai/section-sets', {
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken({
            userId: owner.id,
            workspaceId: workspace.id,
            projectId: project.id,
          }),
        },
      }),
    );
    expect(internal.status).toBe(200);
    const descriptor = describeSectionSets();
    expect(await internal.json()).toEqual(descriptor);
    expect(internal.headers.get('etag')).toBe(`"${descriptor.version}"`);

    const caller = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
    });
    const v1 = await getV1SectionSets(
      new Request(`${BASE_V1}/section-sets`, { headers: caller.headers }),
    );
    expect(v1.status).toBe(200);
    expect(await v1.json()).toEqual(presentSectionSets(descriptor));

    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const viaTool = await call(client, 'get_section_sets', {});
    expect(struct(viaTool)).toEqual(presentSectionSets(descriptor));
    await client.close();
  });
});

const BASE_V1 = 'http://localhost:3000/api/v1';
