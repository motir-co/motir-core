import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import en from '@/messages/en.json';

// A SOFT BLOCK READS DIFFERENTLY FROM A HARD ONE — the story's browser walk AND
// its acceptance receipt (Story MOTIR-6354 · Subtask MOTIR-6378).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Step 1 of the story's `## Verification`. An epic is blocked by another open
// epic. A subtask deep inside it has no blocker of its own: its page and its
// quick view show the YELLOW "Parent blocked" banner naming the epic — the fix
// lives on the ancestor. A sibling subtask with its OWN open blocker keeps the
// PEACH "Blocked" banner naming that blocker. When the epic's blocker is done,
// the first subtask reads "Ready to start".
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// A colour is only proven RENDERED. The render test (MOTIR-6377) proves the
// class; this proves the painted background, in the real theme, equals the
// design token — measured against a probe painted with the same token inside
// the banner's own container, so the assertion follows the token rather than a
// hex typed here.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the page heading, the banner itself, the
// quick view's own GET `/api/work-items/peek` read. The status change in the last
// chapter is committed through the service BEFORE the reload, so the reload's
// render is the authoritative read of the committed state. The holds are
// `chapter()` / `beat()` pacing, taken only after each state is proven.

const PASSWORD = 'acceptance-soft-hard-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-soft-hard@example.com';

const EPIC_BLOCKER = 'Migrate the ledger store';
const EPIC = 'Checkout rework';
const STORY = 'Split the payment flow';
const SOFT = 'Rename the retry flag';
const HARD = 'Wire the new adapter';
const OWN_BLOCKER = 'Publish the adapter contract';

interface Item {
  id: string;
  identifier: string;
  title: string;
}

async function seedTree() {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Mo Rivera',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Blocks Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Payments',
    identifier: 'SOFT',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  const make = async (
    kind: 'epic' | 'story' | 'subtask',
    title: string,
    parentId?: string,
  ): Promise<Item> => {
    const dto = await workItemsService.createWorkItem(
      { projectId: project.id, kind, title, ...(parentId ? { parentId } : {}) },
      ctx,
    );
    return { id: dto.id, identifier: dto.identifier, title: dto.title };
  };

  const epicBlocker = await make('epic', EPIC_BLOCKER);
  const epic = await make('epic', EPIC);
  const story = await make('story', STORY, epic.id);
  const soft = await make('subtask', SOFT, story.id);
  const hard = await make('subtask', HARD, story.id);
  const ownBlocker = await make('subtask', OWN_BLOCKER, story.id);

  // `is_blocked_by` runs FROM the blocked item TO its blocker.
  await workItemsService.linkWorkItems(
    { fromId: epic.id, toId: epicBlocker.id, kind: 'is_blocked_by' },
    ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: hard.id, toId: ownBlocker.id, kind: 'is_blocked_by' },
    ctx,
  );

  return { ctx, epicBlocker, epic, soft, hard, ownBlocker };
}

/** Walk an item to Done along the default workflow's only legal path. */
async function moveToDone(id: string, ctx: ServiceContext): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', ctx);
  await workItemsService.updateStatus(id, 'in_review', ctx);
  await workItemsService.updateStatus(id, 'done', ctx);
}

/**
 * The banner's painted background, and the colour `token` paints in the SAME
 * container — a probe appended beside the banner, read, and removed. Equal
 * means the banner is painted with that token in the live theme.
 */
