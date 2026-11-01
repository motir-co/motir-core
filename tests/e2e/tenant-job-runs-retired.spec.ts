// E2E: the tenant Job runs surface is RETIRED (Story MOTIR-9982 · MOTIR-10045) —
// the story gate over what its removal cards leave a signed-in person seeing.
//
//   1. A stale bookmark to `/settings/workspace/jobs` answers the ORDINARY 404,
//      for a workspace Manager and for a member who is not one: status 404, the
//      address unchanged (no redirect), and the same not-found page an unknown
//      settings address gives.
//   2. The workspace settings rail renders its remaining rows and no Job runs row.
//   3. The organization page renders its other sections and rail, and nothing of
//      Job runs (heading, tabs, dead-letter badge, replay control, link), for an
//      organization Admin and for a plain member.
//   4. The Members card still lists a pending invitation with its delivery state,
//      and Resend still works, on `/settings/workspace` AND in the organization
//      page's folded-in Members card.
//   5. The agent runs surface at `/runs` still renders.
//
// It does NOT re-test `/admin/jobs` (Story MOTIR-9980's specs) or the invitation
// internals (`acceptance-members-pending-invitations.spec.ts`, Story MOTIR-9981):
// it asserts only the removal's outcome.
//
// ── THE TENANT ──────────────────────────────────────────────────────────────
// `seedProjectAccess` (the MOTIR-6169 tenant): Maya owns the organization and
// manages "Northwind"; a second workspace, "Sales", reveals the workspace tier, so
// `/settings/workspace` is her own page. Fran is a Full member of Northwind only,
// so for her the tier stays hidden and Members folds into the organization page.
// Kai is promoted to organization Admin here, the role the org-scoped cards need.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal (the coding convention § E2E): the
// navigation's own response, a write's response armed before the press, a
// Postgres row, or a role-based locator. An absence is asserted only AFTER a
// presence that proves the page got there. Every locator rooted at `page` is
// role-based, because streamed pages keep the outgoing subtree mounted
// (MOTIR-5037). Nothing here counts job-ledger rows: the lane's job worker writes
// them throughout.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { actionWrite } from './_helpers/authoritative-signal';
import { signInAs } from './_helpers/project-access-flows';
import { seedProjectAccess, type ProjectAccessSeed } from './_helpers/project-access-seed';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';

test.describe.configure({ timeout: 180_000 });

/** The retired address — a stale bookmark is the only way anyone reaches it now. */
const RETIRED = '/settings/workspace/jobs';
/** An address under the same segment that never existed: the ordinary 404's baseline. */
const UNKNOWN = '/settings/workspace/no-such-pane';
const NOT_FOUND_HEADING = 'We couldn’t find that page';
/** First paint of a settings page on a cold lane server. */
const FIRST_PAINT = { timeout: 30_000 };

