// E2E: the ready LANES on /ready (Story MOTIR-6829 · MOTIR-6836) — the assembled
// surface in a real browser against the real datastore: the lane service reads,
// rendered by the switched, grouped page (design/ready/ready--lanes.mock.html).
//
//   - a runnable story is ONE collapsed row over its ready leaves; an epic is no
//     row; a task directly under an epic stands alone;
//   - the lane switch — Ready to run · Bugs — shows the bugs lane in the same
//     full-height pane, with its count, and a bug with a ready subtask expands;
//   - the container row's copy is the PARENT run, `motir run <KEY>`;
//   - each lane's empty line, and the EmptyState once both are empty;
//   - a container whose leaves straddle a page boundary stays ONE row after the
//     next page streams in, and stays expanded.
//
// Waits are on authoritative signals — the page MOUNTED (its heading and list)
// before any lane assertion, a transition's 200 before a reload, the load-more
// row count — never on timeouts (the coding convention § E2E discipline).

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { signUp as apiSignUp, createProject, transition } from './_helpers/workflow';
import { TEST_PASSWORD, BASE_URL, type TestUser } from './_helpers/work-item-setup';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Created {
  id: string;
  identifier: string;
}

async function mk(
  ctx: APIRequestContext,
  projectId: string,
  data: { title: string; kind: string; priority?: string; parentId?: string },
): Promise<Created> {
  const res = await ctx.post('/api/_test/work-items', { data: { projectId, ...data } });
  expect(res.status(), `create "${data.title}"`).toBe(201);
  return (await res.json()) as Created;
}

async function tenant(slug: string): Promise<{ owner: TestUser; projectId: string }> {
  const owner = await apiSignUp(`e2e-ready-lanes-${slug}@example.com`);
  const project = await createProject(owner, 'Ready Lanes', 'RLN');
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.userId, workspaceId: owner.workspaceId } },
    data: { activeProjectId: project.id },
  });
  return { owner, projectId: project.id };
}

/** Epic E › story S (three subtasks), story S2 (one `highest` subtask), task T;
 *  bug B (childless) and bug B2 › one subtask. */
async function seedTree(ctx: APIRequestContext, projectId: string) {
  const E = await mk(ctx, projectId, { title: 'Ready lanes epic', kind: 'epic' });
  const S = await mk(ctx, projectId, { title: 'Group by story', kind: 'story', parentId: E.id });
  const s = [
    await mk(ctx, projectId, { title: 'Lane s1', kind: 'subtask', parentId: S.id }),
    await mk(ctx, projectId, { title: 'Lane s2', kind: 'subtask', parentId: S.id }),
    await mk(ctx, projectId, { title: 'Lane s3', kind: 'subtask', parentId: S.id }),
  ];
  const S2 = await mk(ctx, projectId, {
    title: 'Run the next story',
    kind: 'story',
    parentId: E.id,
  });
  const t1 = await mk(ctx, projectId, {
    title: 'Parent flag',
    kind: 'subtask',
    priority: 'highest',
    parentId: S2.id,
  });
  const T = await mk(ctx, projectId, { title: 'Loose task', kind: 'task', parentId: E.id });
  const B = await mk(ctx, projectId, { title: 'Toast clips keys', kind: 'bug' });
  const B2 = await mk(ctx, projectId, { title: 'Load-more drops a row', kind: 'bug' });
  const b1 = await mk(ctx, projectId, { title: 'Reproduce it', kind: 'subtask', parentId: B2.id });
  return { E, S, s, S2, t1, T, B, B2, b1 };
}

const mainList = (page: Page) => page.getByRole('list', { name: 'Ready work items' });
const bugsList = (page: Page) => page.getByRole('list', { name: 'Ready bugs' });
const rowOf = (page: Page, key: string) => page.getByRole('listitem').filter({ hasText: key });

