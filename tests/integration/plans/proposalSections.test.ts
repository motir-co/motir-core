import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidProposalError } from '@/lib/plans/errors';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-9023 · Subtask MOTIR-9030 — the PLAN doors take an optional typed
// `sections` input, check it by name, render it into the free-text `descriptionMd`
// and store ONLY that body. One case per rule of the card, against real Postgres.
//
// The assertions read the stored `proposedFields` through `adminDb`, not the
// returned DTO: a door that rendered the body and ALSO stored the `sections`
// object would satisfy the DTO and not the table, and "nothing structured is
// stored" is the property the decision rests on.

const sections = {
  framing: 'Why this card exists.',
  scopeBoundary: 'Stops at the renderer.',
  acceptanceCriteria: ['It renders.', 'It refuses by name.'],
  contextRefs: [{ ref: 'lib/a.ts', why: 'the module' }],
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function newPlan(fx: WorkItemFixture) {
  return plansService.createPlan(
    fx.projectId,
    { title: 'Sectioned', authorSource: 'mcp', authorHarness: 'Claude Code' },
    fx.ctx,
  );
}

async function storedFields(itemId: string): Promise<Record<string, unknown>> {
  return (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
    .proposedFields as Record<string, unknown>;
}

async function appendOne(
  fx: WorkItemFixture,
  planId: string,
  proposedFields: Record<string, unknown>,
): Promise<string> {
  const added = await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { kind: 'task', type: 'code', ...proposedFields } as never }],
    fx.ctx,
  );
  return added.appendedItemIds[0]!;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return (err as Error).message;
  }
  throw new Error('expected an InvalidProposalError');
}

const criteriaOf = (body: string) =>
  splitPlanBody(body).acceptanceCriteria.map((l) => l.replace(/^\s*-\s*/, ''));

describe('an `add` carrying sections', () => {
  it('stores the rendered body and NOTHING else — the sections object is never persisted', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Sectioned card', sections });

    const fields = await storedFields(itemId);
    const body = fields['descriptionMd'] as string;
    expect(body).toContain('## Scope BOUNDARY');
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('## Context refs');
    expect(fields).not.toHaveProperty('sections');
    expect(criteriaOf(body)).toEqual(sections.acceptanceCriteria);
    expect(splitPlanBody(body).contextRefs).toEqual(['lib/a.ts']);
  });

  it('refuses an empty required list, naming the section, and appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const message = await refusal(
      appendOne(fx, plan.id, {
        title: 'No criteria',
        sections: { ...sections, acceptanceCriteria: [] },
      }),
    );
    expect(message).toContain('missing required section(s): acceptanceCriteria');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('refuses a decision with no options, naming `options`', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const message = await refusal(
      appendOne(fx, plan.id, {
        title: 'Decide',
        type: 'decision',
        sections: { ...sections, question: 'Which?', recommendation: 'The first.' },
      }),
    );
    expect(message).toContain('options');
  });

  it('names a section the cell does not define as unknown — an epic carrying acceptanceCriteria', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const message = await refusal(
      appendOne(fx, plan.id, {
        title: 'An epic',
        kind: 'epic',
        type: null,
        sections: { framing: 'f', scopeBoundary: 'b', acceptanceCriteria: ['x'] },
      }),
    );
    expect(message).toContain('acceptanceCriteria');
    expect(message).toContain('not defined');
  });

  it('refuses `sections` beside `descriptionMd`, naming both keys', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const message = await refusal(
      appendOne(fx, plan.id, { title: 'Two sources', descriptionMd: 'a body', sections }),
    );
    expect(message).toContain('`sections`');
    expect(message).toContain('`descriptionMd`');
  });

  it('stores a `descriptionMd`-only add byte for byte, as before', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const body = 'Hand-written.\n\n## Acceptance criteria\n- one\n';
    const itemId = await appendOne(fx, plan.id, { title: 'Plain', descriptionMd: body });
    expect((await storedFields(itemId))['descriptionMd']).toBe(body);
  });
});

