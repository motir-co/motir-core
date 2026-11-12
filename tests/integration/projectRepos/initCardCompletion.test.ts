import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  // The design-choice read never fails a run; with no motir-ai here it reads as
  // "no choice", which is what this suite wants.
  getPreplanState: vi.fn(async () => {
    throw new Error('no motir-ai in this suite');
  }),
}));

import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { repoProvisioningClient, type ProvisionedRepo } from '@/lib/github/repoProvisioning';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { fleetRunnerVariableService } from '@/lib/services/fleetRunnerVariableService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { productionEnablementService } from '@/lib/services/productionEnablementService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11054 — the COMPLETION half: an init card
// completes on its declared repository being ESTABLISHED by the establish pass,
// keyed on the row's state rather than on the pass's outcome.
//
// Real Postgres and the real establish pass, set service, workflow and status
// authority. Only the boundaries leave the process: the git host's creation call
// (`repoProvisioningClient.provisionRepository`), the paid-plan read, the hosted
// org assignment, and the quiet fleet/preview/production passes that talk to it.

let fx: WorkItemFixture;
let nextProviderId = 700_000;
let provision: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  fx = await makeWorkItemFixture();
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  vi.spyOn(fleetGithubOrgAssignmentService, 'ensureHostedGithubOrg').mockResolvedValue({
    outcome: 'unconfigured',
  } as never);
  vi.spyOn(fleetGithubOrgAssignmentService, 'readHostedGithubOrg').mockResolvedValue(null);
  vi.spyOn(projectRunnerGroupService, 'syncQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(fleetRunnerVariableService, 'ensureQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(previewEnablementService, 'enableQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(productionEnablementService, 'enableQuietly').mockResolvedValue(undefined as never);
  provision = vi.spyOn(repoProvisioningClient, 'provisionRepository').mockImplementation(
    async (input: { name: string }): Promise<ProvisionedRepo> =>
      ({
        installationId: '551100',
        providerRepoId: String(nextProviderId++),
        owner: 'motir-projects',
        name: input.name,
        defaultBranch: 'main',
        adopted: false,
        // Non-null: the "no commit beyond the template" arm, which enqueues no index.
        seedHeadSha: 'seed-head',
      }) as ProvisionedRepo,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function initCard(
  name: string | null,
  projectFx: WorkItemFixture = fx,
  status = 'in_progress',
): Promise<WorkItem> {
  const item = await createTestWorkItem(projectFx, { kind: 'task', title: `Create ${name}` });
  // `in_progress` by default: the run that creates the repository has claimed its
  // card. (A bare fixture row carries the column default, which no workflow edge
  // leaves.) `todo` is the card a plan's own establish run finds.
  return adminDb.workItem.update({
    where: { id: item.id },
    data: { subject: 'init', initRepositoryName: name, status },
  });
}

async function doneKey(projectId: string): Promise<string> {
  // The project's done-category status as the pass resolves it — by category,
  // preferring the `done` key over `cancelled`, which shares the category.
  const key = await workflowsService.resolveStatusKey(projectId, fx.workspaceId, {
    key: 'done',
    category: 'done',
  });
  expect(key).toBe('done');
  return key!;
}

async function stored(id: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return {
    status: row.status,
    projectId: row.projectId,
    initRepositoryName: row.initRepositoryName,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function addRow(name: string) {
  return projectRepoSetService.addRow(fx.projectId, { role: 'infra', name }, fx.ctx);
}

describe('workItemRepository.listOpenInitCardsByProject', () => {
  it('returns the project’s declared, non-archived init cards and only those', async () => {
    const declared = await initCard('acme-infra');
    await initCard(null); // the subject with no declaration
    const archived = await initCard('acme-old');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${Math.floor(Math.random() * 10_000)}`,
    });
    await initCard('acme-infra', {
      ...fx,
      projectId: other.id,
      projectIdentifier: other.identifier,
    } as WorkItemFixture);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.listOpenInitCardsByProject(fx.projectId, tx),
    );
    expect(rows).toEqual([
      { id: declared.id, status: declared.status, initRepositoryName: 'acme-infra' },
    ]);
  });
});

describe('establishSet completes the init card whose repository it establishes', () => {
  it('a row settled `created` completes the card declaring its name in another case, by category, as the caller', async () => {
    const card = await initCard('ACME-Infra');
    await addRow('acme-infra');
    const read = vi.spyOn(workflowsService, 'getWorkflow');
    const write = vi.spyOn(workItemsService, 'updateStatus');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    const done = await doneKey(fx.projectId);
    expect((await stored(card.id)).status).toBe(done);
    expect(read).toHaveBeenCalledWith(fx.projectId, fx.workspaceId);
    expect(write).toHaveBeenLastCalledWith(card.id, done, fx.ctx);
  });

  it('a card still at `todo` walks the workflow’s edges to done — never the illegal jump (MOTIR-10162)', async () => {
    const card = await initCard('acme-infra', fx, 'todo');
    await addRow('acme-infra');
    const write = vi.spyOn(workItemsService, 'updateStatus');
    const errors = vi.spyOn(console, 'error');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const done = await doneKey(fx.projectId);
    expect((await stored(card.id)).status).toBe(done);
    const steps = write.mock.calls.map(([, key]) => key);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.at(-1)).toBe(done);
    expect(steps).not.toContain('todo');
    expect(errors.mock.calls.some(([msg]) => String(msg).includes('init card'))).toBe(false);
  });

  it('a `created` row reported `already_settled` on a retry still completes a card left open', async () => {
    await addRow('acme-infra');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    // The card is laid AFTER the first run — the retry is what must complete it.
    const card = await initCard('acme-infra');

    const retry = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(retry.rows[0]).toMatchObject({ outcome: 'already_settled' });
    expect(retry.rows[0]!.row!.state).toBe('created');
    expect((await stored(card.id)).status).toBe(await doneKey(fx.projectId));
  });

  it('is idempotent: a second run leaves the done card byte-identical', async () => {
    const card = await initCard('acme-infra');
    await addRow('acme-infra');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const after = await stored(card.id);
    const write = vi.spyOn(workItemsService, 'updateStatus');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(await stored(card.id)).toEqual(after);
    expect(write).not.toHaveBeenCalled();
  });
  it('a cancelled init card stays cancelled when its repository is established later', async () => {
    const card = await initCard('acme-infra', fx, 'cancelled');
    await addRow('acme-infra');
    const before = await stored(card.id);
    const write = vi.spyOn(workItemsService, 'updateStatus');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(await stored(card.id)).toEqual(before);
    expect(before.status).toBe('cancelled');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('a row that is not established completes nothing — one state at a time', () => {
  async function expectUntouched(card: WorkItem, run: () => Promise<unknown>): Promise<void> {
    const before = await stored(card.id);
    const write = vi.spyOn(workItemsService, 'updateStatus');
    await run();
    expect(await stored(card.id)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  }

  it('`proposed` — a row this run was not asked about', async () => {
    const card = await initCard('acme-infra');
    await addRow('acme-infra');
    const other = await addRow('acme-other');
    provision.mockRejectedValue(new Error('the host refused'));
    await expectUntouched(card, async () => {
      const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx, {
        rowId: other.id,
      });
      expect(result.rows.find((r) => r.name === 'acme-infra')!.row!.state).toBe('proposed');
    });
  });

  it('`creating` — another run’s live claim', async () => {
    const card = await initCard('acme-infra');
    const row = await addRow('acme-infra');
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await expectUntouched(card, async () => {
      const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
      expect(result.rows[0]).toMatchObject({ outcome: 'not_attempted' });
    });
  });

  it('`skipped` — reported `already_settled`, and still credits nothing', async () => {
    const card = await initCard('acme-infra');
    const row = await addRow('acme-infra');
    await projectRepoSetService.skipRow(row.id, fx.ctx);
    await expectUntouched(card, async () => {
      const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
      expect(result.rows[0]).toMatchObject({ outcome: 'already_settled' });
      expect(result.rows[0]!.row!.state).toBe('skipped');
    });
  });

  it('`failed` — the creation failed, and the card stays open', async () => {
    const card = await initCard('acme-infra');
    await addRow('acme-infra');
    provision.mockRejectedValue(new Error('the host refused'));
    await expectUntouched(card, async () => {
      const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
      expect(result.rows[0]).toMatchObject({ outcome: 'failed' });
      expect(result.rows[0]!.row!.state).toBe('failed');
    });
  });
});

describe('the match is keyed on the project as well as the name', () => {
  it('another project’s established row of the same name completes nothing here, and a declaration matching no row stays open', async () => {
    const mine = await initCard('acme-infra');
    const unmatched = await initCard('acme-nowhere');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${Math.floor(Math.random() * 10_000)}`,
    });
    await projectRepoSetService.addRow(other.id, { role: 'infra', name: 'acme-infra' }, fx.ctx);
    const beforeMine = await stored(mine.id);

    await projectRepoProvisioningService.establishSet(other.id, fx.ctx);

    expect(await stored(mine.id)).toEqual(beforeMine);
    // And in its own project, a declaration with no matching row is left alone.
    await addRow('acme-infra');
    const beforeUnmatched = await stored(unmatched.id);
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(await stored(unmatched.id)).toEqual(beforeUnmatched);
    expect((await stored(mine.id)).status).toBe(await doneKey(fx.projectId));
  });
});

describe('the completion can never fail the establish run', () => {
  it('with the status write throwing, the result is unchanged and the failure is logged with the row id', async () => {
    const card = await initCard('acme-infra');
    const row = await addRow('acme-infra');
    vi.spyOn(workItemsService, 'updateStatus').mockRejectedValue(new Error('write exploded'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rowId: row.id, outcome: 'created' });
    expect(result.rows[0]!.row!.state).toBe('created');
    expect(
      errors.mock.calls.some(
        ([msg]) => String(msg).includes(row.id) && String(msg).includes(card.id),
      ),
    ).toBe(true);
  });

  it('a failing read of the init cards is logged with the row ids and swallowed', async () => {
    const row = await addRow('acme-infra');
    vi.spyOn(workItemRepository, 'listOpenInitCardsByProject').mockRejectedValue(
      new Error('read exploded'),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(errors.mock.calls.some(([msg]) => String(msg).includes(row.id))).toBe(true);
  });

  it('a workflow with no road to a done-category status leaves its init cards open and says so', async () => {
    const card = await initCard('acme-infra');
    await addRow('acme-infra');
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    vi.spyOn(workflowsService, 'getWorkflow').mockResolvedValue({
      ...wf,
      statuses: wf.statuses.filter((st) => st.category !== 'done'),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await stored(card.id);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(await stored(card.id)).toEqual(before);
    expect(errors.mock.calls.some(([msg]) => String(msg).includes('no path to done'))).toBe(true);
  });
});
