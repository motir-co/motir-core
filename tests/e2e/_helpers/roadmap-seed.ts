// Roadmap E2E seed (Subtask 7.20.8 / MOTIR-1015).
//
// The project Roadmap view (Story 7.20 · MOTIR-1011) is ACTIVE-PROJECT scoped —
// `/roadmap` resolves `getActiveProject()` — so each fixture mints its own tenant
// (a sign-in-able owner + workspace + project, the project PINNED active) and
// seeds the tree entirely through the SHIPPED services (the one sanctioned
// cross-layer reach for E2E setup, exactly as `plans-review-seed.ts` /
// `backlog-seed.ts` do). No raw inserts: every node rides
// `workItemsService.createWorkItem`, and every status rides
// `workItemsService.updateStatus` along the LEGAL workflow path (todo →
// in_progress → in_review → done — there is no direct todo→done edge).
//
// The populated tree is shaped to exercise the roadmap markers (MOTIR-1013):
//   • Epic "Platform foundation" is IN PROGRESS → it is the root level's
//     in-progress frontier, so the canvas marks it "you are here".
//   • It has two child stories (one DONE, one IN PROGRESS) → it is drillable AND
//     renders a subtree progress meter; drilling it reveals those children.
//   • A second epic "Growth experiments" gives the road a sibling at root, so
//     "drill in then back" is observable (the sibling is hidden while drilled,
//     visible again at root).
//
// ⚠️ A PARENT'S STATUS IS DERIVED, NOT SET (Story MOTIR-2888). Until the
// recompute shipped, these fixtures made an epic in-progress by calling
// `updateStatus` on the EPIC and then hanging `todo` children off it. That state
// is no longer reachable: a parent's status is a function of its children, so
// the recompute pulls such an epic straight back to `todo` (rung 4 — open work,
// none of it started) and the "you are here" frontier vanishes. The fixtures
// therefore create the state the way the product does — **start a CHILD** — and
// then WAIT for the derived value, because derivation is asynchronous and the
// seed must not hand the browser a tree that is still settling.

import { db } from '@/lib/db';
// This file's OWN new seeding goes through `adminDb`, not the request-scoped
// singleton: `tests/rls/test-singleton-statement-guard.test.ts` ratchets the
// `tests/e2e/**` population downward, and its remedy is a seeding helper on the
// admin client (MOTIR-2941). The `db.` statements above it are the pre-existing
// baseline, converted by that ratchet's own card, not this one.
import { adminDb } from '@/tests/helpers/adminDb';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { FOLDER_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { waitForDerivedStatus } from './derivedStatus';

// Satisfies the credential-strength rule (same shape as the other seeds').
export const ROADMAP_SEED_PASSWORD = 'roadmap-view-e2e-pass-7';

export interface RoadmapSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** The in-progress epic — the "you are here" frontier; drill target. */
  activeEpicTitle: string;
  /** The other root epic — visible at root, hidden while drilled into the active epic. */
  otherEpicTitle: string;
  /** The active epic's two children (revealed on drill). */
  doneChildTitle: string;
  todoChildTitle: string;
}