describe('a `modify` or `remove` carrying sections', () => {
  it('is refused by name — sections on a committed card belong to the work-item doors', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });
    const message = await refusal(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: target.id, patch: { sections } as never }],
        fx.ctx,
      ),
    );
    expect(message).toContain('`sections`');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });
});

describe('a sparse edit over the stored body', () => {
  it('deepen: a scopeBoundary alone changes only the boundary', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    const before = (await storedFields(itemId))['descriptionMd'] as string;

    await plansService.deepenProposal(
      plan.id,
      itemId,
      { sections: { scopeBoundary: 'Stops at the parser.' } },
      fx.ctx,
    );
    const fields = await storedFields(itemId);
    const after = fields['descriptionMd'] as string;
    expect(after).toContain('Stops at the parser.');
    expect(after).not.toContain('Stops at the renderer.');
    expect(after.replace('Stops at the parser.', 'Stops at the renderer.')).toBe(before);
    expect(criteriaOf(after)).toEqual(criteriaOf(before));
    expect(splitPlanBody(after).contextRefs).toEqual(splitPlanBody(before).contextRefs);
    expect(fields).not.toHaveProperty('sections');
  });

  it('keeps every line of a hand-written body that has no headings, in the re-rendered framing', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const handWritten = 'Free text the planner wrote.\nA second line of it.';
    const itemId = await appendOne(fx, plan.id, {
      title: 'Hand written',
      descriptionMd: handWritten,
    });

    // The still-missing required sections are named, and nothing is stored.
    const message = await refusal(
      plansService.deepenProposal(plan.id, itemId, { sections: { scopeBoundary: 'b' } }, fx.ctx),
    );
    expect(message).toContain('missing required section(s): acceptanceCriteria, contextRefs');
    expect((await storedFields(itemId))['descriptionMd']).toBe(handWritten);

    await plansService.deepenProposal(
      plan.id,
      itemId,
      {
        sections: {
          scopeBoundary: 'b',
          acceptanceCriteria: ['a'],
          contextRefs: [{ ref: 'lib/a.ts', why: 'w' }],
        },
      },
      fx.ctx,
    );
    const body = (await storedFields(itemId))['descriptionMd'] as string;
    for (const line of handWritten.split('\n')) expect(body).toContain(line);
  });

  it('a framing with every line prefixed `| ` still leaves the criteria and refs readable', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });

    await plansService.deepenProposal(
      plan.id,
      itemId,
      { sections: { framing: '| pasted from a quote\n| second quoted line' } },
      fx.ctx,
    );
    const split = splitPlanBody((await storedFields(itemId))['descriptionMd'] as string);
    expect(split.acceptanceCriteria).toHaveLength(2);
    expect(split.contextRefs).toEqual(['lib/a.ts']);
  });

  it('an explicit null clears an optional section; a list replaces the list', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, {
      title: 'Card',
      sections: { ...sections, assumptions: ['A stays true.'] },
    });
    expect((await storedFields(itemId))['descriptionMd'] as string).toContain('Assumptions');

    await plansService.deepenProposal(
      plan.id,
      itemId,
      { sections: { assumptions: null, acceptanceCriteria: ['Only this.'] } },
      fx.ctx,
    );
    const body = (await storedFields(itemId))['descriptionMd'] as string;
    expect(body).not.toContain('Assumptions');
    expect(criteriaOf(body)).toEqual(['Only this.']);
  });

  it('is judged on the MERGED kind × type: a re-type to decision names what it now requires', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    const message = await refusal(
      plansService.deepenProposal(
        plan.id,
        itemId,
        { type: 'decision', sections: { framing: 'Still framed.' } },
        fx.ctx,
      ),
    );
    expect(message).toContain('question, options, recommendation');
  });

  it('refuses `sections` beside `descriptionMd` on an edit, naming both keys', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    const message = await refusal(
      plansService.deepenProposal(
        plan.id,
        itemId,
        { descriptionMd: 'another', sections: { framing: 'f' } },
        fx.ctx,
      ),
    );
    expect(message).toContain('`sections`');
    expect(message).toContain('`descriptionMd`');
  });

  it('revise (a planned plan) and correct take sections through the same path', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.reviseProposal(
      plan.id,
      itemId,
      { sections: { scopeBoundary: 'Revised boundary.' } },
      fx.ctx,
    );
    expect((await storedFields(itemId))['descriptionMd'] as string).toContain('Revised boundary.');

    await plansService.correctProposal(
      plan.id,
      itemId,
      { sections: { acceptanceCriteria: ['Corrected.'] } },
      fx.ctx,
    );
    const body = (await storedFields(itemId))['descriptionMd'] as string;
    expect(criteriaOf(body)).toEqual(['Corrected.']);
    expect(body).toContain('Revised boundary.');
    expect(await storedFields(itemId)).not.toHaveProperty('sections');
  });

  it('a review PATCH `descriptionMd` edit stores exactly the text sent', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    await plansService.markPlanned(plan.id, fx.ctx);

    const edited = 'A person typed this.\n\n## Acceptance criteria\n- whatever\n';
    await plansService.updateProposal(plan.id, itemId, { descriptionMd: edited }, fx.ctx);
    expect((await storedFields(itemId))['descriptionMd']).toBe(edited);
  });
});