/** Open /ready from the sidebar entry and wait until the page is MOUNTED. */
async function openReady(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Ready' })
    .click();
  await expect(page).toHaveURL(/\/ready(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Ready to start', level: 1 })).toBeVisible();
}

test('/ready groups a story into one expandable row, never lists an epic, and keeps bugs in their own lane', async ({
  page,
  context,
}) => {
  const { owner, projectId } = await tenant('groups');
  const t = await seedTree(owner.ctx, projectId);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  await signIn(page, owner.email, TEST_PASSWORD);
  await openReady(page);
  await expect(mainList(page)).toBeVisible();

  // The lane order: S2 (its best leaf is `highest`) before S. E is no row; T
  // stands alone, with no toggle.
  const text = (await mainList(page).innerText()).replace(/\s+/g, ' ');
  expect(text.indexOf(t.S2.identifier)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(t.S2.identifier)).toBeLessThan(text.indexOf(t.S.identifier));
  expect(text).not.toContain(t.E.identifier);
  await expect(rowOf(page, t.T.identifier)).toBeVisible();
  await expect(rowOf(page, t.T.identifier).getByRole('button', { name: /^Expand / })).toHaveCount(
    0,
  );
  // S is ONE collapsed row reading how much of it is ready; its leaves are hidden.
  await expect(mainList(page).getByTestId(`ready-container-${t.S.identifier}`)).toContainText(
    '3 of 3 ready',
  );
  for (const leaf of t.s) await expect(mainList(page)).not.toContainText(leaf.identifier);
  // Bugs are not in this lane.
  for (const bug of [t.B, t.B2, t.b1])
    await expect(mainList(page)).not.toContainText(bug.identifier);

  // Expand S → exactly its three subtasks, in order; collapse → hidden again.
  await page.getByRole('button', { name: `Expand ${t.S.identifier}` }).click();
  for (const leaf of t.s) await expect(rowOf(page, leaf.identifier)).toBeVisible();
  const expanded = (await mainList(page).innerText()).replace(/\s+/g, ' ');
  const at = t.s.map((leaf) => expanded.indexOf(leaf.identifier));
  expect(at).toEqual([...at].sort((a, b) => a - b));
  await page.getByRole('button', { name: `Collapse ${t.S.identifier}` }).click();
  for (const leaf of t.s) await expect(mainList(page)).not.toContainText(leaf.identifier);

  // The container copies the PARENT run.
  await rowOf(page, t.S.identifier).first().hover();
  await page.getByRole('button', { name: `Copy parent-run command for ${t.S.identifier}` }).click();
  // The toast is client-only (never SSR'd, never in a streamed copy): one node.
  await expect(
    page.getByText(`Paste motir run ${t.S.identifier} into your terminal.`).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `motir run ${t.S.identifier}`,
  );

  // The switch → the Bugs lane, its count, and the bug with a subtask expands.
  const bugsSwitch = page.getByRole('button', { name: /^Bugs/ });
  await expect(bugsSwitch).toContainText('2');
  await bugsSwitch.click();
  await expect(page).toHaveURL(/[?&]lane=bugs/);
  await expect(bugsList(page)).toBeVisible();
  await expect(rowOf(page, t.B.identifier)).toBeVisible();
  await page.getByRole('button', { name: `Expand ${t.B2.identifier}` }).click();
  await expect(rowOf(page, t.b1.identifier)).toBeVisible();

  // The lane is URL state: a reload lands on it again.
  await page.reload();
  await expect(bugsList(page)).toBeVisible();
});

test('each lane says so when it empties, and the page falls back to its EmptyState only when both do', async ({
  page,
}) => {
  const { owner, projectId } = await tenant('empties');
  const t = await seedTree(owner.ctx, projectId);
  await signIn(page, owner.email, TEST_PASSWORD);

  // Every leaf of the leaves lane started → Ready to run is empty, Bugs is not.
  for (const leaf of [...t.s, t.t1, t.T]) {
    expect((await transition(owner.ctx, leaf.id, 'in_progress')).status()).toBe(200);
  }
  await openReady(page);
  await expect(page.getByRole('main').getByText('Nothing ready to run.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bugs/ })).toContainText('2');

  // …then the bug work too → the page's EmptyState.
  for (const bug of [t.B, t.b1]) {
    expect((await transition(owner.ctx, bug.id, 'in_progress')).status()).toBe(200);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ready to start', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: "Nothing's ready right now", level: 2 }),
  ).toBeVisible();
});

test('a container whose leaves straddle a page boundary stays ONE expanded row after load-more', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, projectId } = await tenant('scale');
  // 60 `highest` subtasks under ONE story rank first, so the first 50-row page
  // ends inside its group and the next page carries the rest of it.
  const BIG = await mk(owner.ctx, projectId, { title: 'Import Jira epics', kind: 'story' });
  const leaves: Created[] = [];
  for (let i = 1; i <= 60; i++) {
    leaves.push(
      await mk(owner.ctx, projectId, {
        title: `Map field ${i}`,
        kind: 'subtask',
        priority: 'highest',
        parentId: BIG.id,
      }),
    );
  }
  const OTHER = await mk(owner.ctx, projectId, { title: 'Board swimlanes', kind: 'story' });
  await mk(owner.ctx, projectId, { title: 'Swimlane leaf', kind: 'subtask', parentId: OTHER.id });

  await signIn(page, owner.email, TEST_PASSWORD);
  await openReady(page);
  await page.getByRole('button', { name: `Expand ${BIG.identifier}` }).click();

  // Scroll the PANE to its end until the next page has streamed in: the last
  // leaf of BIG is only on page two.
  // The pane that holds the LIVE list — scoped through it, never an unscoped test
  // id, since a streamed Suspense keeps a hidden copy mounted for a moment.
  const pane = mainList(page).locator('xpath=ancestor::*[@data-testid="ready-lane-pane"]');
  const last = leaves.at(-1)!;
  await expect
    .poll(
      async () => {
        await pane.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        return mainList(page).getByText(last.identifier, { exact: true }).count();
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  // The list is virtualized, so BIG's header is unmounted while the pane sits at
  // its end — scroll back to the top, where it renders: ONE header for BIG
  // (the second page's rows merged into it), still expanded.
  await pane.evaluate((el) => el.scrollTo(0, 0));
  await expect(mainList(page).getByTestId(`ready-container-${BIG.identifier}`)).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Collapse ${BIG.identifier}` })).toBeVisible();
});

// ─── The pane fills the page down to the viewport's bottom edge (MOTIR-10974) ──
//
// The pane used to be `calc(100dvh - 16rem - clearance)` tall — a guess at
// everything above it that over-reserved, leaving an empty band under the list.
// It is now the flexible remainder of a viewport-height column that runs to the
// bottom of the screen, whatever renders above it. The Plan-with-AI orb floats
// over the list; the pane's bottom padding (the shell clearance) lets the last
// row scroll clear of it.

/** The pane's bottom edge against the viewport and the clearance line, plus the
 *  two scrollers, and where the last row lands with the pane scrolled to the end. */
async function paneFit(page: Page, laneList: ReturnType<typeof mainList>) {
  const pane = laneList.locator('xpath=ancestor::*[@data-testid="ready-lane-pane"]');
  return pane.evaluate((el) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    // The shell wrapper sets it (1.5rem, or 6rem under the Plan-with-AI orb);
    // it inherits down to the pane.
    const raw = getComputedStyle(el).getPropertyValue('--shell-bottom-clearance').trim();
    const clearance = raw.endsWith('rem') ? parseFloat(raw) * rem : parseFloat(raw);
    const main = document.getElementById('main')!;
    const scrollTop = el.scrollTop;
    el.scrollTo(0, el.scrollHeight);
    // The shown lane's list: its bottom is the last row's (a windowed list
    // keeps its full height), so this is where the list ends at full scroll.
    const list = el.querySelector(':scope > div:not([hidden])')!;
    const lastRowBottom = list.getBoundingClientRect().bottom;
    el.scrollTo(0, scrollTop);
    return {
      bottom: el.getBoundingClientRect().bottom,
      viewportBottom: window.innerHeight,
      clearanceLine: window.innerHeight - clearance,
      lastRowBottom,
      paneScrolls: el.scrollHeight > el.clientHeight,
      documentFits: document.scrollingElement!.scrollHeight <= window.innerHeight,
      mainFits: main.scrollHeight <= main.clientHeight,
    };
  });
}

async function expectPaneAtBottom(page: Page, laneList: ReturnType<typeof mainList>) {
  await expect(laneList).toBeVisible();
  const fit = await paneFit(page, laneList);
  // The pane runs to the bottom of the screen — no empty band under it.
  expect(Math.abs(fit.bottom - fit.viewportBottom), JSON.stringify(fit)).toBeLessThanOrEqual(4);
  // Scrolled to the end, the last row clears the orb's reservation.
  expect(fit.lastRowBottom, JSON.stringify(fit)).toBeLessThanOrEqual(fit.clearanceLine + 4);
  // The list is longer than the pane, so it is the PANE that scrolls — neither
  // the document nor the shell's <main>.
  expect(fit.paneScrolls).toBe(true);
  expect(fit.documentFits).toBe(true);
  expect(fit.mainFits).toBe(true);
}

test('the lane pane reaches the viewport bottom on both lanes, with or without the notices above it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, projectId } = await tenant('pane-fit');
  // Longer than the pane at either viewport, in BOTH lanes.
  for (let i = 1; i <= 30; i++) {
    await mk(owner.ctx, projectId, { title: `Fill task ${i}`, kind: 'task' });
    await mk(owner.ctx, projectId, { title: `Fill bug ${i}`, kind: 'bug' });
  }

  await signIn(page, owner.email, TEST_PASSWORD);
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size);
    await openReady(page);
    await expectPaneAtBottom(page, mainList(page));

    await page.getByRole('button', { name: /^Bugs/ }).click();
    await expect(page).toHaveURL(/[?&]lane=bugs/);
    await expectPaneAtBottom(page, bugsList(page));

    // Back to Ready to run for the next size's sidebar click.
    await page.getByRole('button', { name: /^Ready to run/ }).click();
    await expect(page).not.toHaveURL(/[?&]lane=bugs/);
  }

  // With content above the lanes: the REAL expansion nudge (its read answered
  // with a nominated stub), plus a block standing in for SurfaceTitlesNotice —
  // whose no-credit state needs a spent translation budget — inserted where the
  // notice renders, as the lanes' preceding sibling. The pane gets shorter by
  // their height and still ends at the clearance.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/ready/nudge', (route) =>
    route.fulfill({
      json: {
        readyCount: 2,
        nominatedKey: 'RLN-999',
        nominatedTitle: 'Stub to expand',
        threshold: 3,
      },
    }),
  );
  await openReady(page);
  // The nudge has rendered (its dismiss control is unique to it) before measuring.
  await expect(page.getByRole('button', { name: 'Dismiss expansion nudge' })).toBeVisible();
  const before = await paneFit(page, mainList(page));
  await mainList(page)
    .locator('xpath=ancestor::*[@data-testid="ready-lane-pane"]/..')
    .evaluate((lanes) => {
      const notice = document.createElement('div');
      notice.setAttribute('data-titles-notice', 'stand-in');
      notice.style.height = '48px';
      lanes.parentElement!.insertBefore(notice, lanes);
    });
  await expectPaneAtBottom(page, mainList(page));
  const after = await paneFit(page, mainList(page));
  expect(after.bottom).toBeCloseTo(before.bottom, 0);
});

test('at phone width the lane switch and a scrollable list stay reachable', async ({ page }) => {
  const { owner, projectId } = await tenant('pane-phone');
  for (let i = 1; i <= 20; i++) {
    await mk(owner.ctx, projectId, { title: `Phone task ${i}`, kind: 'task' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, owner.email, TEST_PASSWORD);
  await page.goto('/ready');
  await expect(page.getByRole('heading', { name: 'Ready to start', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bugs/ })).toBeVisible();
  const pane = mainList(page).locator('xpath=ancestor::*[@data-testid="ready-lane-pane"]');
  const scrolled = await pane.evaluate((el) => {
    el.scrollTo(0, el.scrollHeight);
    return { canScroll: el.scrollHeight > el.clientHeight, top: el.scrollTop };
  });
  expect(scrolled.canScroll).toBe(true);
  expect(scrolled.top).toBeGreaterThan(0);
});
