import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase, truncateJobTables } from './_helpers/db-reset';
import { SHELL_PASSWORD, signIn, signUp } from './_helpers/shell-session';

// THE SYSTEM TAB BELONGS TO PLATFORM STAFF — THE ACCEPTANCE RECEIPT (Story
// MOTIR-8196 · Subtask MOTIR-8202). The story's verification recipe, in a real
// browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Three people open Job runs on the organization settings home — the door a
// fresh single-workspace account lands on (`JobRunsFoldInSection`). A SUPPORT
// member of platform staff sees the System tab and the dead letter with no
// workspace, and is refused the replay. An OPERATOR replays it. A tenant OWNER
// (of the workspace and its organization) sees no System tab at all, and the
// tab's address falls back to the ordinary one. Then the operator's role is
// revoked and, with no sign-out, their next page load has no System tab.
//
// Nothing sets the retired admin-email variable: the lane no longer forwards it
// (MOTIR-8200), so the owner's chapter IS the "the variable grants nothing"
// case at this tier. The explicit "set to a non-staff email" proof is the
// integration matrix's (`tests/jobs/jobsPlatformGateMatrix.test.ts`).
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// A replay is a Server Action POSTed to `/settings/organization`: armed BEFORE
// the press, its status asserted, and the committed `replayedAt` polled from
// the database before the page is reloaded to read it back. A refused replay is
// polled the same way, for the stamp that must NOT appear. Roles are granted and
// revoked through `adminDb` — a fixture, not a product path: platform roles are
// granted out-of-band (`docs/decisions/platform-staff-auth.md` §6).

const STAMP = Date.now().toString(36);
const SUPPORT_EMAIL = `support-${STAMP}@motir.test`;
const OPERATOR_EMAIL = `operator-${STAMP}@motir.test`;
const OWNER_EMAIL = `owner-${STAMP}@tenant.test`;

const systemLink = (page: Page) => page.getByRole('link', { name: 'System', exact: true });
const systemDlqHeading = (page: Page) =>
  page.getByRole('heading', { name: 'Dead letters with no workspace', exact: true });
const systemDlqTable = (page: Page) => page.getByRole('table', { name: 'System dead letters' });
// The three sign-ups below queue their own emails, and in CI those can fail and
// dead-letter with no workspace while the spec runs — so the System tab may hold
// rows besides the seeded one. Every assertion reads the SEEDED row, found by
// the event name only it carries.
const SEEDED_EVENT = `email.send.acceptance-${STAMP}`;
const seededRow = (page: Page) =>
  systemDlqTable(page).getByRole('row').filter({ hasText: SEEDED_EVENT });

/** A Server Action POSTed to `pathname`. */
function serverAction(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse((res) => {
    const req = res.request();
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname
    );
  });
}

async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, SHELL_PASSWORD);
}

async function gotoJobRuns(page: Page): Promise<void> {
  await page.goto('/settings/organization');
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function openSystemTab(page: Page): Promise<void> {
  await gotoJobRuns(page);
  await expect(systemLink(page)).toBeVisible();
  await systemLink(page).click();
  await page.waitForURL(/tab=system/);
  await expect(systemDlqHeading(page)).toBeVisible();
}

/** The ordinary tab answers `?tab=system` for someone who may not have it. */
async function expectSystemTabRefused(page: Page): Promise<void> {
  await page.goto('/settings/organization?tab=system');
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(systemLink(page)).toHaveCount(0);
  await expect(systemDlqHeading(page)).toHaveCount(0);
}

async function replayedAt(dlqId: string): Promise<Date | null> {
  return (await adminDb.jobRunDlq.findUniqueOrThrow({ where: { id: dlqId } })).replayedAt;
}

let dlqId: string;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  await truncateJobTables();

  // Three accounts, each with its own auto-created workspace and organization —
  // so the owner below owns BOTH tiers, the most tenant standing there is.
  for (const email of [SUPPORT_EMAIL, OPERATOR_EMAIL, OWNER_EMAIL]) {
    await page.context().clearCookies();
    await signUp(page, email);
  }
  await adminDb.user.update({ where: { email: SUPPORT_EMAIL }, data: { platformRole: 'support' } });
  await adminDb.user.update({
    where: { email: OPERATOR_EMAIL },
    data: { platformRole: 'operator' },
  });

  // ONE dead letter with no workspace, the shape a password-reset delivery
  // leaves (`tests/jobs/dashboard-system-replay.test.ts`).
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: null,
      functionId: 'email.send',
      eventName: SEEDED_EVENT,
      eventData: {
        to: 'reset@example.com',
        template: 'password-reset',
        idempotencyKey: `pw-${STAMP}`,
      },
      failure: { message: 'SMTP_UNAVAILABLE' },
      attempts: 5,
    },
  });
  dlqId = row.id;
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('platform staff see the System tab, an operator replays, a tenant owner sees none, a revoke takes the tab away', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8196');
  test.setTimeout(300_000);

  await chapter('Support sees the System tab but cannot replay', async () => {
    await signInAs(page, SUPPORT_EMAIL);
    await openSystemTab(page);
    await expect(seededRow(page)).toBeVisible();
    await beat();

    const replay = serverAction(page, '/settings/organization');
    await seededRow(page).getByRole('button', { name: 'Replay' }).click();
    expect((await replay).status(), 'the refused replay still answers').toBe(200);
    await expect(
      page.getByText('Only the platform operator can replay system dead letters.').first(),
    ).toBeVisible();
    // The authoritative read: the stamp did not land.
    expect(await replayedAt(dlqId)).toBeNull();
    await beat();
  });

  await chapter('Operator replays a dead letter with no workspace', async () => {
    await signInAs(page, OPERATOR_EMAIL);
    await openSystemTab(page);

    const replay = serverAction(page, '/settings/organization');
    await seededRow(page).getByRole('button', { name: 'Replay' }).click();
    expect((await replay).status(), 'the replay').toBe(200);
    await expect.poll(() => replayedAt(dlqId), { timeout: 20_000 }).not.toBeNull();

    await page.reload();
    await expect(systemDlqHeading(page)).toBeVisible({ timeout: 30_000 });
    // A replayed row is a record, not a chore: its Replay control is gone.
    await expect(seededRow(page).getByRole('button', { name: 'Replay' })).toHaveCount(0);
    await beat();
  });

  await chapter('A tenant owner sees no System tab', async () => {
    await signInAs(page, OWNER_EMAIL);
    await gotoJobRuns(page);
    await expect(systemLink(page)).toHaveCount(0);
    await beat();
    await expectSystemTabRefused(page);
  });

  await chapter('Revoked role, tab gone on the next load', async () => {
    await signInAs(page, OPERATOR_EMAIL);
    await gotoJobRuns(page);
    await expect(systemLink(page)).toBeVisible();
    await beat();

    await adminDb.user.update({ where: { email: OPERATOR_EMAIL }, data: { platformRole: null } });

    // No sign-out: the same session, its next request.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(systemLink(page)).toHaveCount(0);
    await expectSystemTabRefused(page);
    await beat();
  });
});