async function makeTenant(
  email: string,
  workspaceName: string,
  projectName: string,
  identifier: string,
): Promise<{ ctx: ServiceContext; projectId: string; projectKey: string }> {
  const owner = await usersService.createUser({
    email,
    password: ROADMAP_SEED_PASSWORD,
    name: 'Roadmap Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: projectName,
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active for the owner so the active-project-scoped /roadmap
  // route resolves it on sign-in (the same pin plans-review-seed does for /plans).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

// Walk an item all the way to Done along the only legal path (the default
// workflow has no direct todo→done edge — see `_shared.md` / defaultWorkflow).
async function moveToDone(id: string, ctx: ServiceContext): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', ctx);
  await workItemsService.updateStatus(id, 'in_review', ctx);
  await workItemsService.updateStatus(id, 'done', ctx);
}

/** The main fixture: a populated roadmap with an in-progress (drillable) epic
 *  carrying the "you are here" marker + a progress meter, and a sibling epic.
 *
 *  `onboarded` (default true) stamps the immutable onboarding-ran marker
 *  (Subtask 7.4 / MOTIR-1264) so the roadmap shows the planning-origin cluster —
 *  the project's tree "came from" an approved plan. Pass `false` for a
 *  never-onboarded project (an existing tree with no materialized plan, like a
 *  db:seed tenant): same tree, but the marker is null so BOTH onboarding gates
 *  flip — `/onboarding` renders instead of redirecting, and the roadmap omits the
 *  planning-origin cluster. */
export async function seedRoadmap(
  email: string,
  opts: { onboarded?: boolean } = {},
): Promise<RoadmapSeed> {
  const { onboarded = true } = opts;
  const { ctx, projectId, projectKey } = await makeTenant(email, 'Roadmap E2E', 'Roadmap', 'ROAD');

  // The active epic — created first so it is the root level's first item. Its
  // in-progress status is DERIVED from the children below, not set on the epic:
  // see the header note.
  const activeEpicTitle = 'Platform foundation';
  const activeEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: activeEpicTitle },
    ctx,
  );

  // Two children → the epic is drillable and shows a subtree progress meter
  // (one done, one still open = a partial bar).
  const doneChildTitle = 'Authentication';
  const doneChild = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: doneChildTitle, parentId: activeEpic.id },
    ctx,
  );
  await moveToDone(doneChild.id, ctx);
  // ⚠️ SETTLE THE EPIC BEFORE TOUCHING ITS CHILD SET AGAIN (MOTIR-3915). Shipping
  // the only child completes the epic, and that is an ASYNC recompute. Adding the
  // second child while it is still in flight lets the late job stamp the epic
  // AFTER the newer child edit — at which point every recompute that would bring
  // it back to `in_progress` declines as `stale_backward` (MOTIR-2965) and the
  // epic stays `done` for good. The wait below then times out at 30s having
  // watched a value that was never going to change. Waiting HERE is what makes
  // the ordering deterministic; see `derivedStatus.ts` for the full mechanism.
  await waitForDerivedStatus(activeEpic.id, 'done');

  // STARTED, not left at to-do: this is what makes the epic in-progress, and so
  // the root level's "you are here" frontier. Leaving it `todo` would put the
  // epic on rung 4 (open work, none started) and there would be no frontier.
  const todoChildTitle = 'Billing';
  const openChild = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: todoChildTitle, parentId: activeEpic.id },
    ctx,
  );
  await workItemsService.updateStatus(openChild.id, 'in_progress', ctx);
  await waitForDerivedStatus(activeEpic.id, 'in_progress');

  // A second root epic (with a child so it is itself drillable) — the sibling
  // that disappears while drilled and returns on "Back".
  const otherEpicTitle = 'Growth experiments';
  const otherEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: otherEpicTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Referrals', parentId: otherEpic.id },
    ctx,
  );

  // Stamp (or leave null) the immutable onboarding-ran marker — the single
  // source of truth both onboarding gates read (Subtask 7.4 / MOTIR-1264). An
  // onboarded project shows the planning-origin cluster + redirects away from
  // /onboarding; a never-onboarded one omits the cluster + still enters
  // onboarding. Raw db write, matching this seed's membership-pin approach.
  if (onboarded) {
    await db.project.update({ where: { id: projectId }, data: { onboardingRanAt: new Date() } });
  }

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectKey,
    activeEpicTitle,
    otherEpicTitle,
    doneChildTitle,
    todoChildTitle,
  };
}

/** A tenant with a project but ZERO work items — for the empty-state branch. */
export async function seedEmptyRoadmapProject(
  email: string,
): Promise<{ email: string; password: string }> {
  await makeTenant(email, 'Roadmap E2E — empty', 'No Roadmap Yet', 'EMPT');
  return { email, password: ROADMAP_SEED_PASSWORD };
}

export interface LocateRoadmapSeed {
  email: string;
  password: string;
  projectKey: string;
  /** The in-progress epic at ROOT — the "you are here" frontier (locate's priority). */
  frontierTitle: string;
  /** A to-do (ready) epic at ROOT, drillable — the drill target for the cycling case. */
  readyEpicTitle: string;
  /** The ready epic's three to-do children, in cycle order (key-asc = creation order). */
  readyChildTitles: [string, string, string];
}

