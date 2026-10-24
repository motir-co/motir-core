import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// THE DESIGN-VERDICT seed (Story MOTIR-6070 · Subtask MOTIR-6429), for the receipt
// `regression-design-verdict.spec.ts` records.
//
// One story holding THREE design cards and the TWO cards that wait on the designs:
//
//   · design A and design B — claimed (`in_progress`) and assigned to the reviewer, so
//     the gate a publish raises routes to them. NEITHER GATE IS SEEDED: the spec
//     publishes both results through the real `publish_design_result` tool, which is
//     what raises the `awaiting` gate and moves the card to In Review (MOTIR-6009) —
//     `design-approval-seed.ts` records why a seeded gate would be a row the product
//     never made.
//   · two code cards `blocked_by` BOTH designs — what lets each publish through at all
//     (a design result is published only when work waits on it), and the two keys a
//     design Re-plan names in its first turn (MOTIR-6424's `waitingKeys`).
//   · design C — nothing published and nothing waiting: the empty state, which offers
//     no Request changes because there is no result to send back.
//
// ⚠️ THE REVIEWER IS A PLAIN PROJECT MEMBER, not the owner: the verbs must come from the
// ASSIGNEE arm of `canDecide`, and `work_item:edit` (which a member holds) is what the
// Re-plan door asks of its reader (`canReplan`).
//
// ⚠️ Titles are deliberately NOT substrings of one another: `getByRole` matches an
// accessible name by substring, and an overlap dies on strict mode instead of on anything
// this story is about.

export const DESIGN_VERDICT_PASSWORD = 'design-verdict-e2e-pass-4';

export const VERDICT_TITLES = {
  story: 'Let a customer export their reports',
  revise: 'Draw the export history empty state',
  replan: 'Lay out the export list and its filters',
  empty: 'Sketch the export settings drawer',
  first: 'Build the export list endpoint',
  second: 'Wire the list filters to the query',
} as const;

export interface DesignVerdictSeed {
  storyKey: string;
  /** Sent back with Revise. */
  reviseKey: string;
  /** Sent back with Re-plan. */
  replanKey: string;
  /** Never published. */
  emptyKey: string;
  /** The two cards `blocked_by` both designs, in creation order. */
  waitingKeys: [string, string];
  reviewerEmail: string;
  password: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT` — a dispatched run's own grant. */
  token: string;
}

export async function seedDesignVerdict(slug: string): Promise<DesignVerdictSeed> {
  const owner = await createTestPerson({
    email: `dv-owner-${slug}@example.com`,
    password: DESIGN_VERDICT_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Design Verdict E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Report Exports',
    identifier: 'EXP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  const reviewerEmail = `dv-reviewer-${slug}@example.com`;
  const reviewer = await createTestPerson({
    email: reviewerEmail,
    password: DESIGN_VERDICT_PASSWORD,
    name: 'Robin Vale',
  });
  await workspacesService.addMember({ userId: reviewer.id, workspaceId: workspace.id });
  await adminDb.projectMembership.create({
    data: { userId: reviewer.id, projectId: project.id, workspaceId: workspace.id },
  });
  for (const userId of [reviewer.id, owner.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: VERDICT_TITLES.story },
    ctx,
  );
  const subtask = (title: string, type: 'design' | 'code') =>
    workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'subtask',
        title,
        parentId: story.id,
        type,
        assigneeId: reviewer.id,
      },
      ctx,
    );

  const revise = await subtask(VERDICT_TITLES.revise, 'design');
  const replan = await subtask(VERDICT_TITLES.replan, 'design');
  const empty = await subtask(VERDICT_TITLES.empty, 'design');
  const first = await subtask(VERDICT_TITLES.first, 'code');
  const second = await subtask(VERDICT_TITLES.second, 'code');

  for (const waiting of [first, second]) {
    for (const design of [revise, replan]) {
      await workItemsService.linkWorkItems(
        { fromId: waiting.id, toId: design.id, kind: 'is_blocked_by' },
        ctx,
      );
    }
  }

  // Where an agent leaves a design card before it publishes (see `design-approval-seed.ts`).
  // `updateStatus`, the public entry point, so the funnel runs inside the workspace context.
  await workItemsService.updateStatus(revise.id, 'in_progress', ctx);
  await workItemsService.updateStatus(replan.id, 'in_progress', ctx);

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'design-verdict-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    storyKey: story.identifier,
    reviseKey: revise.identifier,
    replanKey: replan.identifier,
    emptyKey: empty.identifier,
    waitingKeys: [first.identifier, second.identifier],
    reviewerEmail,
    password: DESIGN_VERDICT_PASSWORD,
    token: minted.token,
  };
}
