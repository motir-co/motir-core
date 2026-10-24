import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPendingRequests,
  seedVisitorProject,
  VISITOR_PASSWORD,
  type PendingRequestsSeed,
  type VisitorSeed,
} from './_helpers/visitor-seed';

// ⚠️ THE ACCEPTANCE WALK FOR THE VISITOR'S REQUESTED FEATURES (Story MOTIR-6171 ·
// Subtask MOTIR-6770) — the in-app half of the story. motir.co's public request
// board is retired; a public project's pending requests are read, and voted on,
// by a signed-in Visitor inside the app. Paced for a person to watch:
//
//   1. a signed-out reader opens the view, signs in, consents, and lands on it;
//   2. the list: only the pending requests, by votes, submitters by name;
//   3. an upvote that survives a reload, and is taken back.
//
// The second test walks the rest unpaced — no Manager control and no "triage",
// the 429, the empty state, a member's redirect to their own inbox, and a
// project that is not public. Both run against the real app and datastore.
//
// ⚠️ THE VOTE IS ASSERTED THREE WAYS, because an optimistic toggle can look
// right while nothing was written: the POST's own answer, the rendered count
// after a RELOAD (a server read), and the `public_request_vote` row itself.

let s: VisitorSeed;
let r: PendingRequestsSeed;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  s = await seedVisitorProject('rf');
  r = await seedPendingRequests(s);
});

const viewPath = (key: string) => `/p/${key}/requested-features`;

/** The shipped sign-in form, driven from wherever the Visitor link sent us. */
async function signInHere(page: Page, email: string): Promise<void> {
  await expect(page.getByRole('main').getByPlaceholder('Email address')).toBeVisible();
  await page.getByRole('main').getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(VISITOR_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function consentAndLand(page: Page, key: string): Promise<void> {
  await page.waitForURL((u) => u.pathname === `/p/${key}/consent`);
  const consent = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes(`/p/${key}/consent`),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await page.waitForURL((u) => u.pathname === viewPath(key));
}

const rowOf = (page: Page, key: string) =>
  page.getByRole('main').getByTestId(`requested-feature-${key}`);
const toggleOf = (page: Page, key: string) => rowOf(page, key).getByRole('button');

const votesOf = (workItemId: string) =>
  adminDb.publicRequestVote.count({ where: { workItemId, userId: s.outsider.id } });

/** Arm BEFORE the click: the POST's answer is the write's authoritative signal. */
const upvoteAnswer = (page: Page, workItemId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      res.url().endsWith(`/api/public-requests/${workItemId}/upvote`),
  );

test('a Visitor reads a public project’s pending requests and backs one', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY.
  acceptanceStory('MOTIR-6171');
  const key = s.project.key;
  const [top, , target] = r.shown as [
    PendingRequestsSeed['shown'][number],
    PendingRequestsSeed['shown'][number],
    PendingRequestsSeed['shown'][number],
  ];

  // Every same-origin document and API answer this view produces, for the scan.
  const bodies: string[] = [];
  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'document' && type !== 'fetch' && type !== 'xhr') return;
    try {
      bodies.push(await res.text());
    } catch {
      // A redirect has no body to read.
    }
  });

  await chapter('A signed-out reader opens the project’s Requested features', async () => {
    await page.context().clearCookies();
    await page.goto(viewPath(key));
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await expect(page.getByText(top.title)).toHaveCount(0);
  });

  await chapter('They sign in and agree to be seen', async () => {
    await signInHere(page, s.outsider.email);
    await expect(
      page.getByRole('heading', { name: `Before you watch ${s.project.name}` }),
    ).toBeVisible();
    await beat();
    await consentAndLand(page, key);
  });

  await chapter('The pending requests, most-voted first, by name only', async () => {
    await expect(page.getByRole('heading', { name: 'Requested features', level: 1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'You’re watching' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Requested features', exact: true })).toBeVisible();

    const rows = page.getByRole('list', { name: 'Pending feature requests' }).getByRole('listitem');
    await expect(rows).toHaveCount(r.shown.length);
    for (const [i, want] of r.shown.entries()) {
      await expect(rows.nth(i)).toContainText(want.key);
      await expect(rows.nth(i)).toContainText(want.title);
      await expect(rows.nth(i)).toContainText(want.by);
      await expect(rows.nth(i).getByRole('button')).toContainText(String(want.votes));
    }
    for (const gone of r.hidden) await expect(page.getByText(gone.title)).toHaveCount(0);
    await beat();
  });

  await chapter('They upvote one — the count rises and the vote is theirs', async () => {
    const before = await toggleOf(page, target.key).getAttribute('aria-pressed');
    expect(before).toBe('false');
    const answer = upvoteAnswer(page, target.id);
    await toggleOf(page, target.key).click();
    const res = await answer;
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ voted: true, voteCount: target.votes + 1 });
    await expect(toggleOf(page, target.key)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggleOf(page, target.key)).toContainText(String(target.votes + 1));
    expect(await votesOf(target.id)).toBe(1);
    await beat();
  });

  await chapter('After a reload the vote is still there', async () => {
    await page.reload();
    await expect(toggleOf(page, target.key)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggleOf(page, target.key)).toContainText(String(target.votes + 1));
    await beat();
  });

  await chapter('Pressed again, the vote is taken back', async () => {
    const answer = upvoteAnswer(page, target.id);
    await toggleOf(page, target.key).click();
    expect(await (await answer).json()).toEqual({ voted: false, voteCount: target.votes });
    await expect(toggleOf(page, target.key)).toHaveAttribute('aria-pressed', 'false');
    await expect(toggleOf(page, target.key)).toContainText(String(target.votes));
    expect(await votesOf(target.id)).toBe(0);
    await beat();
  });

  // No other person's address anywhere this view answered — the page's HTML or
  // any of its reads. The signed-in Visitor's own may appear (their account).
  expect(bodies.length).toBeGreaterThan(2);
  for (const email of s.otherEmails) {
    expect(
      bodies.filter((b) => b.includes(email)),
      `${email} in a Requested features payload`,
    ).toEqual([]);
  }
  expect(await page.content()).not.toMatch(/vis-(manager|fran|nameless)-/);
});

