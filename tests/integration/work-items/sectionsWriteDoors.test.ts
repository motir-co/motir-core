import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { renderSections } from '@/lib/workItems/sections/render';
import { parseSections } from '@/lib/workItems/sections/parse';
import {
  InvalidSectionsError,
  SectionsWithDescriptionError,
} from '@/lib/workItems/sections/errors';
import type { WorkItemSections } from '@/lib/workItems/sections/registry';
import { makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-9023 · MOTIR-9031 — the WORK-ITEM write service takes an optional
// `sections` input (against real Postgres). The rule lives in the service, so
// every door that threads the input gets it: these tests drive the service
// directly, and the door files (`tests/api/v1/work-item-sections-route.test.ts`,
// `tests/mcp/work-item-sections-tools.test.ts`) prove the transports map it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const LEAF: WorkItemSections = {
  framing: 'Add the export button to the toolbar.',
  scopeBoundary: 'Only the toolbar. The menu is left alone.',
  acceptanceCriteria: ['The button downloads a CSV.', 'The button is disabled while empty.'],
  contextRefs: [{ ref: 'components/Toolbar.tsx', why: 'where the button lives' }],
};

async function storedBody(id: string): Promise<string | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return row.descriptionMd;
}

async function count(): Promise<number> {
  return adminDb.workItem.count();
}

describe('createWorkItem with sections', () => {
  it('renders a complete set into the stored body, and nothing else is stored', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Export', type: 'code', sections: LEAF },
      fx.ctx,
    );
    expect(await storedBody(dto.id)).toBe(renderSections('task', 'code', LEAF));
  });

  it('refuses a missing acceptanceCriteria by name and creates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { acceptanceCriteria: _omitted, ...without } = LEAF;
    const err = await workItemsService
      .createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'x', type: 'code', sections: without },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).missing).toContain('acceptanceCriteria');
    expect((err as InvalidSectionsError).message).toContain('acceptanceCriteria');
    expect(await count()).toBe(0);
  });

  it('refuses an empty acceptanceCriteria list as missing', async () => {
    const fx = await makeWorkItemFixture();
    const err = await workItemsService
      .createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'x',
          type: 'code',
          sections: { ...LEAF, acceptanceCriteria: [] },
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).missing).toContain('acceptanceCriteria');
    expect(await count()).toBe(0);
  });

  it('refuses a section the kind does not define (an epic with acceptanceCriteria)', async () => {
    const fx = await makeWorkItemFixture();
    const err = await workItemsService
      .createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'epic',
          title: 'An epic',
          sections: {
            framing: 'f',
            scopeBoundary: 's',
            acceptanceCriteria: ['not for an epic'],
          },
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).unknown).toContain('acceptanceCriteria');
    expect(await count()).toBe(0);
  });

  it('refuses a decision task sent as an open question, naming its writing brief', async () => {
    const fx = await makeWorkItemFixture();
    const err = await workItemsService
      .createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Decide',
          type: 'decision',
          sections: {
            ...LEAF,
            question: 'Which one?',
            options: [{ label: 'The first', cost: 'none', forecloses: 'the second' }],
            recommendation: 'The first.',
          },
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).missing).toEqual([
      'decisionBrief',
      'alternatives',
      'whatChanged',
      'consumers',
      'supersedes',
      'resultingDirection',
    ]);
    expect(await count()).toBe(0);
  });

  it('refuses sections together with descriptionMd and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const err = await workItemsService
      .createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Both',
          type: 'code',
          descriptionMd: 'free text',
          sections: LEAF,
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SectionsWithDescriptionError);
    expect(await count()).toBe(0);
  });
});

describe('updateWorkItem with sections', () => {
  async function seedLeaf() {
    const fx = await makeWorkItemFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Export', type: 'code', sections: LEAF },
      fx.ctx,
    );
    return { fx, created };
  }

  it('a sparse patch keeps every other section and changes only the boundary', async () => {
    const { fx, created } = await seedLeaf();
    const before = parseSections((await storedBody(created.id)) ?? '', 'task', 'code').sections;
    await workItemsService.updateWorkItem(
      created.id,
      { sections: { scopeBoundary: 'Now also the menu.' } },
      fx.ctx,
    );
    const after = parseSections((await storedBody(created.id)) ?? '', 'task', 'code').sections;
    expect(after).toEqual({ ...before, scopeBoundary: 'Now also the menu.' });
  });

  it('refuses a patch that leaves a required section missing after the merge, body unchanged', async () => {
    const { fx, created } = await seedLeaf();
    const before = await storedBody(created.id);
    const err = await workItemsService
      .updateWorkItem(created.id, { sections: { acceptanceCriteria: null } }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).missing).toContain('acceptanceCriteria');
    expect(await storedBody(created.id)).toBe(before);
  });

  it('judges the merge on the type AFTER this write, and a refusal changes nothing', async () => {
    const { fx, created } = await seedLeaf();
    const before = await storedBody(created.id);
    const err = await workItemsService
      .updateWorkItem(
        created.id,
        { type: 'decision', sections: { framing: 'Now a decision.' } },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSectionsError);
    expect((err as InvalidSectionsError).missing).toContain('decisionBrief');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.type).toBe('code');
    expect(row.descriptionMd).toBe(before);
  });

  it('refuses sections together with descriptionMd and leaves the body unchanged', async () => {
    const { fx, created } = await seedLeaf();
    const before = await storedBody(created.id);
    const err = await workItemsService
      .updateWorkItem(created.id, { sections: { framing: 'f' }, descriptionMd: 'free' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SectionsWithDescriptionError);
    expect(await storedBody(created.id)).toBe(before);
  });

  it('a type change with no sections leaves descriptionMd byte-identical', async () => {
    const { fx, created } = await seedLeaf();
    const before = await storedBody(created.id);
    await workItemsService.updateWorkItem(created.id, { type: 'chore' }, fx.ctx);
    expect(await storedBody(created.id)).toBe(before);
  });
});

describe('a plain descriptionMd write is unchanged', () => {
  const BODIES = {
    headed: '## Acceptance criteria\n- one\n\n## Scope BOUNDARY\nnarrow\n',
    headingless: 'Just some prose with no headings at all.',
    gutter: '| ## Acceptance criteria\n| - hidden behind a pasted gutter\n',
  };

  for (const [name, body] of Object.entries(BODIES)) {
    it(`create stores the ${name} body as sent, with no refusal`, async () => {
      const fx = await makeWorkItemFixture();
      const dto = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: name, type: 'code', descriptionMd: body },
        fx.ctx,
      );
      expect(await storedBody(dto.id)).toBe(body);
    });

    it(`update stores the ${name} body as sent, with no refusal`, async () => {
      const fx = await makeWorkItemFixture();
      const dto = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: name, type: 'code' },
        fx.ctx,
      );
      await workItemsService.updateWorkItem(dto.id, { descriptionMd: body }, fx.ctx);
      expect(await storedBody(dto.id)).toBe(body);
    });
  }
});