async function paintedAgainst(banner: Locator, token: string) {
  return banner.evaluate((el, cssVar) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${cssVar})`;
    el.parentElement!.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(el).backgroundColor, expected };
  }, token);
}

async function expectPainted(banner: Locator, token: string, other: string): Promise<void> {
  const own = await paintedAgainst(banner, token);
  expect(own.actual, `the banner is painted with ${token}`).toBe(own.expected);
  const theOther = await paintedAgainst(banner, other);
  expect(own.actual, `…which is not ${other}`).not.toBe(theOther.expected);
}

/** Open the quick view over /items by activating the row; wait for its real read. */
async function openPeek(page: Page, identifier: string) {
  const row = page.getByRole('main').getByTestId(`issue-row-${identifier}`);
  await expect(row).toBeVisible();
  const read = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  // The row's stretched link opens the peek (MOTIR-1306); the press lands in the
  // row's left padding, where only the link is (acceptance-work-item-difficulty).
  await row
    .getByRole('link')
    .first()
    .click({ position: { x: 6, y: 22 } });
  expect((await read).status(), 'the quick view read').toBe(200);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const r = en.ui.readiness;

test('a card held only by its parent reads soft, one with its own blocker reads hard, and the soft one turns ready when the parent is freed', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(240_000);
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6354');

  await resetDatabase();
  const { ctx, epicBlocker, epic, soft, hard, ownBlocker } = await seedTree();

  await signIn(page, OWNER_EMAIL, PASSWORD);
  const main = page.getByRole('main');

  await chapter(
    'A subtask held only by its epic’s block: the yellow “Parent blocked” banner',
    async () => {
      await page.goto(`/items/${soft.identifier}`);
      await expect(page.getByRole('heading', { name: SOFT })).toBeVisible();

      const banner = main.locator('[data-readiness="soft"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(r.parentBlocked);
      await expect(banner).toContainText(r.waitingOnParent);
      // It names the blocked EPIC — the ancestor that holds it, linked.
      await expect(banner.getByRole('link', { name: epic.identifier })).toHaveAttribute(
        'href',
        `/items/${epic.identifier}`,
      );
      await expect(banner).toContainText(EPIC);
      await expect(main.locator('[data-readiness="hard"]')).toHaveCount(0);
      await banner.scrollIntoViewIfNeeded();
      await expectPainted(banner, '--el-tint-yellow', '--el-tint-peach');
      await beat();
    },
  );

  await chapter(
    'A subtask with its own open blocker keeps the peach “Blocked” banner',
    async () => {
      await page.goto(`/items/${hard.identifier}`);
      await expect(page.getByRole('heading', { name: HARD })).toBeVisible();

      const banner = main.locator('[data-readiness="hard"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(r.blocked);
      await expect(banner).not.toContainText(r.parentBlocked);
      // Own blockers win over the same blocked epic above it: it names ITS blocker.
      await expect(banner).toContainText('Waiting on 1 work item');
      await expect(banner.getByRole('link')).toHaveCount(1);
      await expect(banner.getByRole('link', { name: ownBlocker.identifier })).toHaveAttribute(
        'href',
        `/items/${ownBlocker.identifier}`,
      );
      await expect(banner.getByRole('link', { name: epic.identifier })).toHaveCount(0);
      await expect(main.locator('[data-readiness="soft"]')).toHaveCount(0);
      await banner.scrollIntoViewIfNeeded();
      await expectPainted(banner, '--el-tint-peach', '--el-tint-yellow');
      await beat();
    },
  );

  await chapter('The quick view shows the same soft banner at peek density', async () => {
    await page.goto('/items?view=list');
    const dialog = await openPeek(page, soft.identifier);
    await expect(dialog.getByRole('heading', { name: SOFT })).toBeVisible();

    const banner = dialog.locator('[data-readiness="soft"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(r.parentBlocked);
    await expect(banner.getByRole('link', { name: epic.identifier })).toBeVisible();
    await expect(banner).toContainText(EPIC);
    await expectPainted(banner, '--el-tint-yellow', '--el-tint-peach');
    await beat();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  await chapter('The epic’s blocker is done — the subtask now reads “Ready to start”', async () => {
    // Committed BEFORE the page is read, so the render below reads the new state.
    await moveToDone(epicBlocker.id, ctx);

    await page.goto(`/items/${soft.identifier}`);
    await expect(page.getByRole('heading', { name: SOFT })).toBeVisible();
    const ready = main.getByText(r.ready, { exact: true });
    await expect(ready).toBeVisible();
    await expect(main.getByText(r.allResolved, { exact: true })).toBeVisible();
    await expect(main.locator('[data-readiness]')).toHaveCount(0);
    await ready.scrollIntoViewIfNeeded();
    await beat();
  });
});