/**
 * The LOCATE fixture (MOTIR-1421): a roadmap shaped to exercise BOTH locate paths.
 *   - ROOT level: an IN-PROGRESS epic (the "you are here" frontier) + a TO-DO epic.
 *     So locate at root proves the frontier-FIRST priority (the frontier wins over
 *     the ready epic).
 *   - Drilling the to-do epic reveals THREE to-do children — all ready, none in
 *     progress, so there is NO frontier at that level → locate CYCLES them (and
 *     wraps), exercising the multi-ready path + the "n of m" hint.
 *
 * New items start at `todo` (a startable, category-`todo` status), so a freshly
 * created item with no blockers is READY — the seed relies on that (the same default
 * the other roadmap seeds lean on for their to-do nodes).
 */
export async function seedLocateRoadmap(email: string): Promise<LocateRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — locate',
    'Locate Roadmap',
    'LOCT',
  );

  // The in-progress epic — created first so it is the root's first item. Its one
  // child makes it drillable AND, once STARTED, makes the epic in-progress: the
  // status is derived from the child, never set on the epic (see the header
  // note). A `todo` child would leave the epic on rung 4 and there would be no
  // frontier for Locate to centre on — which is precisely what this spec asserts.
  const frontierTitle = 'Active stream';
  const frontier = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: frontierTitle },
    ctx,
  );
  const frontierChild = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Active stream — build', parentId: frontier.id },
    ctx,
  );
  await workItemsService.updateStatus(frontierChild.id, 'in_progress', ctx);
  await waitForDerivedStatus(frontier.id, 'in_progress');

  // The to-do (ready) epic + three to-do children → the cycling case on drill.
  const readyEpicTitle = 'Up next';
  const readyEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: readyEpicTitle },
    ctx,
  );
  const readyChildTitles: [string, string, string] = [
    'Up next — first',
    'Up next — second',
    'Up next — third',
  ];
  for (const title of readyChildTitles) {
    await workItemsService.createWorkItem(
      { projectId, kind: 'story', title, parentId: readyEpic.id },
      ctx,
    );
  }

  await db.project.update({ where: { id: projectId }, data: { onboardingRanAt: new Date() } });

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    projectKey,
    frontierTitle,
    readyEpicTitle,
    readyChildTitles,
  };
}

export interface DoneReadyRoadmapSeed {
  email: string;
  password: string;
  projectKey: string;
  /** An IN-PROGRESS epic — the "you are here" frontier (accent state). */
  hereTitle: string;
  /** A DONE epic — the faded/recessed done state. */
  doneTitle: string;
  /** A to-do, fully-unblocked epic — the ready (mint-wash) state. */
  readyTitle: string;
}

/**
 * The DONE + READY style fixture (MOTIR-1422): one ROOT level carrying THREE
 * distinct node states side by side — an in-progress epic (the "you are here"
 * frontier), a DONE epic, and a to-do/unblocked epic (READY) — so the E2E can
 * assert each renders its own card state (`data-node-state`) and that done ≠ ready.
 * New items start at `todo` (startable + unblocked → ready); `moveToDone` walks the
 * legal path to a done status.
 */
export async function seedDoneReadyRoadmap(email: string): Promise<DoneReadyRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — done/ready',
    'Done Ready Roadmap',
    'DRDY',
  );

  // The in-progress frontier (first item → "you are here").
  const hereTitle = 'In flight';
  const here = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: hereTitle },
    ctx,
  );
  await workItemsService.updateStatus(here.id, 'in_progress', ctx);

  // A DONE epic.
  const doneTitle = 'Shipped';
  const done = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: doneTitle },
    ctx,
  );
  await moveToDone(done.id, ctx);

  // A to-do, fully-unblocked epic WITH a child → READY. It needs the child: a
  // childless To Do epic is To plan, not Ready (MOTIR-10861).
  const readyTitle = 'Up next';
  const ready = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: readyTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'First slice', parentId: ready.id },
    ctx,
  );

  await db.project.update({ where: { id: projectId }, data: { onboardingRanAt: new Date() } });

  return { email, password: ROADMAP_SEED_PASSWORD, projectKey, hereTitle, doneTitle, readyTitle };
}

