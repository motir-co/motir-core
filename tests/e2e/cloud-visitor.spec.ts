import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { seedVisitorProject, VISITOR_PASSWORD, type VisitorSeed } from './_helpers/visitor-seed';

// THE VISITOR VIEW, END TO END (Story MOTIR-6170 · Subtask MOTIR-6651) — the
// story's `## Verification` recipe as a regression walk, unpaced. Its paced twin,
// `regression-visitor.spec.ts`, is the story's acceptance receipt.
//
// ⚠️ THIS LANE, AND ONLY THIS LANE. Public projects are a cloud capability: with
// `MOTIR_CLOUD` off every `/p/<id>/<view>` is correctly not-found, so this walk in
// `playwright.config.ts`'s lane would pass its negatives while proving nothing.
// `playwright.cloud.config.ts` sets it on the runner and the server.
//
// ⚠️ EVERY STEP PROVES ITS SURFACE IS MOUNTED FIRST — the sign-in form, the
// consent screen's heading, the Visitor banner, the Visitors heading — before any
// negative ("no write control", "no hidden title", "no email") is asserted, so a
// not-found page can never satisfy one.
//
// ⚠️ THE `public-read` BUDGET IS NOT DRIVEN HERE (card step 14). Both cloud lanes
// run with `E2E_DISABLE_RATE_LIMIT=1`, which switches every limiter off, and the
// budget has no test override of its own; lowering it would mean a lane of its own
// for one assertion. The 429 is covered where the limiter can be reached — the
// story's integration gate (MOTIR-6650) and `tests/rateLimit/publicReadGuard*`.
//
let s: VisitorSeed;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  s = await seedVisitorProject('cloud');
});

/** Every response body a context received, for the step-9 scan. */
function recordBodies(context: BrowserContext): { bodies: Promise<string>[] } {
  const sink = { bodies: [] as Promise<string>[] };
  context.on('response', (res) => {
    sink.bodies.push(res.text().catch(() => ''));
  });
  return sink;
}