describe('two concurrent edits sending disjoint sections', () => {
  it('both land: the parse-merge-render-write runs under the plan row lock', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx);
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });

    await Promise.all([
      plansService.deepenProposal(
        plan.id,
        itemId,
        { sections: { framing: 'Framing from A.' } },
        fx.ctx,
      ),
      plansService.deepenProposal(
        plan.id,
        itemId,
        { sections: { scopeBoundary: 'Boundary from B.' } },
        fx.ctx,
      ),
    ]);
    const body = (await storedFields(itemId))['descriptionMd'] as string;
    expect(body).toContain('Framing from A.');
    expect(body).toContain('Boundary from B.');
    expect(criteriaOf(body)).toEqual(sections.acceptanceCriteria);
  });
});

// ── The MCP doors ─────────────────────────────────────────────────────────────
// A real MCP client over the in-memory transport: the schema each tool declares is
// what refuses an unknown key, so each door is proven by CALLING it with the key.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'proposal-sections', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe('the MCP plan tools carry `sections`', () => {
  it('add_plan_items, update_plan_item and update_plan_proposal pass a valid object through', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Through the tools',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    });
    const planId = struct(opened).id;

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Sectioned', kind: 'task', type: 'code', sections } },
      ],
    });
    expect(appended.isError).toBeFalsy();
    const itemId = (appended.structuredContent as unknown as { planItemIds: string[] })
      .planItemIds[0]!;
    expect((await storedFields(itemId))['descriptionMd'] as string).toContain('## Scope BOUNDARY');
    expect(await storedFields(itemId)).not.toHaveProperty('sections');

    const deepened = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: itemId,
      sections: { scopeBoundary: 'From update_plan_item.' },
    });
    expect(deepened.isError).toBeFalsy();
    expect((await storedFields(itemId))['descriptionMd'] as string).toContain(
      'From update_plan_item.',
    );

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      sections: { acceptanceCriteria: ['From update_plan_proposal.'] },
    });
    expect(corrected.isError).toBeFalsy();
    const body = (await storedFields(itemId))['descriptionMd'] as string;
    expect(criteriaOf(body)).toEqual(['From update_plan_proposal.']);
    expect(body).toContain('From update_plan_item.');
    await client.close();
  });

  it('a missing section is the typed INVALID_PROPOSAL naming it; a wrong-typed value is refused too', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Refusals',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    });
    const planId = struct(opened).id;

    const missing = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Incomplete',
            kind: 'task',
            type: 'code',
            sections: { framing: 'f', scopeBoundary: 'b' },
          },
        },
      ],
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('INVALID_PROPOSAL');
    expect(text(missing)).toContain('acceptanceCriteria');

    const wrongType = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Bad', kind: 'task', sections: 'not an object' } },
      ],
    });
    expect(wrongType.isError).toBe(true);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });
});