export interface SingleStorySprintRoadmapSeed {
  email: string;
  password: string;
  /** For the `workspace_id` cookie pin (a `getWorkspaceContext`-gated read resolves
   *  from the COOKIE, not the active project — see the E2E discipline). */
  workspaceId: string;
  projectKey: string;
  sprintName: string;
  /** The ONE member story — the sprint scope's single top-in-sprint root. */
  storyTitle: string;
  /** Its `MOTIR-<n>`-style key, for the `identifier · title` crumb assertion. */
  storyIdentifier: string;
  /** The story's three in-sprint subtasks — the level the canvas must land ON. */
  subtaskTitles: [string, string, string];
  /** The story's parent epic — elided in sprint scope, a root in project scope. */
  epicTitle: string;
  /** A second root epic — what makes PROJECT scope multi-root (so it never descends). */
  otherEpicTitle: string;
}

/**
 * The SINGLE-STORY-SUBTREE sprint fixture (MOTIR-1809 / Story MOTIR-1803): the
 * degenerate shape the auto-drill exists for. The active sprint commits to ONE
 * story plus its three subtasks, so the top-in-sprint predicate (MOTIR-1381 —
 * members whose parent chain holds no other member) resolves the sprint root to a
 * SINGLE drillable node, and the whole sprint would otherwise hide one drill
 * behind it. This is the exact shape of this project's own *Journey D · The Motir
 * CLI* sprint (14 of 15 items under MOTIR-809), quoted in the story.
 *
 * Project scope is deliberately MULTI-root (two epics), so the same fixture also
 * proves the negative half of step 4: switching back to Whole project renders the
 * multi-root level with no descend.
 *
 * The project is ONBOARDED (MOTIR-1824), so its root levels also carry the pinned
 * planning-origin cluster — the shape the descent originally never fired on.
 */
export async function seedSingleStorySprintRoadmap(
  email: string,
): Promise<SingleStorySprintRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — single-story sprint',
    'Auto Drill Roadmap',
    'DRIL',
  );

  const sprintName = 'Sprint 7 · Terminal dispatch';
  const sprint = await db.sprint.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      name: sprintName,
      goal: 'Ship the terminal dispatch loop.',
      state: 'active',
      sequence: 7,
    },
  });

  // The epic above the member story — NOT a member, so sprint scope elides it and
  // the story becomes the topmost in-sprint item. Its own status is left DERIVED
  // (MOTIR-2888): this fixture never asserts it, and an explicit `in_progress`
  // set here would be silently recomputed away the moment the children below are
  // created — a fixture that reaches its intended state only via a background
  // job it does not wait for.
  const epicTitle = 'Platform foundation';
  const epic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: epicTitle },
    ctx,
  );

  // THE member story — the sprint's single top-in-sprint root.
  const storyTitle = 'Terminal dispatch of the work loop';
  const story = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: storyTitle, parentId: epic.id },
    ctx,
  );
  await db.workItem.update({ where: { id: story.id }, data: { sprintId: sprint.id } });

  // Its three subtasks, all in the sprint — members whose parent chain holds the
  // member story, so they are NOT roots; they are the level the canvas lands on.
  const subtaskTitles: [string, string, string] = [
    'Scaffold the CLI package',
    'Wire the dispatch command',
    'Publish the release tag',
  ];
  for (const title of subtaskTitles) {
    const subtask = await workItemsService.createWorkItem(
      { projectId, kind: 'subtask', title, parentId: story.id },
      ctx,
    );
    await db.workItem.update({ where: { id: subtask.id }, data: { sprintId: sprint.id } });
  }

  // A second root epic → PROJECT scope is multi-root, so it never auto-descends.
  const otherEpicTitle = 'Growth experiments';
  const otherEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: otherEpicTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Referral loops', parentId: otherEpic.id },
    ctx,
  );

  // ONBOARDED (MOTIR-1824) — and that is now the POINT, not a caveat. The
  // planning-origin cluster is pinned at the root level of a project that
  // onboarded (`includeOrigin: parentId === null && showPlanningOrigin` in
  // `WorkItemRoadmap`), and it is a NODE. While the auto-descend counted the
  // level's whole node array, that extra node made this sprint's root two nodes
  // and the descent never fired here — so this fixture had to seed a
  // never-onboarded project to exercise the feature at all, which meant the
  // browser proof covered only the projects the bug did not affect. The descent
  // now counts the level's WORK (the cluster is `decorative`), so the harder,
  // more common shape is what the acceptance run drives.
  await db.project.update({ where: { id: projectId }, data: { onboardingRanAt: new Date() } });

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    workspaceId: ctx.workspaceId,
    projectKey,
    sprintName,
    storyTitle,
    storyIdentifier: story.identifier,
    subtaskTitles,
    epicTitle,
    otherEpicTitle,
  };
}

