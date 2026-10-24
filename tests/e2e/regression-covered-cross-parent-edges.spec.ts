import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import en from '@/messages/en.json';

// A CROSS-STORY DEPENDENCY IS FLAGGED ONLY UNTIL THE STORIES CARRY IT — THE
// ACCEPTANCE RECEIPT (Story MOTIR-6352 · Subtask MOTIR-6365). The story's
// verification recipe, in a real browser against a production build and a real
// database, with no interception of the roadmap or plan-review reads.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Subtask X in story B waits on subtask Y in story A. While B does not wait on A,
// the roadmap flags X "blocked elsewhere" and names Y on a ghost anchor, and the
// legend names the remedy. A plan that adds B → A previews X clean on its review
// canvas; approving it leaves X clean on the roadmap, with the B → A arrow drawn
// one level up. A plan that removes B → A previews X flagged again.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// Every canvas level is a GET of `/api/projects/<key>/roadmap?parentId=<id>`,
// armed BEFORE the navigation or drill that fires it; the approve is its POST's
// 200. No assertion rests on the optimistic first paint or on a timeout.
//
// ── WHAT IS NOT DRIVEN HERE, AND WHERE IT IS PROVEN ──────────────────────────
//
// The level read is BEST-EFFORT: a failed read resolves an empty level rather than
// an error surface (`lib/planning/roadmapClient.ts`), and this card may not
// intercept the read to force one — so the failure state is proven below the
// browser, not here. The rules behind every step (covered / uncovered / exempt /
// cross-level, and agreement with `validate_work_item`) are proven in
// tests/integration/work-items/roadmapCoverageStoryGate.test.tsx (MOTIR-6373).

const PASSWORD = 'acceptance-covered-edges-pass-123';
const EMAIL = 'acceptance-covered-edges@example.com';
const LEGEND_MEANING = en.roadmap.canvas.legend.blockedElsewhereMeaning;

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
}

async function seedProject(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Checkout Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Checkout',
    identifier: 'CHK',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

async function workItem(
  seed: Seed,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
) {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/** A `planned` plan with ONE `modify` on story B, on the session `createPlan` gives it.
 *
 *  ⚠️ AMENDED by Story MOTIR-7883 (MOTIR-7886): this seed used to clear the plan's
 *  session so it opened the plan page with the page's own verbs. A session-less plan is
 *  a state no shipped path produces, and an undecided plan is now read and decided in
 *  the planning overlay, so the seed keeps the session it was created with. */
async function seedPlan(
  seed: Seed,
  title: string,
  storyB: string,
  patch: { blockedByAdd?: string[]; blockedByRemove?: string[] },
): Promise<string> {
  const plan = await plansService.createPlan(seed.projectId, { title }, seed.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId: storyB, patch }], seed.ctx);
  await plansService.markPlanned(plan.id, seed.ctx);
  return plan.id;
}

/** The level GET for one parent — armed BEFORE the action that fires it. */
const levelLoad = (page: Page, parentId: string) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/roadmap') &&
      new URL(r.url()).searchParams.get('parentId') === parentId &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

const node = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);
const pillOn = (page: Page, id: string) => node(page, id).getByTestId('cross-blocked-flag');

