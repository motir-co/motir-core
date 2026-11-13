// Plan-progress E2E seed (Story MOTIR-7820 · Subtask MOTIR-7835).
//
// One tenant the whole plan-progress walk runs in:
//   · a READER — the person who asks for plans and follows them from the
//     Workbench › Planning tab;
//   · a TEAMMATE in the same workspace and project, whose own `generating` plan
//     must stay off the reader's tab (case 13);
//   · a project whose story holds ONE committed, still-open TASK — the card one
//     level down that an `add` lands under (case 5's off-level drafting cue) and
//     the card a `lay` step names on the viewed level (case 6);
//   · a project-scoped API token carrying `work_item:edit` + `ai:view_plan`, so an
//     MCP client can create, append, deepen, withdraw and `report_plan_step`
//     through the real `/api/mcp` transport (`agentSession`).
//
// ⚠️ THE STORY'S ONLY CHILD IS OPEN, on purpose. A container's status is DERIVED
// from its children, and a finished story offers no *Plan with AI* at all
// (`planEntranceFace` rule 1) — the receipt opens its hosted plan from this card.
//
// Everything rides the SHIPPED services — the one sanctioned cross-layer reach
// for E2E setup — exactly as `live-drawing-seed.ts`. Every direct row write is on
// `adminDb`: a seed through `@/lib/db` is refused under `motir_app` without
// raising (`tests/rls/test-singleton-statement-guard.test.ts`).

import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestPerson } from './testPerson';
import { projectAccessData } from '@/tests/helpers/projectAccess';

export const PLAN_PROGRESS_PASSWORD = 'plan-progress-e2e-pass-7';

export interface PlanProgressPerson {
  email: string;
  userId: string;
  ctx: ServiceContext;
}

export interface PlanProgressSeed {
  reader: PlanProgressPerson;
  teammate: PlanProgressPerson;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  /** The story every hosted plan in the walk is anchored on. */
  storyId: string;
  storyKey: string;
  storyTitle: string;
  /** The story's committed, still-open task — one level down from the story's
   *  level, and a card ON that level. */
  taskId: string;
  taskKey: string;
  taskTitle: string;
  /** The READER's bearer: `work_item:edit` + `ai:view_plan`, bound to the project. */
  token: string;
}

export async function seedPlanProgress(slug: string): Promise<PlanProgressSeed> {
  const readerPerson = await createTestPerson({
    email: `plan-progress-reader-${slug}@example.com`,
    password: PLAN_PROGRESS_PASSWORD,
    name: 'Noor Reader',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plan Progress E2E',
    ownerUserId: readerPerson.id,
  });
  const projectName = 'Planner progress';
  const project = await projectsService.createProject({
    name: projectName,
    identifier: 'PROG',
    workspaceId: workspace.id,
    actorUserId: readerPerson.id,
  });

  // The teammate — a plain workspace member. `addMember` enrols them in the
  // workspace's projects, so they can see (and plan in) this one.
  const teammatePerson = await createTestPerson({
    email: `plan-progress-teammate-${slug}@example.com`,
    password: PLAN_PROGRESS_PASSWORD,
    name: 'Ola Teammate',
  });
  await workspacesService.addMember({ userId: teammatePerson.id, workspaceId: workspace.id });

  // The Workbench, `/plans` and the planning surface are ACTIVE-PROJECT scoped.
  for (const userId of [readerPerson.id, teammatePerson.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  const ctx: ServiceContext = { userId: readerPerson.id, workspaceId: workspace.id };
  const epic = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'epic', title: 'AI planning' },
    ctx,
  );
  const storyTitle = 'Follow a plan while it is written';
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: storyTitle, parentId: epic.id },
    ctx,
  );
  const taskTitle = 'Record the progress receipt';
  const task = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: taskTitle, parentId: story.id },
    ctx,
  );

  const minted = await apiTokensService.create(readerPerson.id, workspace.id, {
    label: 'plan-progress-e2e',
    projectId: project.id,
    permissions: ['work_item:edit', 'ai:view_plan'],
  });

  // Past onboarding, so *Plan with AI* opens the planning surface itself.
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });

  return {
    reader: { email: readerPerson.email, userId: readerPerson.id, ctx },
    teammate: {
      email: teammatePerson.email,
      userId: teammatePerson.id,
      ctx: { userId: teammatePerson.id, workspaceId: workspace.id },
    },
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    projectName,
    storyId: story.id,
    storyKey: story.identifier,
    storyTitle,
    taskId: task.id,
    taskKey: task.identifier,
    taskTitle,
    token: minted.token,
  };
}

