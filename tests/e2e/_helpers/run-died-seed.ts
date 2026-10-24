import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { createTestPerson } from './testPerson';

// THE RUN-DIED E2E SEED (Story MOTIR-6526 · Subtask MOTIR-6536), for the acceptance
// receipt `regression-run-died-continue.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the two people, workspace, project, membership and cards — their services;
//   * each person's v1 token — `apiTokensService.create`, bound to the project with
//     `work_item:edit` (the permission the dispatch-run ingest ops and
//     `POST /api/v1/work-items/{key}/continue` declare);
//   * the RUNS — NOT seeded. The spec opens, heartbeats and annotates them through
//     the real `/api/v1/dispatch-runs` ingest ops (`agent-run-seed.ts`), exactly as
//     the CLI's reporter does; the one field it writes directly is the lapsed
//     `lastHeartbeatAt` (`lapseRun`), because five minutes of silence cannot be
//     waited for.
//
// ⚠️ The cards start `in_progress` and ASSIGNED to Ada — where a card sits once her
// run claimed it — so the takeover's re-assignment to Ben is observable.

export const RUN_DIED_PASSWORD = 'run-died-e2e-pass-6';

export interface DiedCard {
  id: string;
  identifier: string;
  title: string;
}

export interface DiedPerson {
  id: string;
  email: string;
  name: string;
  /** A project-bound v1 bearer token carrying `work_item:edit`. */
  token: string;
}

export interface RunDiedSeed {
  password: string;
  /** A — the person whose run dies, and who opens the card. */
  ada: DiedPerson;
  /** B — the person who continues it. */
  ben: DiedPerson;
  /** The happy path: a run that heartbeats, goes silent, and is continued. */
  main: DiedCard;
  /** A dead run that never pushed a branch. */
  noPush: DiedCard;
  /** A card at Implemented whose run died after opening its pull request. */
  implemented: DiedCard;
  /** A story run as one parent run, and its child whose leg died with it. */
  parent: DiedCard;
  child: DiedCard;
  /** Walked in Chinese. */
  zh: DiedCard;
}

export async function seedRunDied(slug: string): Promise<RunDiedSeed> {
  const adaEmail = `died-ada-${slug}@example.com`;
  const benEmail = `died-ben-${slug}@example.com`;
  const ada = await createTestPerson({
    email: adaEmail,
    password: RUN_DIED_PASSWORD,
    name: 'Ada Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Run died E2E',
    ownerUserId: ada.id,
  });
  const project = await projectsService.createProject({
    name: 'Billing',
    identifier: 'DIED',
    workspaceId: workspace.id,
    actorUserId: ada.id,
  });
  const ben = await createTestPerson({
    email: benEmail,
    password: RUN_DIED_PASSWORD,
    name: 'Ben Builder',
  });
  await workspacesService.addMember({ userId: ben.id, workspaceId: workspace.id });
  for (const userId of [ada.id, ben.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  const ctx = { userId: ada.id, workspaceId: workspace.id };
  const card = async (
    title: string,
    opts: { kind?: 'task' | 'story' | 'subtask'; parentId?: string; status?: string } = {},
  ): Promise<DiedCard> => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: opts.kind ?? 'task',
        title,
        ...(opts.parentId ? { parentId: opts.parentId } : {}),
      },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    if (opts.status) await workItemsService.updateStatus(item.id, opts.status, ctx);
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: ada.id } });
    return { id: item.id, identifier: item.identifier, title };
  };
  const main = await card('Export invoices as CSV');
  const noPush = await card('Send a receipt by email');
  const implemented = await card('Round totals to the cent', { status: 'implemented' });
  const parent = await card('Refunds', { kind: 'story' });
  const child = await card('Refund a single line', { kind: 'subtask', parentId: parent.id });
  const zh = await card('Show VAT on invoices');

  const mint = async (userId: string, label: string) =>
    (
      await apiTokensService.create(userId, workspace.id, {
        label,
        projectId: project.id,
        permissions: ['project:browse', 'work_item:edit'],
      })
    ).token;

  return {
    password: RUN_DIED_PASSWORD,
    ada: { id: ada.id, email: adaEmail, name: 'Ada Owner', token: await mint(ada.id, 'died-ada') },
    ben: {
      id: ben.id,
      email: benEmail,
      name: 'Ben Builder',
      token: await mint(ben.id, 'died-ben'),
    },
    main,
    noPush,
    implemented,
    parent,
    child,
    zh,
  };
}
