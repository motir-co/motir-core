import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { PERSONAL_DATA_SECTIONS, readSection } from '@/lib/export/personalDataSections';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The personal-data export carries the changes a person made to a repository's
// stored environment (Story MOTIR-9795). The table's policy keys on
// `app.workspace_id`, so the section is `tenant`-tier and is read through the
// SAME `withWorkspaceContext` transaction the export build opens, once per
// workspace. The fixture holds rows the bound view must exclude (another actor's,
// in the same workspace; the reader's own, in a workspace the read is not bound
// to), so a wrong tier or a wrong filter cannot pass as "you have none".

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SECTION = PERSONAL_DATA_SECTIONS.find((s) => s.table === 'environment_config_change')!;

async function repository(identifier: string) {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'app' },
    fx.ctx,
  );
  return { workspaceId: fx.workspaceId, projectRepositoryId: row.id };
}

describe('the environment_config_change export section', () => {
  it('is registered as a tenant-tier section', () => {
    expect(SECTION).toBeDefined();
    expect(SECTION.tier).toBe('tenant');
    expect(SECTION.redact).toBeUndefined();
  });

  it("exports the reader's own changes in the bound workspace, and only those", async () => {
    const reader = await createTestUser();
    const other = await createTestUser();
    const here = await repository('HER');
    const there = await repository('THR');
    const change = (r: { workspaceId: string; projectRepositoryId: string }, actorId: string) =>
      adminDb.environmentConfigChange.create({
        data: {
          ...r,
          environment: 'production',
          name: 'API_URL',
          action: 'added',
          isSecret: false,
          actorId,
        },
      });
    const mine = await change(here, reader.id);
    await change(here, other.id); // another actor, same workspace
    await change(there, reader.id); // the reader's, another workspace

    expect(await adminDb.environmentConfigChange.count()).toBe(3);

    const rows = (await withWorkspaceContext(
      { userId: reader.id, workspaceId: here.workspaceId },
      (tx) => readSection(SECTION, reader.id, tx),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: mine.id,
      projectRepositoryId: here.projectRepositoryId,
      actorId: reader.id,
      name: 'API_URL',
    });
  });
});