test('the view’s edges — no Manager act, a 429, the empty state, a member, a private project', async ({
  page,
}) => {
  const key = s.project.key;
  const target = r.shown[2]!;

  // The Visitor from the receipt has consented already; sign them straight in.
  await signIn(page, s.outsider.email, VISITOR_PASSWORD);
  await page.goto(viewPath(key));
  await expect(page.getByRole('heading', { name: 'Requested features', level: 1 })).toBeVisible();

  // ── No Manager act, and no "triage" in the text or the address ─────────────
  for (const act of [/accept/i, /promote/i, /decline/i, /merge/i, /snooze/i]) {
    await expect(page.getByRole('button', { name: act })).toHaveCount(0);
  }
  expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('triage');
  expect(page.url().toLowerCase()).not.toContain('triage');

  // ── A 429 on the vote restores the row and says so ─────────────────────────
  await page.route('**/api/public-requests/*/upvote', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: '{"code":"RATE_LIMITED"}',
    }),
  );
  await toggleOf(page, target.key).click();
  await expect(rowOf(page, target.key)).toContainText('You’re voting a little too fast');
  await expect(toggleOf(page, target.key)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggleOf(page, target.key)).toContainText(String(target.votes));
  await page.unroute('**/api/public-requests/*/upvote');
  expect(await votesOf(target.id)).toBe(0);

  // ── The empty state, on a public project nothing is pending in ─────────────
  await page.goto(viewPath(s.quiet.key));
  await consentAndLand(page, s.quiet.key);
  await expect(page.getByRole('main').getByTestId('requested-features-empty')).toContainText(
    'Nothing is waiting for a vote',
  );

  // ── A project that is not public is not found ──────────────────────────────
  const hidden = await page.goto(viewPath(s.membersOnly.key));
  expect(hidden?.status()).toBe(404);

  // ── A member is sent to their own Triage inbox, unasked (MOTIR-7043) ───────
  await page.context().clearCookies();
  await signIn(page, s.otherEmails[1]!, VISITOR_PASSWORD);
  await page.goto(viewPath(key));
  await page.waitForURL((u) => u.pathname === '/triage');
  await expect(page.getByRole('heading', { name: 'Triage', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Before you watch/ })).toHaveCount(0);
});
