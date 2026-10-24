import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedVisitorProject, VISITOR_PASSWORD, type VisitorSeed } from './_helpers/visitor-seed';

// ⚠️ THE ACCEPTANCE WALK FOR THE VISITOR VIEW (Story MOTIR-6170 · Subtask
// MOTIR-6651) — the story's `## Verification` recipe, paced for a person to watch:
// a Manager copies the project's Visitor link, a reader from another organisation
// opens it signed out, signs in, is told their name and email go to the project's
// Managers, continues, and walks the read-only views; they are not asked twice;
// and the Manager then sees them in the Visitors list with their email.
//
// The video shows the card's steps 1–3, 5–7, 10 and 13. The rest of the walk —
// Go back recording nothing, the list search, the scan of every response for
// another person's email, the members-mode project, the member redirect and the
// empty states — is `cloud-visitor.spec.ts`, in the cloud lane, where the same
// seed is walked without pacing.
//
// ⚠️ ONE BROWSER CONTEXT, THREE PEOPLE. A context opened with `browser.newContext()`
// is not recorded, so the walk changes WHO is signed in by clearing the cookies of
// the recorded page — a signed-out browser in every sense the server can see.
//
const BOARD_HEADING = 'Boards';

let s: VisitorSeed;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  s = await seedVisitorProject('acc');
});

/** The shipped sign-in form, driven from wherever the Visitor link sent us. */
async function signInHere(page: Page, email: string): Promise<void> {
  await expect(page.getByRole('main').getByPlaceholder('Email address')).toBeVisible();
  await page.getByRole('main').getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(VISITOR_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

/** Nothing on the page offers to change the project (the gated write controls). */
async function expectNoWriteControls(page: Page): Promise<void> {
  for (const name of [/^New work item$/, /^Create work item$/, /^Edit$/, /^Delete$/]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: /^Edit$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Approve|Request changes)$/ })).toHaveCount(0);
}

test('a reader outside the organisation watches a public project, and its Manager sees them', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
  baseURL,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6170');
  let link = '';

  await chapter('The Manager copies the project’s Visitor link', async () => {
    await signIn(page, s.manager.email, VISITOR_PASSWORD);
    await page.goto('/settings/project/public');
    await expect(page.getByRole('heading', { name: 'Visitor link' })).toBeVisible();
    link = (await page.getByRole('main').getByTestId('visitor-link-url').innerText()).trim();
    expect(link).toBe(`${baseURL}/p/${s.project.key}/board`);
    await beat();
  });

  await chapter('A signed-out reader opens it and is asked to sign in', async () => {
    await page.context().clearCookies();
    await page.goto(link);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await expect(page.getByRole('main').getByPlaceholder('Email address')).toBeVisible();
    // Nothing of the project is on the sign-in page.
    await expect(page.getByText(s.visible[0]!.title)).toHaveCount(0);
  });

  await chapter('Signed in, they are told who will see their name and email', async () => {
    await signInHere(page, s.outsider.email);
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/consent`);
    await expect(
      page.getByRole('heading', { name: `Before you watch ${s.project.name}` }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText(/will be visible to/)).toBeVisible();
    await expect(
      page.getByRole('main').getByText(s.outsider.email, { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
    // Long enough to read the sentence.
    await beat();
  });

  await chapter('Continue: the board, read-only, under the Visitor banner', async () => {
    const consent = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/p/${s.project.key}/consent`),
    );
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    expect((await consent).status()).toBe(200);
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/board`);

    await expect(page.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
    await expect(page.getByRole('heading', { name: BOARD_HEADING, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Open ${s.visible[0]!.key}: ${s.visible[0]!.title}` }),
    ).toBeVisible();
    // No switcher, no create door, no settings — the Visitor chrome.
    await expect(page.getByRole('button', { name: 'Switch project' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expectNoWriteControls(page);
    // The private epic is on the board, marked, with nothing of what is under it.
    await expect(page.getByRole('main').getByTestId('epic-not-public-pill')).toBeVisible();
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
    await beat();
  });

  await chapter('The work items, as a list and as a tree', async () => {
    await page.getByRole('link', { name: 'Work Items', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/items`);
    await expect(page.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
    await expect(
      page.getByRole('link', { name: `${s.visible[0]!.key} ${s.visible[0]!.title}` }),
    ).toBeVisible();
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
    await expectNoWriteControls(page);

    await page.goto(`/p/${s.project.key}/tree`);
    await expect(
      page.getByRole('link', { name: `${s.visibleEpic.key} ${s.visibleEpic.title}` }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByTestId('epic-not-public-pill')).toBeVisible();
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
  });

  await chapter('The roadmap', async () => {
    await page.getByRole('link', { name: 'Roadmap', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/roadmap`);
    await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
    await expect(page.getByText(s.visibleEpic.title).first()).toBeVisible();
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
  });

  await chapter('A visible story, read-only', async () => {
    const story = s.visible[0]!;
    await page.goto(`/p/${s.project.key}/items/${story.key}`);
    await expect(page.getByRole('heading', { name: story.title, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Status — You have read-only access/ }),
    ).toBeVisible();
    // A Visitor acts on nothing: no Watch control, and no item plan history
    // (the Plans room is the Visitor's plan surface).
    await expect(page.getByRole('button', { name: /^Watch/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Plans', level: 2 })).toHaveCount(0);
    await expectNoWriteControls(page);
  });

  await chapter('Plans, Approval records and Runs — only what touches visible work', async () => {
    await page.getByRole('link', { name: 'Plans', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/plans`);
    await expect(page.getByRole('heading', { name: 'Plans', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: s.plans.visible })).toBeVisible();
    await expect(page.getByText(s.plans.hidden)).toHaveCount(0);

    await page.getByRole('link', { name: 'Approval records', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/approvals`);
    await expect(page.getByRole('heading', { name: 'Approval records', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: s.visible[0]!.title, exact: true })).toBeVisible();
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
    await expectNoWriteControls(page);

    await page.getByRole('link', { name: 'Runs', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/runs`);
    await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
    // Two runs exist; the one scoped to the private epic's child is withheld.
    await expect(page.getByRole('row')).toHaveCount(2);
  });

  await chapter('A private epic’s child is not found', async () => {
    const res = await page.goto(`/p/${s.project.key}/items/${s.hidden[0]!.key}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(s.hidden[0]!.title)).toHaveCount(0);
    await beat();
  });

  await chapter('Coming back later: straight to the board, not asked again', async () => {
    await page.context().clearCookies();
    await page.goto(link);
    await signInHere(page, s.outsider.email);
    await page.waitForURL((u) => u.pathname === `/p/${s.project.key}/board`);
    await expect(page.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
    await expect(page.getByRole('heading', { name: BOARD_HEADING, level: 1 })).toBeVisible();
  });

  await chapter('The Manager sees who visited, with their email', async () => {
    await page.context().clearCookies();
    await signIn(page, s.manager.email, VISITOR_PASSWORD);
    await page.goto('/settings/project/members');
    await expect(page.getByRole('heading', { name: 'Visitors' })).toBeVisible();
    const row = page
      .getByRole('main')
      .getByTestId('project-visitors')
      .getByRole('listitem')
      .first();
    await expect(row).toContainText(s.outsider.name);
    await expect(row).toContainText(s.outsider.email);
    await expect(row).toContainText('First visit');
    await expect(row).toContainText('Latest visit');
    await expect(row).toContainText('Agreed');
    await row.scrollIntoViewIfNeeded();
    await beat();
  });
});