export interface SprintRoadmapSeed {
  email: string;
  password: string;
  projectKey: string;
  sprintName: string;
  /** Epic shown in PROJECT scope but elided in SPRINT scope (an epic is never a member). */
  epicTitle: string;
  /** A second, wholly-backlog epic — present in project scope, absent in sprint scope. */
  backlogEpicTitle: string;
  /** A story that is ITSELF a sprint member → a TOP-IN-SPRINT root; drillable. */
  memberStoryTitle: string;
  /** The member story's child (backlog) — shown on drill (the member is the unit). */
  memberStoryChildTitle: string;
  /** An in-sprint subtask whose parent story is NOT a member → a TOP-IN-SPRINT root. */
  memberSubtaskTitle: string;
  /** The non-member parent story of the in-sprint subtask — elided in sprint scope. */
  nonMemberStoryTitle: string;
}

/**
 * The SPRINT-SCOPE fixture (MOTIR-1384): a populated roadmap with an ACTIVE SPRINT,
 * shaped so project scope and sprint scope render visibly different node sets under
 * the TOP-IN-SPRINT model. The sprint-scoped roadmap is rooted at the topmost
 * in-sprint items:
 *   - `memberStory` (a story that IS a member) → a root in sprint scope, drillable
 *     to its full subtree (incl. its backlog child);
 *   - `memberSubtask` (an in-sprint subtask of a NON-member story) → a root, while
 *     its parent story + the epic above are elided;
 *   - the epics and the wholly-backlog epic never appear in sprint scope.
 *
 * Sprint membership is the flat `work_item.sprintId`; this seed sets it directly
 * (the same sanctioned direct-`db` reach the tenant pin above uses).
 */
export async function seedSprintRoadmap(email: string): Promise<SprintRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — sprint',
    'Sprint Roadmap',
    'SPRT',
  );

  const sprintName = 'Sprint 1';
  const sprint = await db.sprint.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      name: sprintName,
      state: 'active',
      sequence: 1,
    },
  });

  // Status left DERIVED (MOTIR-2888) — see the note on the sibling fixture above:
  // this epic's status is not asserted, and setting it here would be recomputed
  // away by its children.
  const epicTitle = 'Platform foundation';
  const epic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: epicTitle },
    ctx,
  );

  // A NON-member story with an IN-SPRINT subtask → the subtask is a top-in-sprint root.
  const nonMemberStoryTitle = 'Authentication';
  const nonMemberStory = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: nonMemberStoryTitle, parentId: epic.id },
    ctx,
  );
  const memberSubtaskTitle = 'Login flow';
  const memberSubtask = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', title: memberSubtaskTitle, parentId: nonMemberStory.id },
    ctx,
  );
  await db.workItem.update({ where: { id: memberSubtask.id }, data: { sprintId: sprint.id } });

  // A MEMBER story → a top-in-sprint root; its (backlog) child shows on drill.
  const memberStoryTitle = 'Billing';
  const memberStory = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: memberStoryTitle, parentId: epic.id },
    ctx,
  );
  await db.workItem.update({ where: { id: memberStory.id }, data: { sprintId: sprint.id } });
  const memberStoryChildTitle = 'Invoices';
  await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', title: memberStoryChildTitle, parentId: memberStory.id },
    ctx,
  );

  // A second epic that is wholly backlog → absent in sprint scope.
  const backlogEpicTitle = 'Growth experiments';
  const backlogEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: backlogEpicTitle },
    ctx,
  );
  await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Referrals', parentId: backlogEpic.id },
    ctx,
  );

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    projectKey,
    sprintName,
    epicTitle,
    backlogEpicTitle,
    memberStoryTitle,
    memberStoryChildTitle,
    memberSubtaskTitle,
    nonMemberStoryTitle,
  };
}

/**
 * A WIDE root level — enough epics that the whole-level fit falls BELOW the
 * arrival floor (Story MOTIR-3833 · MOTIR-3841).
 *
 * The arrival rule only bites on a level that cannot be drawn legibly whole, so a
 * fixture with two epics cannot see it at all. Eighteen root epics put the
 * level's world box at roughly 1720×712 under the shipped
 * 5-column `deterministicLayout` band (MOTIR-10537), which fits at ~0.60 in a
 * laptop-sized canvas — under the 0.80 floor, and too tall at the floor to fit, so
 * the arrival still follows the frontier vertically. One of
 * them is the in-progress FRONTIER (the card the arrival centres on) and one is a
 * drillable STORY-bearing epic, so the same fixture serves the drill / URL / Back
 * walk without a second seed.
 */
