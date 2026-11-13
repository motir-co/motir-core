import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { renderSections } from '@/lib/workItems/sections/render';
import type { WorkItemSections } from '@/lib/workItems/sections/registry';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `create_work_item` / `update_work_item` take `sections` (Story MOTIR-9023 ·
// MOTIR-9031) against real Postgres: the sections render into the stored
// description, and a refusal is the typed tool error NAMING the section.

const LEAF: WorkItemSections = {
  framing: 'Add the export button.',
  scopeBoundary: 'Only the toolbar.',
  acceptanceCriteria: ['The button downloads a CSV.'],
  contextRefs: [{ ref: 'components/Toolbar.tsx', why: 'where the button lives' }],
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Structured = { identifier: string; descriptionMd: string | null };

describe('sections on the MCP work-item tools', () => {
  it('create renders the sections into descriptionMd', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Export', type: 'code', sections: LEAF },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Structured).descriptionMd).toBe(
      renderSections('task', 'code', LEAF),
    );
  });

  it('create with a missing section is INVALID_SECTIONS naming it, and creates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { acceptanceCriteria: _omitted, ...without } = LEAF;
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'x', type: 'code', sections: without },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('INVALID_SECTIONS');
    expect(text).toContain('acceptanceCriteria');
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('both sections and descriptionMd is SECTIONS_AND_DESCRIPTION_CONFLICT on both tools', async () => {
    const fx = await makeWorkItemFixture();
    const refusedCreate = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'task',
        title: 'x',
        type: 'code',
        sections: LEAF,
        descriptionMd: 'free',
      },
      fx.ctx,
    );
    expect(refusedCreate.isError).toBe(true);
    expect(JSON.stringify(refusedCreate.content)).toContain('SECTIONS_AND_DESCRIPTION_CONFLICT');
    expect(await adminDb.workItem.count()).toBe(0);

    const created = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Export', type: 'code', sections: LEAF },
      fx.ctx,
    );
    const key = (created.structuredContent as Structured).identifier;
    const refusedUpdate = await runUpdateWorkItem(
      { key, sections: { framing: 'f' }, descriptionMd: 'free' },
      fx.ctx,
    );
    expect(refusedUpdate.isError).toBe(true);
    expect(JSON.stringify(refusedUpdate.content)).toContain('SECTIONS_AND_DESCRIPTION_CONFLICT');
  });

  it('update merges sparsely, and refuses a clear that leaves a required section missing', async () => {
    const fx = await makeWorkItemFixture();
    const created = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Export', type: 'code', sections: LEAF },
      fx.ctx,
    );
    const key = (created.structuredContent as Structured).identifier;

    const merged = await runUpdateWorkItem(
      { key, sections: { scopeBoundary: 'Also the menu.' } },
      fx.ctx,
    );
    expect(merged.isError).toBeFalsy();
    expect((merged.structuredContent as Structured).descriptionMd).toBe(
      renderSections('task', 'code', { ...LEAF, scopeBoundary: 'Also the menu.' }),
    );

    const refused = await runUpdateWorkItem(
      { key, sections: { acceptanceCriteria: null } },
      fx.ctx,
    );
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain('INVALID_SECTIONS');
    expect(text).toContain('acceptanceCriteria');
  });
});

// Bug MOTIR-11161 — the refusal reaches the agent as the typed tool error.
describe("a `steps` section on a person's card through the MCP tools (MOTIR-11161)", () => {
  const STEPS = '- Run the suite.\n- Record the result.';

  it('create_work_item and update_work_item refuse it as INVALID_SECTIONS naming steps and todos', async () => {
    const fx = await makeWorkItemFixture();
    const refusedCreate = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'task',
        title: 'Ship it',
        type: 'deploy',
        executor: 'human',
        sections: { ...LEAF, steps: STEPS },
      },
      fx.ctx,
    );
    expect(refusedCreate.isError).toBe(true);
    const createText = JSON.stringify(refusedCreate.content);
    expect(createText).toContain('INVALID_SECTIONS');
    expect(createText).toContain('steps');
    expect(createText).toContain('todos');
    expect(await adminDb.workItem.count()).toBe(0);

    const created = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Do it', type: 'manual', sections: LEAF },
      fx.ctx,
    );
    expect(created.isError).toBeFalsy();
    const key = (created.structuredContent as Structured).identifier;
    const refusedUpdate = await runUpdateWorkItem({ key, sections: { steps: STEPS } }, fx.ctx);
    expect(refusedUpdate.isError).toBe(true);
    const updateText = JSON.stringify(refusedUpdate.content);
    expect(updateText).toContain('INVALID_SECTIONS');
    expect(updateText).toContain('todos');
  });

  it('create_work_item keeps `steps` on an agent-run deploy', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'task',
        title: 'Ship it',
        type: 'deploy',
        executor: 'coding_agent',
        sections: { ...LEAF, steps: STEPS },
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Structured).descriptionMd).toContain('## Steps');
  });
});