/** Open the roadmap INSIDE a work item's level (`?item=`, MOTIR-3836). */
async function openRoadmapLevel(page: Page, item: { id: string; identifier: string }) {
  const loaded = levelLoad(page, item.id);
  await page.goto(`/roadmap?item=${item.identifier}`);
  await loaded;
  await expect(page.getByRole('application')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** On a canvas already showing `parent`'s level, drill into `child`. */
async function drillInto(page: Page, child: { id: string }) {
  await node(page, child.id).click();
  const loaded = levelLoad(page, child.id);
  await page.getByRole('button', { name: en.roadmap.canvas.openChildren, exact: true }).click();
  await loaded;
}

test.afterAll(async () => {
  await db.$disconnect();
});

test('a cross-story blocker is flagged until the stories carry the edge — on the roadmap and in plan review', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6352');

  await resetDatabase();
  const seed = await seedProject();
  const epic = await workItem(seed, 'epic', 'Checkout');
  const storyA = await workItem(seed, 'story', 'Payments API', epic.id);
  const storyB = await workItem(seed, 'story', 'Checkout flow', epic.id);
  const y = await workItem(seed, 'subtask', 'Tokenise the card', storyA.id);
  const x = await workItem(seed, 'subtask', 'Charge the saved card', storyB.id);
  await workItemsService.linkWorkItems(
    { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
    seed.ctx,
  );

  await signIn(page, EMAIL, PASSWORD);

  await chapter('The stories do not wait on each other — X is flagged', async () => {
    await openRoadmapLevel(page, storyB);
    await expect(node(page, x.id)).toBeVisible();
    await expect(pillOn(page, x.id)).toHaveText('blocked elsewhere');
    // The ghost anchor names the blocker, and the story it lives in.
    await expect(node(page, y.id)).toContainText(y.identifier);
    await expect(node(page, y.id)).toContainText('in Payments API');
    // The legend names the remedy.
    await expect(page.getByRole('main').getByTestId('edge-legend')).toContainText(LEGEND_MEANING);
    await beat();
  });

  const wirePlan = await seedPlan(seed, 'Wire the stories', storyB.id, {
    blockedByAdd: [storyA.id],
  });

  await chapter(
    'A plan wires Checkout flow → Payments API — the review shows X clean',
    async () => {
      const epicLevel = levelLoad(page, epic.id);
      await openUndecidedPlan(page, wirePlan, { timeout: FIRST_PAINT_MS });
      await epicLevel;
      await expect(node(page, storyB.id)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await drillInto(page, storyB);
      await expect(node(page, x.id)).toBeVisible();
      await expect(pillOn(page, x.id)).toHaveCount(0);
      await expect(node(page, y.id)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Approve it — the roadmap agrees, and draws the arrow between the stories',
    async () => {
      // Undecided, so it is approved in the overlay's footer (Story MOTIR-7883).
      const overlay = await openUndecidedPlan(page, wirePlan, { timeout: FIRST_PAINT_MS });
      const approve = overlay
        .getByTestId('plan-change-confirm-bar')
        .getByRole('button', { name: en.approvalGate.planApproval.surface.approve, exact: true });
      await expect(approve).toBeVisible({ timeout: FIRST_PAINT_MS });
      const decided = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/plans/${wirePlan}/approve` &&
          r.request().method() === 'POST',
      );
      await approve.click();
      expect((await decided).status()).toBe(200);

      await openRoadmapLevel(page, storyB);
      await expect(node(page, x.id)).toBeVisible();
      await expect(pillOn(page, x.id)).toHaveCount(0);
      await expect(node(page, y.id)).toHaveCount(0);
      await beat();

      // One level up, the story-level arrow says it.
      await openRoadmapLevel(page, epic);
      await expect(node(page, storyA.id)).toBeVisible();
      await expect(node(page, storyB.id)).toBeVisible();
      await expect(page.getByTestId('canvas-edges').locator('path')).toHaveCount(1);
      await expect(pillOn(page, storyB.id)).toHaveCount(0);
      await beat();
    },
  );

  const unwirePlan = await seedPlan(seed, 'Unwire the stories', storyB.id, {
    blockedByRemove: [storyA.id],
  });

  await chapter(
    'A plan removing Checkout flow → Payments API previews X flagged again',
    async () => {
      const epicLevel = levelLoad(page, epic.id);
      await openUndecidedPlan(page, unwirePlan, { timeout: FIRST_PAINT_MS });
      await epicLevel;
      await expect(node(page, storyB.id)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await drillInto(page, storyB);
      await expect(pillOn(page, x.id)).toHaveText('blocked elsewhere');
      await expect(node(page, y.id)).toContainText(y.identifier);
      await beat();
    },
  );

  await chapter('A level with no off-level blocker carries no flag', async () => {
    await openRoadmapLevel(page, storyA);
    await expect(node(page, y.id)).toBeVisible();
    await expect(page.getByTestId('cross-blocked-flag')).toHaveCount(0);
    await expect(page.getByTestId('cross-flag')).toHaveCount(0);
  });
});
