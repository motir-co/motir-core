// Acceptance E2E — A workspace Manager sees pending invitations with their delivery
// state and can Resend them on the Members card (Story MOTIR-9981 · MOTIR-9999; design
// `design/settings/members-pending-invitations--pending-list.mock.html`). The receipt a
// person watches to accept the story, walking its Verification recipe:
//
//   THE RECORDED WALK (one test, seven chapters). With nothing sent the Members card has
//   no Pending block; an invite sent from the Invite modal is listed with its inviter,
//   sent date, scope, expiry and delivery state; a delivered email reaches the pill;
//   Resend sends a new invitation, and in the invitee's browser the new link opens the
//   invite while the old one shows "This invite has expired"; a second Resend succeeds
//   and the third in the hour is refused with the 3-per-hour message and writes nothing;
//   and once the invitee accepts, the row is gone.
//
//   THE REST (unrecorded). A Full non-Manager sees Resend enabled on a Full row and
//   disabled, with its tooltip, on a Limited one, while a Limited member sees no block;
//   and a Manager whose organization holds ONE workspace sees the block in the
//   organization page's fold-in.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts. The lane's job worker sends each invite
// through the file email provider and records its `email_delivery` row at `accepted`;
// no provider webhook runs here, so `delivered` is written onto that row through the
// db helper. The state-to-label mapping is the component and integration cards' proof:
// this spec asserts only that a written state reaches the screen.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the press that
// causes it, a Postgres row, or a role-based locator. An absence is asserted only
// AFTER a presence that proves the page got there. `beat()` and the chapter hold are
// pacing, taken after the assertion that proved the step.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made.
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { actionWrite } from './_helpers/authoritative-signal';
import { signInAs } from './_helpers/project-access-flows';
import {
  PA_PASSWORD,
  seedProjectAccess,
  type ProjectAccessSeed,
} from './_helpers/project-access-seed';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';

test.describe.configure({ timeout: 300_000 });

let seed: ProjectAccessSeed;
let slug = '';

test.beforeEach(async () => {
  await resetDatabase();
  slug = `pi${Date.now().toString(36)}`;
  seed = await seedProjectAccess(slug);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Locators and reads ────────────────────────────────────────────────────────

const pendingBlock = (page: Page) => page.getByRole('region', { name: 'Pending invitations' });
const pendingRow = (page: Page, email: string) =>
  pendingBlock(page).getByRole('listitem').filter({ hasText: email });
const pill = (row: Locator) => row.locator('[data-delivery]');
const resendButton = (scope: Page | Locator, email: string) =>
  scope.getByRole('button', { name: `Resend the invitation to ${email}` });

/** Every invite row ever written for `email`, newest first — retired ones included. */
async function inviteRows(email: string) {
  return adminDb.verification.findMany({
    where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX }, value: { contains: email } },
    orderBy: { createdAt: 'desc' },
  });
}
type InviteRow = Awaited<ReturnType<typeof inviteRows>>[number];
const tokenOf = (row: { identifier: string }) =>
  row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);

/** The newest invite row for `email`, once there are `count` of them. */
async function newestInvite(email: string, count: number) {
  await expect.poll(async () => (await inviteRows(email)).length).toBe(count);
  return (await inviteRows(email))[0]!;
}