let seed: ProjectAccessSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedProjectAccess(`jr${Date.now().toString(36)}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Locators and reads ────────────────────────────────────────────────────────

const workspaceRail = (page: Page) => page.getByRole('navigation', { name: 'Workspace settings' });
const orgRail = (page: Page) => page.getByRole('navigation', { name: 'Organisation settings' });
const pendingBlock = (page: Page) => page.getByRole('region', { name: 'Pending invitations' });
const pendingRow = (page: Page, email: string) =>
  pendingBlock(page).getByRole('listitem').filter({ hasText: email });
const pill = (row: Locator) => row.locator('[data-delivery]');
const resendButton = (row: Locator, email: string) =>
  row.getByRole('button', { name: `Resend the invitation to ${email}` });

/** Links anywhere on the page that still point at the retired address. Read
 *  from the DOM, not a locator, and only after a presence has proved the page
 *  rendered, so an empty answer is a real absence. */
function linksToRetired(page: Page): Promise<number> {
  return page.evaluate((path) => document.querySelectorAll(`a[href*="${path}"]`).length, RETIRED);
}

/** Every trace of the retired surface a person could see or press, all absent. */
async function expectNoJobRuns(page: Page) {
  await expect(page.getByRole('heading', { name: /Job runs/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Job runs/i })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Recent runs|Dead letter|System/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Replay/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Dead letter/i })).toHaveCount(0);
  expect(await linksToRetired(page), `a link to ${RETIRED}`).toBe(0);
}

/**
 * Open `path` and prove it is the ordinary not-found page: 404 off the
 * navigation's own response, the address unchanged and reached by no redirect,
 * and the same heading and way out the UNKNOWN baseline renders.
 */
async function expectOrdinary404(page: Page, path: string, baselineAction: string) {
  const response = await page.goto(path);
  expect(response?.status(), `${path} status`).toBe(404);
  expect(response?.request().redirectedFrom() ?? null, `${path} was redirected`).toBeNull();
  expect(new URL(page.url()).pathname).toBe(path);
  await expect(page.getByRole('heading', { name: NOT_FOUND_HEADING })).toBeVisible(FIRST_PAINT);
  await expect(page.getByRole('link', { name: baselineAction, exact: true })).toBeVisible();
}

/** The not-found page's way-out link at UNKNOWN — the body every other 404 must match. */
async function baselineNotFound(page: Page): Promise<string> {
  const response = await page.goto(UNKNOWN);
  expect(response?.status(), `${UNKNOWN} status`).toBe(404);
  await expect(page.getByRole('heading', { name: NOT_FOUND_HEADING })).toBeVisible(FIRST_PAINT);
  const action = page.getByRole('link', { name: /^Go to / });
  await expect(action).toHaveCount(1);
  return (await action.innerText()).trim();
}

async function userId(email: string): Promise<string> {
  return (await adminDb.user.findUniqueOrThrow({ where: { email } })).id;
}

/**
 * One pending invitation from Maya to Cy, with its delivery recorded as
 * `delivered`. The lane's job worker sends it through the file provider and
 * writes the `email_delivery` row at `accepted`; no provider webhook runs here,
 * so the later state is written onto that row, as the MOTIR-9981 spec does.
 */
async function seedDeliveredInvite(): Promise<{ id: string; token: string }> {
  await workspaceInvitesService.sendInvite({
    inviterUserId: await userId(seed.manager.email),
    inviterName: seed.manager.name,
    workspaceId: seed.workspaceId,
    targetEmail: seed.contractor.email,
  });
  const invite = await newestInvite(1);
  const token = invite.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
  await expect
    .poll(() => adminDb.emailDelivery.count({ where: { idempotencyKey: token } }), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await adminDb.emailDelivery.updateMany({
    where: { idempotencyKey: token },
    data: { state: 'delivered' },
  });
  return { id: invite.id, token };
}

/** The newest invite row for the contractor, once there are `count` of them. */
async function newestInvite(count: number) {
  const rows = () =>
    adminDb.verification.findMany({
      where: {
        identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
        value: { contains: seed.contractor.email },
      },
      orderBy: { createdAt: 'desc' },
    });
  await expect.poll(async () => (await rows()).length).toBe(count);
  return (await rows())[0]!;
}

/**
 * The seeded invitation is listed with its delivery state; Resend answers 200
 * and the row now carries the NEW invitation, once.
 */
async function expectPendingAndResend(page: Page, pathname: string, inviteId: string) {
  const email = seed.contractor.email;
  const row = pendingRow(page, email);
  await expect(row).toHaveCount(1, FIRST_PAINT);
  await expect(row).toContainText(`Invited by ${seed.manager.name}`);
  await expect(pill(row)).toHaveText('Delivered');

  const written = actionWrite(page, pathname, inviteId);
  await resendButton(row, email).click();
  expect((await written).status(), 'the Resend').toBe(200);

  const resent = await newestInvite(2);
  expect(resent.id).not.toBe(inviteId);
  await expect(pendingBlock(page).getByTestId(`pending-invite-${resent.id}`)).toBeVisible();
  await expect(pendingRow(page, email)).toHaveCount(1);
  await expect(pill(pendingRow(page, email))).toHaveText(/^(Queued|Accepted)$/);
}

// ═══ 1 · The stale bookmark ══════════════════════════════════════════════════

test('a workspace Manager’s stale bookmark to Job runs answers the ordinary 404, with no redirect', async ({
  page,
}) => {
  await signInAs(page, seed.manager.email);
  const action = await baselineNotFound(page);
  await expectOrdinary404(page, RETIRED, action);
});

test('a member who is not a Manager gets the same ordinary 404', async ({ page }) => {
  await signInAs(page, seed.fran.email);
  const action = await baselineNotFound(page);
  await expectOrdinary404(page, RETIRED, action);
});

// ═══ 2 · The workspace rail ══════════════════════════════════════════════════

test('the workspace settings rail renders its remaining rows and no Job runs row', async ({
  page,
}) => {
  await signInAs(page, seed.manager.email);
  const response = await page.goto('/settings/workspace');
  expect(response?.status()).toBe(200);

  const rail = workspaceRail(page);
  await expect(rail.getByRole('link', { name: 'Workspace', exact: true })).toBeVisible(FIRST_PAINT);
  await expect(rail.getByRole('link', { name: 'Security', exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Roles & permissions', exact: true })).toBeVisible();
  // Public address is the fourth remaining row, cloud-only (MOTIR-9514): the main
  // lane runs off-cloud, where that room does not exist and its row is dropped.
  await expect(rail).not.toContainText('Job runs');
  await expect(rail).not.toContainText('Operations');
  await expectNoJobRuns(page);
});

// ═══ 3 · The organization page ═══════════════════════════════════════════════

test('an organization Admin’s organization page renders its sections and rail, and no Job runs', async ({
  page,
}) => {
  const promoted = await adminDb.organizationMembership.updateMany({
    where: { userId: await userId(seed.kai.email) },
    data: { role: 'admin' },
  });
  expect(promoted.count, 'Kai’s organization membership').toBe(1);
  await signInAs(page, seed.kai.email);
  const response = await page.goto('/settings/organization');
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible(FIRST_PAINT);
  const rail = orgRail(page);
  await expect(rail.getByRole('link', { name: 'Organisation', exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Members', exact: true })).toBeVisible();
  await expect(rail).not.toContainText('Job runs');
  await expectNoJobRuns(page);
});

test('a plain member’s organization page renders the folded-in workspace sections, and no Job runs', async ({
  page,
}) => {
  await signInAs(page, seed.fran.email);
  const response = await page.goto('/settings/organization');
  expect(response?.status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'Workspace configuration', level: 2 }),
  ).toBeVisible(FIRST_PAINT);
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
  await expect(
    orgRail(page).getByRole('link', { name: 'Organisation', exact: true }),
  ).toBeVisible();
  await expect(orgRail(page)).not.toContainText('Job runs');
  await expectNoJobRuns(page);
});

// ═══ 4 · Pending invitations and Resend, in both homes ═══════════════════════

test('the Members card on /settings/workspace lists a pending invitation with its delivery state, and Resend works', async ({
  page,
}) => {
  const invite = await seedDeliveredInvite();
  await signInAs(page, seed.manager.email);
  const response = await page.goto('/settings/workspace');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible(FIRST_PAINT);

  await expectPendingAndResend(page, '/settings/workspace', invite.id);
});

test('the same invitation, delivery state and Resend appear in the organization page’s folded-in Members card', async ({
  page,
}) => {
  const invite = await seedDeliveredInvite();
  // Fran's Northwind is her only workspace, so its Members card is the
  // organization page's fold-in; a Full member may resend a Full invitation.
  await signInAs(page, seed.fran.email);
  const response = await page.goto('/settings/organization');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible(FIRST_PAINT);

  await expectPendingAndResend(page, '/settings/organization', invite.id);
});

// ═══ 5 · The agent runs surface ══════════════════════════════════════════════

test('the agent runs surface at /runs still renders', async ({ page }) => {
  await signInAs(page, seed.manager.email);
  const response = await page.goto('/runs');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible(FIRST_PAINT);
});