// Bug MOTIR-9836 — the MOTIR-9175 link check judged `input.descriptionMd`, which a
// `sections` write never sends, so a dangling `planItem:` link written through
// sections passed the deepen / revise and the correction. It is judged on the
// rendered body now, with a link the stored body already carried left repairable.
describe('a `sections` edit linking a planItem the plan does not hold (MOTIR-9836)', () => {
  const deadRefs = {
    contextRefs: [{ ref: '[x](motir-ref:planItem:doesnotexist)', why: 'a mistyped id' }],
  };

  async function withSibling(fx: WorkItemFixture) {
    const plan = await newPlan(fx);
    const siblingId = await appendOne(fx, plan.id, { title: 'Sibling', sections });
    const itemId = await appendOne(fx, plan.id, { title: 'Card', sections });
    return { planId: plan.id, siblingId, itemId };
  }

  it('the deepen refuses it, naming the id, and leaves the body as it was', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await withSibling(fx);
    const before = (await storedFields(itemId))['descriptionMd'];

    const message = await refusal(
      plansService.deepenProposal(planId, itemId, { sections: deadRefs }, fx.ctx),
    );
    expect(message).toContain('planItem:doesnotexist');
    expect((await storedFields(itemId))['descriptionMd']).toBe(before);
  });

  it('the correction refuses it too, and accepts a link to a proposal the plan holds', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId, itemId } = await withSibling(fx);

    const message = await refusal(
      plansService.correctProposal(planId, itemId, { sections: deadRefs }, fx.ctx),
    );
    expect(message).toContain('planItem:doesnotexist');

    await plansService.correctProposal(
      planId,
      itemId,
      {
        sections: {
          contextRefs: [{ ref: `[s](motir-ref:planItem:${siblingId})`, why: 'the sibling' }],
        },
      },
      fx.ctx,
    );
    expect((await storedFields(itemId))['descriptionMd']).toContain(
      `motir-ref:planItem:${siblingId}`,
    );
  });

  it('accepts a sections edit that leaves an INHERITED dangling link untouched, so it stays repairable', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId, itemId } = await withSibling(fx);
    await plansService.deepenProposal(
      planId,
      itemId,
      { sections: { contextRefs: [{ ref: `[s](motir-ref:planItem:${siblingId})`, why: 'w' }] } },
      fx.ctx,
    );
    // The link goes dangling behind the door's back, as a body stored before
    // the MOTIR-9175 check would.
    const stored = (await storedFields(itemId))['descriptionMd'] as string;
    await adminDb.planItem.update({
      where: { id: itemId },
      data: {
        proposedFields: {
          ...(await storedFields(itemId)),
          descriptionMd: stored.replace(siblingId, 'pi_gone'),
        } as never,
      },
    });

    await plansService.deepenProposal(
      planId,
      itemId,
      { sections: { scopeBoundary: 'Stops at the parser.' } },
      fx.ctx,
    );
    await plansService.correctProposal(
      planId,
      itemId,
      { sections: { framing: 'Reworded framing.' } },
      fx.ctx,
    );
    const after = (await storedFields(itemId))['descriptionMd'] as string;
    expect(after).toContain('Stops at the parser.');
    expect(after).toContain('motir-ref:planItem:pi_gone');

    // ...and a new dangling link beside the inherited one is still refused.
    await refusal(plansService.deepenProposal(planId, itemId, { sections: deadRefs }, fx.ctx));
  });
});