export interface WideRoadmapSeed extends RoadmapSeed {
  /** The drill target's own key + title — what `?item=` names after one drill. */
  drillEpicIdentifier: string;
  drillEpicTitle: string;
  /** A child of the drill target, visible only once drilled in. */
  drillChildTitle: string;
  /** Its sibling, which is `is_blocked_by` it — the edge that makes the drilled
   *  level draw the dependency LEGEND, so the collapse walk has something to
   *  collapse. */
  drillSiblingTitle: string;
  /** The in-progress frontier's title — the "you are here" card. */
  frontierEpicTitle: string;
  /** How many root epics the level carries. */
  rootEpicCount: number;
}

export async function seedWideRoadmap(email: string): Promise<WideRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — wide',
    'Wide Roadmap',
    'WIDE',
  );

  // The FRONTIER: in-progress, so the level has a "you are here" card for the
  // arrival to centre on. Its status is DERIVED from a started child.
  const frontierEpicTitle = 'Epic 7: AI Planning Layer';
  const frontier = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: frontierEpicTitle },
    ctx,
  );
  const started = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'The planning canvas', parentId: frontier.id },
    ctx,
  );
  await workItemsService.updateStatus(started.id, 'in_progress', ctx);
  await waitForDerivedStatus(frontier.id, 'in_progress');

  // The DRILL TARGET — a second drillable epic, so the walk drills somewhere
  // other than the frontier and the URL names a level the reader chose.
  const drillEpicTitle = 'Epic 8: Launch readiness';
  const drillEpic = await workItemsService.createWorkItem(
    { projectId, kind: 'epic', title: drillEpicTitle },
    ctx,
  );
  const drillChildTitle = 'Roadmap canvas, refined';
  const drillChild = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: drillChildTitle, parentId: drillEpic.id },
    ctx,
  );
  // A SECOND child plus a real `is_blocked_by` edge between the two. Without an
  // edge the canvas draws no dependency legend at all (it is shown only when a
  // level carries a non-`flow` edge), so a walk over this level could not reach
  // the collapse control — the fixture would silently skip the chapter it exists
  // to record. Two nodes still fit far above the arrival floor, so the drilled
  // level remains the "fitted whole" case.
  const drillSiblingTitle = 'The level is the URL';
  const drillSibling = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: drillSiblingTitle, parentId: drillEpic.id },
    ctx,
  );
  await adminDb.workItemLink.create({
    data: {
      fromId: drillSibling.id,
      toId: drillChild.id,
      kind: 'is_blocked_by',
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
    },
  });

  // …and enough siblings that the level cannot be fitted legibly. Leaf epics: a
  // childless epic still occupies a cell in the layout, which is all the arrival
  // scale depends on.
  const FILLER = 16;
  for (let i = 1; i <= FILLER; i += 1) {
    await workItemsService.createWorkItem(
      { projectId, kind: 'epic', title: `Epic ${i}: Filler stream ${i}` },
      ctx,
    );
  }

  await adminDb.project.update({ where: { id: projectId }, data: { onboardingRanAt: null } });

  const drilled = await adminDb.workItem.findUniqueOrThrow({
    where: { id: drillEpic.id },
    select: { identifier: true },
  });

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    projectKey,
    activeEpicTitle: frontierEpicTitle,
    otherEpicTitle: drillEpicTitle,
    doneChildTitle: 'The planning canvas',
    todoChildTitle: drillChildTitle,
    drillEpicIdentifier: drilled.identifier,
    drillEpicTitle,
    drillChildTitle,
    drillSiblingTitle,
    frontierEpicTitle,
    rootEpicCount: FILLER + 2,
  };
}

export interface FolderRoadmapSeed {
  email: string;
  password: string;
  projectKey: string;
  projectId: string;
  ctx: ServiceContext;
  epicTitles: [string, string];
  looseBugTitle: string;
  /** Root folder "Archive" — holds child folder "Imports" and three filed items. */
  archiveId: string;
  /** "Imports", inside Archive — holds one filed bug. */
  importsId: string;
  /** "Later" — an EMPTY root folder. */
  laterId: string;
  archivedTitles: [string, string, string];
  deepBugTitle: string;
  /** The one filed bug that is a member of the active sprint. */
  sprintBugTitle: string;
}

