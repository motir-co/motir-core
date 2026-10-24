import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { createTestPerson } from './testPerson';

// THE RUN-OVERLAY E2E SEED (Story MOTIR-8982 · Subtask MOTIR-9076), for the
// acceptance receipt `regression-runs-overlay.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the person, workspace, project, membership and cards — their services;
//   * the person's v1 token — `apiTokensService.create`, bound to the project with
//     `work_item:edit` (the permission the dispatch-run ingest ops declare);
//   * the RUNS — NOT seeded. The spec opens and annotates them through the real
//     `/api/v1/dispatch-runs` ingest ops (`agent-run-seed.ts`), exactly as the
//     CLI's reporter does, so no dispatch row is written here.

export const RUN_OVERLAY_PASSWORD = 'run-overlay-e2e-pass-9';

export interface OverlayCard {
  id: string;
  identifier: string;
  title: string;
}

export interface RunOverlaySeed {
  email: string;
  password: string;
  /** A project-bound v1 bearer token carrying `work_item:edit`. */
  token: string;
  projectKey: string;
  /** The batch run's three members, in the order the run takes them. */
  cards: [OverlayCard, OverlayCard, OverlayCard];
}

export async function seedRunOverlay(slug: string): Promise<RunOverlaySeed> {
  const email = `run-overlay-${slug}@example.com`;
  const owner = await createTestPerson({
    email,
    password: RUN_OVERLAY_PASSWORD,
    name: 'Ada Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Run overlay E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Billing',
    identifier: 'OVL',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const card = async (title: string): Promise<OverlayCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
    return { id: item.id, identifier: item.identifier, title };
  };
  const cards: RunOverlaySeed['cards'] = [
    await card('Export invoices as CSV'),
    await card('Send a receipt by email'),
    await card('Round totals to the cent'),
  ];

  const { token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'run-overlay',
    projectId: project.id,
    permissions: ['project:browse', 'work_item:edit'],
  });

  return {
    email,
    password: RUN_OVERLAY_PASSWORD,
    token,
    projectKey: project.identifier,
    cards,
  };
}