/**
 * Backdate a plan past the stalled threshold, as the server's own clock would
 * see it after `byMs` of silence: its `last_activity_at`, every one of its step
 * rows' `started_at`, and its proposals' writes (`plan_item.created_at`,
 * `plan_revision.changed_at`). All of them, because the derivation reads all of
 * them — the plan's activity for STALLED, each step's start and its target's
 * last write for the QUIET drop (MOTIR-11184).
 */
export async function backdatePlanActivity(planId: string, byMs: number): Promise<Date> {
  const at = new Date(Date.now() - byMs);
  await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: at } });
  await adminDb.planStep.updateMany({ where: { planId }, data: { startedAt: at } });
  await adminDb.planItem.updateMany({ where: { planId }, data: { createdAt: at } });
  await adminDb.planRevision.updateMany({ where: { planId }, data: { changedAt: at } });
  return at;
}

/**
 * Touch a plan the way any planner write does, and change nothing a reader sees
 * move (Story MOTIR-8542). A plan pane reads on a PUSH, never on a timer, so a
 * spec that needs "the next read" while the planner is quiet must cause one:
 * this bumps the plan's `lastActivityAt` to now, which fires the plan's live
 * signal and, through the stream, exactly one read. Arm the response wait first.
 */
export async function nudgePlan(planId: string): Promise<void> {
  await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: new Date() } });
}

/**
 * Make the seed's project PUBLIC and seed an OUTSIDER to read it as a Visitor
 * (Story MOTIR-8060 · MOTIR-8068). The outsider belongs to an organisation of
 * their own — the reader `seedVisitorProject` describes — and has no membership
 * in the seed's workspace and no visitor record yet, so their first visit meets
 * the consent screen. `seedVisitorProject` builds its own project; this one is
 * the plan-progress project, where both planners' plans already live.
 */
export async function makePlanProgressPublic(
  seed: PlanProgressSeed,
  slug: string,
): Promise<{ email: string }> {
  await adminDb.project.update({
    where: { id: seed.projectId },
    data: projectAccessData('public'),
  });
  const outsider = await createTestPerson({
    email: `plan-progress-outsider-${slug}@example.com`,
    password: PLAN_PROGRESS_PASSWORD,
    name: 'Olive Outsider',
  });
  const own = await workspacesService.createWorkspace({
    name: 'Olive Studio',
    ownerUserId: outsider.id,
  });
  const ownProject = await projectsService.createProject({
    workspaceId: own.workspace.id,
    actorUserId: outsider.id,
    name: 'Sketches',
    identifier: 'SKT',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: outsider.id, workspaceId: own.workspace.id } },
    data: { activeProjectId: ownProject.id },
  });
  return { email: outsider.email };
}

/**
 * A second story beside the seed's own, under the same epic (Story MOTIR-8060 ·
 * MOTIR-8068). A hosted plan asked from the seed's story LEASES that story for
 * its session, so a plan.py plan running at the same time proposes under a
 * card nobody holds — this one — rather than being refused `PLAN_TARGET_LOCKED`.
 */
export async function addPlanProgressStory(
  seed: PlanProgressSeed,
  title: string,
): Promise<{ id: string; key: string }> {
  const story = await adminDb.workItem.findUniqueOrThrow({
    where: { id: seed.storyId },
    select: { parentId: true },
  });
  const created = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title, parentId: story.parentId ?? undefined },
    seed.reader.ctx,
  );
  return { id: created.id, key: created.identifier };
}