/**
 * The FOLDER roadmap fixture (Bug MOTIR-5710 · MOTIR-5743): a project whose root
 * holds two epics, an unfiled bug and two folders — "Archive" (a child folder
 * plus three filed items, one of them an epic) and an empty "Later" — with one
 * filed bug committed to the active sprint, so sprint scope has a filed member
 * to draw WITHOUT its folder. Seeded through the shipped folder service; its own
 * raw writes (the sprint) ride `adminDb` per the ratchet noted above.
 */
export async function seedFolderRoadmap(email: string): Promise<FolderRoadmapSeed> {
  const { ctx, projectId, projectKey } = await makeTenant(
    email,
    'Roadmap E2E — folders',
    'Folder Roadmap',
    'FOLD',
  );
  const make = (kind: 'epic' | 'bug' | 'story', title: string) =>
    workItemsService.createWorkItem({ projectId, kind, title }, ctx);
  const folder = (name: string, parentFolderId: string | null = null) =>
    foldersService.createFolder({ projectId, parentFolderId, name }, ctx);

  const epicTitles: [string, string] = ['Platform foundation', 'Growth experiments'];
  for (const title of epicTitles) await make('epic', title);
  const looseBugTitle = 'Loose bug';
  await make('bug', looseBugTitle);

  const archive = await folder('Archive');
  const later = await folder('Later');
  const imports = await folder('Imports', archive.id);

  const archivedTitles: [string, string, string] = ['Filed epic', 'Filed bug one', 'Filed bug two'];
  const archived = [
    await make('epic', archivedTitles[0]),
    await make('bug', archivedTitles[1]),
    await make('bug', archivedTitles[2]),
  ];
  for (const item of archived) {
    await foldersService.fileWorkItem(item.id, { folderId: archive.id }, ctx);
  }
  const deepBugTitle = 'Deep bug';
  const deep = await make('bug', deepBugTitle);
  await foldersService.fileWorkItem(deep.id, { folderId: imports.id }, ctx);

  const sprint = await adminDb.sprint.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      name: 'Sprint 1',
      state: 'active',
      sequence: 1,
    },
  });
  await adminDb.workItem.update({ where: { id: archived[1]!.id }, data: { sprintId: sprint.id } });

  return {
    email,
    password: ROADMAP_SEED_PASSWORD,
    projectKey,
    projectId,
    ctx,
    epicTitles,
    looseBugTitle,
    archiveId: archive.id,
    importsId: imports.id,
    laterId: later.id,
    archivedTitles,
    deepBugTitle,
    sprintBugTitle: archivedTitles[1],
  };
}

export interface FolderPlanSeed {
  planId: string;
  /** The `add` filed into "Archive" (`parentRef: folder:<archiveId>`). */
  filedTitle: string;
  /** The unfiled ROOT `add`. */
  rootTitle: string;
}

/**
 * A `planned` plan over the folder roadmap (Bug MOTIR-5782 · MOTIR-5796): one `add`
 * FILED into "Archive" and one unfiled root `add`, through the shipped
 * `createPlan → addProposals → markPlanned` calls — a folder-filed proposal is a
 * plan fact, not a planner output, so no planner turn is driven. `sourceJobId`
 * ties it to a plan-change run for the overlay's stubbed submit.
 */
export async function seedFolderPlan(
  seed: FolderRoadmapSeed,
  sourceJobId?: string,
): Promise<FolderPlanSeed> {
  const filedTitle = 'Filed proposal';
  const rootTitle = 'Root proposal';
  const plan = await plansService.createPlan(
    seed.projectId,
    { title: 'File the importer work', ...(sourceJobId ? { sourceJobId } : {}) },
    seed.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: filedTitle, kind: 'story' },
        parentRef: `${FOLDER_REF_PREFIX}${seed.archiveId}`,
      },
      { op: 'add', proposedFields: { title: rootTitle, kind: 'story' } },
    ],
    seed.ctx,
  );
  await plansService.markPlanned(plan.id, seed.ctx);
  return { planId: plan.id, filedTitle, rootTitle };
}