/** The `email_delivery` row the job worker records for `token`'s send. */
async function deliveryOf(token: string) {
  await expect
    .poll(async () => adminDb.emailDelivery.count({ where: { idempotencyKey: token } }), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
}

/** "Oct 28" as the row prints it — in UTC or the runner's own zone, whichever renders. */
function todayLabels(): string[] {
  const now = new Date();
  const fmt = (timeZone?: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(now);
  return [...new Set([fmt('UTC'), fmt()])];
}

async function openMembers(page: Page) {
  await page.goto('/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText(seed.fran.name, { exact: true }).first()).toBeVisible();
}

/** Send an invite through the real Invite modal; resolves once the POST answered 200. */
async function sendInvite(page: Page, email: string, limitedProject?: string) {
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email address').fill(email);
  if (limitedProject) {
    await dialog.getByRole('radio', { name: /^Limited/ }).click();
    await dialog.getByRole('combobox', { name: 'Projects to join' }).click();
    await dialog.getByRole('option', { name: new RegExp(`^${limitedProject} · `) }).click();
    await expect(
      dialog.getByRole('button', { name: new RegExp(`^Remove ${limitedProject} · `) }),
    ).toBeVisible();
  }
  const sent = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/workspaces/${seed.workspaceId}/invites` &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  expect((await sent).status(), 'the invite').toBe(200);
  await expect(page.getByText(`Invite sent to ${email}`, { exact: true }).first()).toBeVisible();
}

/** Press Resend on `inviteId`'s row; resolves once the server action answered 200. */
async function pressResend(page: Page, email: string, inviteId: string) {
  const written = actionWrite(page, '/settings/workspace', inviteId);
  await resendButton(pendingRow(page, email), email).click();
  expect((await written).status(), 'the Resend').toBe(200);
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('A Manager sees a pending invite with its delivery state, Resends it, the old link dies, and the third send is refused', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9981');
  const invitee = seed.contractor;
  // The three invitations the walk sends to one address, oldest first.
  let first: InviteRow | undefined;
  let second: InviteRow | undefined;
  let third: InviteRow | undefined;

  // ── 1 · NOTHING PENDING ───────────────────────────────────────────────────
  await chapter('With nothing sent, the Members card has no Pending invitations', async () => {
    await signInAs(page, seed.manager.email);
    await openMembers(page);
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).toHaveCount(0);
    await expect(page.getByTestId('pending-invitations')).toHaveCount(0);
    await beat();
  });

  // ── 2 · AN INVITE IS LISTED ───────────────────────────────────────────────
  await chapter('An invite sent from the Invite modal is listed under Pending', async () => {
    await sendInvite(page, invitee.email);
    const row = pendingRow(page, invitee.email);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(
      new RegExp(`Invited by ${seed.manager.name}, (${todayLabels().join('|')})`),
    );
    await expect(row).toContainText('Full');
    await expect(row).toContainText(/Expires in [67] days/);
    // Queued until the job worker hands it to the provider, Accepted after.
    await expect(pill(row)).toHaveText(/^(Queued|Accepted)$/);
    first = await newestInvite(invitee.email, 1);
    await beat();
  });

  // ── 3 · THE DELIVERY STATE REACHES THE PILL ───────────────────────────────
  await chapter('A delivered email shows as Delivered on the row', async () => {
    await deliveryOf(tokenOf(first!));
    await adminDb.emailDelivery.updateMany({
      where: { idempotencyKey: tokenOf(first!) },
      data: { state: 'delivered' },
    });
    await page.reload();
    const row = pendingRow(page, invitee.email);
    await expect(pill(row)).toHaveText('Delivered', { timeout: FIRST_PAINT_MS });
    await expect(row).not.toContainText(/inbox/i);
    await beat();
  });

  // ── 4 · RESEND ────────────────────────────────────────────────────────────
  await chapter('Resend sends a new invitation in place of the old one', async () => {
    await pressResend(page, invitee.email, first!.id);
    await expect(
      page.getByText(`New invitation sent to ${invitee.email}`, { exact: true }).first(),
    ).toBeVisible();
    const resent = await newestInvite(invitee.email, 2);
    expect(resent.createdAt.getTime()).toBeGreaterThan(first!.createdAt.getTime());
    // The refreshed list carries the NEW invite, once, with the inviter unchanged.
    await expect(pendingBlock(page).getByTestId(`pending-invite-${resent.id}`)).toBeVisible();
    const row = pendingRow(page, invitee.email);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`Invited by ${seed.manager.name}`);
    await expect(pill(row)).toHaveText(/^(Queued|Accepted)$/);
    second = resent;
    await beat();
  });

  // ── 5 · THE NEW LINK WORKS, THE OLD ONE IS DEAD ───────────────────────────
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await chapter(
    'In the invitee’s browser the new link opens and the old one has expired',
    async () => {
      await signIn(inviteePage, invitee.email, PA_PASSWORD);
      await inviteePage.goto(`/invite/accept?token=${encodeURIComponent(tokenOf(second!))}`);
      await expect(inviteePage.getByRole('heading', { name: 'Join Northwind' })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(inviteePage.getByRole('button', { name: 'Accept invite' })).toBeVisible();
      await beat();
      await inviteePage.goto(`/invite/accept?token=${encodeURIComponent(tokenOf(first!))}`);
      await expect(
        inviteePage.getByRole('heading', { name: 'This invite has expired' }),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await beat();
    },
  );

  // ── 6 · THE THIRD SEND IN THE HOUR IS REFUSED ─────────────────────────────
  await chapter('A second Resend succeeds; the third in the hour is refused', async () => {
    await pressResend(page, invitee.email, second!.id);
    await expect(
      page.getByText(`New invitation sent to ${invitee.email}`, { exact: true }).first(),
    ).toBeVisible();
    const latest = await newestInvite(invitee.email, 3);
    await expect(pendingBlock(page).getByTestId(`pending-invite-${latest.id}`)).toBeVisible();
    await beat();

    await pressResend(page, invitee.email, latest.id);
    await expect(
      page.getByText('Limit reached: 3 invitations per address per hour.', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText('Try again later.', { exact: true }).first()).toBeVisible();
    // Nothing was written, and the row is the same invitation.
    expect(await inviteRows(invitee.email)).toHaveLength(3);
    await expect(pendingBlock(page).getByTestId(`pending-invite-${latest.id}`)).toBeVisible();
    third = latest;
    await beat();
  });

  // ── 7 · ACCEPTED, AND GONE ────────────────────────────────────────────────
  await chapter('Once the invitee accepts, the row leaves Pending invitations', async () => {
    await inviteePage.goto(`/invite/accept?token=${encodeURIComponent(tokenOf(third!))}`);
    const accepted = inviteePage.waitForResponse(
      (r) =>
        /\/api\/invites\/[^/]+\/accept$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'POST',
    );
    await inviteePage.getByRole('button', { name: 'Accept invite' }).click();
    expect((await accepted).status(), 'the accept').toBe(200);

    await openMembers(page);
    await expect(page.getByText(invitee.name, { exact: true }).first()).toBeVisible();
    await expect(pendingRow(page, invitee.email)).toHaveCount(0);
    await beat();
  });
  await inviteeContext.close();
});

// ═══ The rest (unrecorded) ═══════════════════════════════════════════════════

test('a Full non-Manager can resend a Full invite but not a Limited one; a Limited member sees no block', async ({
  page,
}) => {
  const fullAddress = `pi-full-${slug}@example.com`;
  const limitedAddress = `pi-limited-${slug}@example.com`;
  await signInAs(page, seed.manager.email);
  await openMembers(page);
  await sendInvite(page, fullAddress);
  await sendInvite(page, limitedAddress, seed.atlas.name);
  await expect(pendingRow(page, fullAddress)).toHaveCount(1);
  await expect(pendingRow(page, limitedAddress)).toHaveCount(1);

  // Fran belongs to ONE workspace, so her Members card is the organization page's fold-in.
  await signInAs(page, seed.fran.email);
  await page.goto('/settings/organization');
  await expect(page.getByText(seed.manager.name, { exact: true }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(pendingRow(page, fullAddress)).toHaveCount(1);
  await expect(pendingRow(page, limitedAddress)).toHaveCount(1);
  await expect(resendButton(page, fullAddress)).toBeEnabled();
  const blocked = resendButton(page, limitedAddress);
  await expect(blocked).toBeDisabled();
  await blocked.locator('..').hover();
  await expect(
    page.getByText('Only a Manager can resend a Limited invitation', { exact: true }).first(),
  ).toBeVisible();

  await signInAs(page, seed.nia.email, 'no-project');
  await page.goto('/settings/organization');
  await expect(page.getByText(seed.manager.name, { exact: true }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByRole('heading', { name: 'Pending invitations' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resend the invitation to / })).toHaveCount(0);
});

test('a Manager whose organization holds one workspace sees the block in the organization fold-in', async ({
  page,
}) => {
  const email = `pi-solo-${slug}@example.com`;
  const address = `pi-solo-invitee-${slug}@example.com`;
  const solo = await usersService.createUser({ email, password: PA_PASSWORD, name: 'Sol Solo' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Solo',
    ownerUserId: solo.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: solo.id,
    name: 'Solo work',
    identifier: 'SOL',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: solo.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await workspaceInvitesService.sendInvite({
    inviterUserId: solo.id,
    inviterName: 'Sol Solo',
    workspaceId: workspace.id,
    targetEmail: address,
  });

  await signIn(page, email, PA_PASSWORD);
  // One workspace keeps the workspace tier hidden, so its own page does not exist…
  expect((await page.goto('/settings/workspace'))?.status()).toBe(404);
  // …and the Members card, Pending block included, folds into the organization page.
  await page.goto('/settings/organization');
  await expect(pendingBlock(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(pendingRow(page, address)).toContainText('Invited by Sol Solo');
  await expect(resendButton(page, address)).toBeEnabled();
});