async function signInForm(page: Page, email: string): Promise<void> {
  await expect(page.getByRole('main').getByPlaceholder('Email address')).toBeVisible();
  await page.getByRole('main').getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(VISITOR_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function signedInAs(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  await signInForm(page, email);
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
  return page;
}

async function expectNoWriteControls(page: Page): Promise<void> {
  for (const name of [
    /^New work item$/,
    /^Create work item$/,
    /^Edit$/,
    /^Delete$/,
    /^Archive$/,
    /^Approve$/,
    /^Request changes$/,
    /^Plan with AI$/,
  ]) {
    await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: /^(Edit|Plan with AI)$/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch project' })).toHaveCount(0);
}

/** A room offers the Project view alone: no Mine to switch to. */
async function expectNoMineView(page: Page): Promise<void> {
  await expect(page.getByRole('tab', { name: /^Mine/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Mine/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Mine/ })).toHaveCount(0);
}

const visitorCount = (projectId: string) => adminDb.projectVisitor.count({ where: { projectId } });

test('a reader outside the organisation signs in, consents once, and reads the project read-only', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);

  // ── 1. The Manager reads the Visitor link off the Build-in-public page ──────
  const manager = await signedInAs(browser, s.manager.email);
  await manager.goto('/settings/project/public');
  await expect(manager.getByRole('heading', { name: 'Visitor link' })).toBeVisible();
  const link = (await manager.getByRole('main').getByTestId('visitor-link-url').innerText()).trim();
  expect(link).toBe(`${baseURL}/p/${s.project.key}/board`);

  // ── 2. Signed out, the link is the sign-in page, and no project data came ───
  const octx = await browser.newContext();
  const scan = recordBodies(octx);
  const o = await octx.newPage();
  await o.goto(link);
  await expect(o).toHaveURL(/\/sign-in\?next=/);
  await expect(o.getByRole('main').getByPlaceholder('Email address')).toBeVisible();
  // `next` returns to the link (through the consent screen).
  const next = new URL(o.url()).searchParams.get('next') ?? '';
  expect(decodeURIComponent(next)).toContain(`/p/${s.project.key}/board`);
  const signedOutBodies = await Promise.all(scan.bodies);
  const projectTitles = [
    ...s.visible.map((v) => v.title),
    ...s.hidden.map((h) => h.title),
    s.visibleEpic.title,
    s.privateEpic.title,
    s.plans.visible,
  ];
  for (const title of projectTitles) {
    expect(
      signedOutBodies.some((b) => b.includes(title)),
      `a signed-out response carried "${title}"`,
    ).toBe(false);
  }

  // ── 3. Signed in, the consent screen ────────────────────────────────────────
  await signInForm(o, s.outsider.email);
  await o.waitForURL((u) => u.pathname === `/p/${s.project.key}/consent`);
  await expect(
    o.getByRole('heading', { name: `Before you watch ${s.project.name}` }),
  ).toBeVisible();
  await expect(
    o
      .getByRole('main')
      .getByText(/name and email/)
      .first(),
  ).toBeVisible();
  await expect(o.getByRole('main').getByText(/this project’s workspace Managers/)).toBeVisible();
  await expect(o.getByRole('main').getByText(s.outsider.email, { exact: false })).toBeVisible();
  await expect(o.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(o.getByRole('button', { name: 'Go back' })).toBeVisible();

  // ── 4. Go back records nothing, and the screen is asked again ───────────────
  await o.getByRole('button', { name: 'Go back' }).click();
  await o.waitForURL((u) => !u.pathname.startsWith('/p/'));
  expect(await visitorCount(s.project.id)).toBe(0);
  await o.goto(link);
  await o.waitForURL((u) => u.pathname === `/p/${s.project.key}/consent`);
  await expect(
    o.getByRole('heading', { name: `Before you watch ${s.project.name}` }),
  ).toBeVisible();

  // ── 5. Continue: the board, under the Visitor chrome ────────────────────────
  const consent = o.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/p/${s.project.key}/consent`),
  );
  await o.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await o.waitForURL((u) => u.pathname === `/p/${s.project.key}/board`);
  expect(await visitorCount(s.project.id)).toBe(1);
  await expect(o.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
  await expect(o.getByRole('heading', { name: 'Boards', level: 1 })).toBeVisible();
  for (const v of s.visible) {
    await expect(o.getByRole('button', { name: `Open ${v.key}: ${v.title}` })).toBeVisible();
  }
  await expect(o.getByRole('button', { name: 'Notifications, no unread' })).toHaveCount(0);
  await expectNoWriteControls(o);

  // ── 6. The views, each with its records and no write control ────────────────
  await o.goto(`/p/${s.project.key}/items`);
  await expect(o.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
  for (const v of s.visible) {
    await expect(o.getByRole('link', { name: `${v.key} ${v.title}` })).toBeVisible();
  }
  // Other people by name only: the nameless member is the neutral label.
  await expect(o.getByRole('main').getByText('Project member').first()).toBeVisible();
  await expectNoWriteControls(o);

  await o.goto(`/p/${s.project.key}/tree`);
  await expect(o.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
  await expect(
    o.getByRole('link', { name: `${s.visibleEpic.key} ${s.visibleEpic.title}` }),
  ).toBeVisible();
  await expectNoWriteControls(o);

  await o.goto(`/p/${s.project.key}/roadmap`);
  await expect(o.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
  await expect(o.getByText(s.visibleEpic.title).first()).toBeVisible();
  await expectNoWriteControls(o);

  await o.goto(`/p/${s.project.key}/items/${s.visibleEpic.key}`);
  await expect(o.getByRole('heading', { name: s.visibleEpic.title, level: 1 })).toBeVisible();
  await expect(
    o.getByRole('button', { name: /^Status — You have read-only access/ }),
  ).toBeVisible();
  await expect(o.getByRole('textbox')).toHaveCount(0);
  await expect(o.getByRole('button', { name: /^Watch/ })).toHaveCount(0);
  await expectNoWriteControls(o);

  // A visible STORY's page: it loads, read-only, with no Watch control and no
  // item plan history — for a Visitor the Plans room is the plan surface.
  for (const story of s.visible) {
    const res = await o.goto(`/p/${s.project.key}/items/${story.key}`);
    expect(res?.status()).toBe(200);
    await expect(o.getByRole('heading', { name: story.title, level: 1 })).toBeVisible();
    await expect(
      o.getByRole('button', { name: /^Status — You have read-only access/ }),
    ).toBeVisible();
    await expect(o.getByRole('heading', { name: 'This page couldn’t load' })).toHaveCount(0);
    await expect(o.getByRole('button', { name: /^Watch/ })).toHaveCount(0);
    await expect(o.getByRole('heading', { name: 'Plans', level: 2 })).toHaveCount(0);
    await expect(o.getByRole('main').getByText('Couldn’t load watchers.')).toHaveCount(0);
    await expect(o.getByRole('textbox')).toHaveCount(0);
    await expectNoWriteControls(o);
  }

  await o.goto(`/p/${s.project.key}/plans`);
  await expect(o.getByRole('heading', { name: 'Plans', level: 1 })).toBeVisible();
  await expect(o.getByRole('link', { name: s.plans.visible })).toBeVisible();
  await expect(o.getByText(s.plans.hidden)).toHaveCount(0);
  await expectNoMineView(o);
  await expectNoWriteControls(o);

  await o.goto(`/p/${s.project.key}/approvals`);
  await expect(o.getByRole('heading', { name: 'Approval records', level: 1 })).toBeVisible();
  for (const v of s.visible) {
    await expect(o.getByRole('link', { name: v.title, exact: true })).toBeVisible();
  }
  await expect(o.getByText(s.hidden[0]!.title)).toHaveCount(0);
  await expectNoMineView(o);
  await expectNoWriteControls(o);

  await o.goto(`/p/${s.project.key}/runs`);
  await expect(o.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
  // Two runs exist; the one scoped to C1 is withheld (header row + one run).
  await expect(o.getByRole('row')).toHaveCount(2);
  await expectNoMineView(o);
  await expectNoWriteControls(o);

  // ── 7. C1 by its key is not-found ───────────────────────────────────────────
  const c1 = await o.goto(`/p/${s.project.key}/items/${s.hidden[0]!.key}`);
  expect(c1?.status()).toBe(404);
  await expect(o.getByText(s.hidden[0]!.title)).toHaveCount(0);

  // ── 8. Searching for C1 finds nothing; E shows no child count ───────────────
  await o.goto(`/p/${s.project.key}/items?q=${encodeURIComponent(s.visible[0]!.title)}`);
  // The positive control: the search works, so the negative below means something.
  await expect(
    o.getByRole('link', { name: `${s.visible[0]!.key} ${s.visible[0]!.title}` }),
  ).toBeVisible();
  await o.goto(`/p/${s.project.key}/items?q=${encodeURIComponent(s.hidden[0]!.title)}`);
  await expect(o.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
  await expect(o.getByRole('link', { name: new RegExp(s.hidden[0]!.key) })).toHaveCount(0);
  await expect(o.getByText(s.hidden[0]!.title)).toHaveCount(0);
  await o.goto(`/p/${s.project.key}/tree`);
  const epicRow = o.getByRole('row').filter({ hasText: s.privateEpic.key });
  await expect(epicRow.getByTestId('epic-not-public-pill')).toBeVisible();
  await expect(epicRow.getByRole('button', { name: 'Expand row' })).toHaveCount(0);

  // ── 9. No other person's email in anything the reader received ──────────────
  const bodies = await Promise.all(scan.bodies);
  const forbidden = s.otherEmails.flatMap((e) => [e, `${e.split('@')[0]}@`]);
  const leaks = forbidden.filter((needle) => bodies.some((b) => b.includes(needle)));
  // The count is named on the report, so a scan that silently shrank is visible.
  const scanned = `${bodies.length} responses scanned for ${forbidden.length} needles`;
  test.info().annotations.push({ type: 'no-email scan', description: scanned });
  console.warn(`[cloud-visitor] ${scanned}`);
  expect(bodies.length, scanned).toBeGreaterThan(20);
  expect(leaks, `another person's address reached the Visitor (${scanned})`).toEqual([]);

  // ── 10. A new browser, the same reader: not asked again ─────────────────────
  await octx.close();
  const again = await browser.newContext();
  const o2 = await again.newPage();
  await o2.goto(link);
  await signInForm(o2, s.outsider.email);
  await o2.waitForURL((u) => u.pathname === `/p/${s.project.key}/board`);
  await expect(o2.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
  await expect(o2.getByRole('heading', { name: 'Boards', level: 1 })).toBeVisible();
  expect(await visitorCount(s.project.id)).toBe(1);

  // ── 11. A members-mode project's Visitor URL: not-found, never a sign-in ────
  const signedOut = await (await browser.newContext()).newPage();
  const vault = `/p/${s.membersOnly.key}/board`;
  const outRes = await signedOut.goto(vault);
  expect(outRes?.status()).toBe(404);
  expect(new URL(signedOut.url()).pathname).toBe(vault);
  const inRes = await o2.goto(vault);
  expect(inRes?.status()).toBe(404);
  expect(new URL(o2.url()).pathname).toBe(vault);

  // ── 12. The Manager following the link lands in their own board ─────────────
  await manager.goto(link);
  await manager.waitForURL((u) => u.pathname === '/boards');
  await expect(manager.getByRole('heading', { name: 'Boards', level: 1 })).toBeVisible();
  await expect(manager.getByRole('status').filter({ hasText: 'You’re watching' })).toHaveCount(0);

  // ── 13. The Visitors section lists the reader with their email ──────────────
  await manager.goto('/settings/project/members');
  await expect(manager.getByRole('heading', { name: 'Visitors' })).toBeVisible();
  const row = manager
    .getByRole('main')
    .getByTestId('project-visitors')
    .getByRole('listitem')
    .first();
  await expect(row).toContainText(s.outsider.name);
  await expect(row).toContainText(s.outsider.email);
  for (const label of ['First visit', 'Latest visit', 'Agreed']) {
    await expect(row).toContainText(label);
  }

  for (const p of [manager, o2, signedOut]) await p.context().close();
});

test('the empty states: a Visitors list nobody is on, and a room with no records', async ({
  browser,
}) => {
  // Harbor is public and nobody has visited it. The Manager enters it through its
  // own Visitor link (the member redirect makes it their active project).
  const manager = await signedInAs(browser, s.manager.email);
  await manager.goto(`/p/${s.quiet.key}/board`);
  await manager.waitForURL((u) => u.pathname === '/boards');
  await manager.goto('/settings/project/members');
  await expect(manager.getByRole('heading', { name: 'Visitors' })).toBeVisible();
  // Scoped to the live page: a settings navigation can leave the previous
  // subtree mounted (hidden) for a moment, and both copies carry the text.
  await expect(manager.locator('#main').getByText('No one has visited yet')).toBeVisible();
  await expect(manager.getByRole('main').getByTestId('project-visitors')).toHaveCount(0);

  // The outsider consents to Harbor and opens its Runs: a room with no records.
  const o = await (await browser.newContext()).newPage();
  await o.goto(`/p/${s.quiet.key}/runs`);
  await signInForm(o, s.outsider.email);
  await o.waitForURL((u) => u.pathname === `/p/${s.quiet.key}/consent`);
  const consent = o.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/p/${s.quiet.key}/consent`),
  );
  await o.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await o.waitForURL((u) => u.pathname === `/p/${s.quiet.key}/runs`);
  await expect(o.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
  await expect(o.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
  await expect(o.getByRole('heading', { name: 'Nothing has run yet', level: 2 })).toBeVisible();
  await expect(o.getByRole('row')).toHaveCount(0);

  for (const p of [manager, o]) await p.context().close();
});
