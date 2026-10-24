// ACCEPTANCE — ONE GITHUB ACCOUNT, TWO ORGANISATIONS, DISJOINT REPOSITORIES
// (Story MOTIR-8216 · MOTIR-8225).
//
// The story's Verification, driven through a real browser as the admins of two
// real organisations, and recorded: X connects A and B from one GitHub account;
// Y, brand new, connects C, D and E from the SAME account; each room shows only
// its own; Y cannot take A; X is untouched by everything Y does.
//
// It asserts what an admin can SEE and DO. Every database, RLS, index, webhook
// and typed-error claim belongs to the story's integration test
// (`tests/github/multiOrgInstallation.integration.test.ts`), which this journey
// does not repeat.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// GitHub is the only thing stubbed, and it is stubbed in the SERVER, because
// the pickers are server reads: `lib/test-github-accounts-mock.ts` behind
// `E2E_TEST_GITHUB_ACCOUNTS=1` (this lane's webServer env) answers
// `/user/installations`, the installation's token mint, its repository list and
// the App's installation read for ONE account, `moooon-shared`, with five
// repositories. Which organisation owns which of them is Motir's own state,
// written by this journey through the shipped picker — nothing inserts a link
// or a repository row.
//
// Each admin's GitHub IDENTITY is a row written through the identity
// repository, not the OAuth round trip: the lane's OAuth mock answers every
// grant with one GitHub user, and `github_identity.github_user_id` is unique,
// so a second admin could not complete it. `github.spec.ts` owns that round
// trip.
//
// WEBHOOKS are verified-no-change here: the lane can sign a delivery, but which
// organisations an installation event reaches is the integration test's
// assertion, and a browser adds nothing to it.
//
// ── ONE PAGE, TWO PEOPLE ──────────────────────────────────────────────────────
//
// The receipt is the recording of `page`, so both admins act on it: each one's
// session cookies are captured once, and switching people is swapping the jar.
// A second browser context would act off camera.
//
// ── THE ORDER ─────────────────────────────────────────────────────────────────
//
// The refusal is forced on Y's FIRST connect, while the picker still has a
// submit to press (once C, D and E are Y's the account has nothing left, which
// is the next chapter). And X's install round trip runs while Y is still
// linked: with no other organisation on the account, an install return takes
// every repository the App can see — the single-organisation behaviour the
// connect API card kept — so after Y disconnects it would rightly claim C, D
// and E for X.

import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { signUpToOnboarding } from './_helpers/shell-session';
import { E2E_GITHUB_TOKEN_ENCRYPTION_KEY } from './_helpers/github-const';
import { adminDb } from '../helpers/adminDb';
import { projectsService } from '@/lib/services/projectsService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { withUserContext } from '@/lib/workspaces/context';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import {
  E2E_MULTI_ORG_ACCOUNT,
  E2E_MULTI_ORG_INSTALLATION_ID,
} from '@/lib/test-github-accounts-mock';
import enMessages from '@/messages/en.json';

const ACCOUNT = E2E_MULTI_ORG_ACCOUNT.login;
const [A, B, C, D, E] = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

// The pacing is the deliverable (`docs/decisions/acceptance-video.md`), and ten
// chapters of it do not fit the lane's 90s default.
test.describe.configure({ timeout: 300_000 });

interface Admin {
  userId: string;
  organizationId: string;
  organizationName: string;
  projectName: string;
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
}

/** Sign an admin up through the UI (auto workspace + auto organisation, owner
 *  role), give them a project and a GitHub identity, and keep their cookies. */
async function seedAdmin(
  page: Page,
  email: string,
  project: { name: string; identifier: string },
  githubUserId: string,
): Promise<Admin> {
  await signUpToOnboarding(page, email);
  const user = await adminDb.user.findFirstOrThrow({ where: { email } });
  const workspace = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${email.split('@')[0]!}'s Workspace` },
  });
  const membership = await adminDb.organizationMembership.findFirstOrThrow({
    where: { userId: user.id, role: ORGANIZATION_ROLE.owner },
    include: { organization: true },
  });
  const created = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: project.name,
    identifier: project.identifier,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    data: { activeProjectId: created.id },
  });
  await withUserContext(user.id, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId: user.id,
        githubUserId,
        githubLogin: `${email.split('@')[0]!}-gh`,
        avatarUrl: null,
        accessTokenEncrypted: encryptToken(`gho_e2e_${githubUserId}`),
      },
      tx,
    ),
  );
  await pinContextCookies(page, {
    workspaceId: workspace.id,
    organizationId: membership.organizationId,
  });
  return {
    userId: user.id,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    projectName: project.name,
    cookies: await page.context().cookies(),
  };
}

async function actAs(page: Page, admin: Admin): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies(admin.cookies);
}

const main = (page: Page) => page.locator('#main');

async function openGitRoom(page: Page): Promise<void> {
  await page.goto('/settings/organization/git');
  await expect(main(page).getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
}

/** The repo picker for the shared account, opened from the room's primary. */
async function openRepoPicker(page: Page): Promise<void> {
  await main(page).getByRole('button', { name: 'Connect GitHub' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: new RegExp(ACCOUNT) }).click();
  await expect(dialog.getByText(`Choose repositories from ${ACCOUNT}`)).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.getByRole('dialog').getByRole('checkbox', { name: new RegExp(`^${ACCOUNT}/${name},`) });

/** The inventory's own repository rows — the name span, exact. */
async function expectInventory(page: Page, present: string[], absent: string[]): Promise<void> {
  for (const name of present) {
    await expect(main(page).getByText(name, { exact: true }).first()).toBeVisible();
  }
  for (const name of absent) {
    await expect(main(page).getByText(name, { exact: true })).toHaveCount(0);
  }
}

async function expectOneAccountRow(page: Page): Promise<void> {
  const list = main(page).getByRole('list', { name: 'GitHub accounts' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText(ACCOUNT, { exact: true })).toBeVisible();
}

const isLink = (method: string) => (r: { url(): string; request(): { method(): string } }) =>
  /\/github\/installations$/.test(r.url()) && r.request().method() === method;

test('one GitHub account serves two organisations, each with only its own repositories', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8216');

  // The runner encrypts the identities' tokens with the key the server reads.
  process.env['GITHUB_TOKEN_ENCRYPTION_KEY'] ??= E2E_GITHUB_TOKEN_ENCRYPTION_KEY;
  await resetDatabase();
  const x = await seedAdmin(
    page,
    'acceptance-multi-org-x@example.com',
    { name: 'Northwind', identifier: 'NOR' },
    '7100001',
  );
  const y = await seedAdmin(
    page,
    'acceptance-multi-org-y@example.com',
    { name: 'Harbor', identifier: 'HAR' },
    '7100002',
  );

  await chapter('Organisation X connects A and B from one GitHub account', async () => {
    await actAs(page, x);
    await openGitRoom(page);
    // FIRST, the control the whole journey depends on: a lane that left the
    // GitHub surface unmounted would otherwise pass every absence below.
    await expect(main(page).getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await beat();

    await openRepoPicker(page);
    await row(page, A).click();
    await row(page, B).click();
    await beat();
    const linked = page.waitForResponse(isLink('POST'));
    await page.getByRole('button', { name: 'Connect 2 repositories' }).click();
    expect((await linked).status()).toBe(200);

    await expectOneAccountRow(page);
    await expectInventory(page, [A, B], [C, D, E]);
    await beat();
  });

  await chapter('Organisation Y, brand new, starts with nothing of X’s', async () => {
    await actAs(page, y);
    await openGitRoom(page);
    await expect(main(page).getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expect(main(page).getByRole('list', { name: 'GitHub accounts' })).toHaveCount(0);
    await expectInventory(page, [], [A, B]);
    await beat();
  });

  await chapter('Y sees A and B as taken, and nothing that names X', async () => {
    await openRepoPicker(page);
    for (const name of [C, D, E]) await expect(row(page, name)).toBeEnabled();
    for (const name of [A, B]) await expect(row(page, name)).toBeDisabled();
    await expect(
      page.getByRole('dialog').getByText('Connected to another organisation'),
    ).toHaveCount(2);
    // The locked rows say THAT, never WHO.
    await expect(page.locator('body')).not.toContainText(x.organizationName);
    await expect(page.locator('body')).not.toContainText(x.projectName);
    await beat();

    await page.getByRole('checkbox', { name: /Select all available/ }).click();
    for (const name of [C, D, E])
      await expect(row(page, name)).toHaveAttribute('aria-checked', 'true');
    for (const name of [A, B])
      await expect(row(page, name)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Connect 3 repositories' })).toBeEnabled();
    await beat();
  });

  await chapter('A request that carries A anyway is refused, and says why', async () => {
    // The picker will not let anyone select A, so the journey sends the request
    // the UI sends with A added — the race in which another organisation took
    // a repository between the picker's read and the press.
    const aId = await adminDb.githubRepo
      .findFirstOrThrow({ where: { name: A, organizationId: x.organizationId } })
      .then((repo) => repo.repoId);
    await page.route('**/github/installations', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { repoIds?: string[] };
      await route.continue({
        postData: JSON.stringify({ ...body, repoIds: [...(body.repoIds ?? []), aId] }),
      });
    });
    const refused = page.waitForResponse(isLink('POST'));
    await page.getByRole('button', { name: 'Connect 3 repositories' }).click();
    expect((await refused).status()).toBe(409);
    await page.unroute('**/github/installations');

    await expect(
      page
        .getByRole('dialog')
        .getByRole('alert')
        .filter({ hasText: 'connected to another organisation' }),
    ).toBeVisible();
    // The rest of the selection is intact, and nothing was connected to Y.
    for (const name of [C, D, E])
      await expect(row(page, name)).toHaveAttribute('aria-checked', 'true');
    const counts = await page.request
      .get(
        `/api/organizations/${y.organizationId}/github/accounts/${E2E_MULTI_ORG_INSTALLATION_ID}/repositories`,
      )
      .then((res) => res.json() as Promise<{ counts: { connectedHere: number } }>);
    expect(counts.counts.connectedHere).toBe(0);
    await beat();
  });

  await chapter('Y connects C, D and E', async () => {
    const linked = page.waitForResponse(isLink('POST'));
    await page.getByRole('button', { name: 'Connect 3 repositories' }).click();
    expect((await linked).status()).toBe(200);

    await expectOneAccountRow(page);
    await expectInventory(page, [C, D, E], [A, B]);
    await beat();

    // …and they are what Y's project can pick.
    await page.goto('/settings/project/repositories');
    await expect(page.getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
    await page.getByRole('button', { name: enMessages.repositoryPicker.add }).click();
    for (const name of [C, D, E]) {
      await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    }
    for (const name of [A, B]) {
      await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0);
    }
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('X is exactly as it was', async () => {
    await actAs(page, x);
    await openGitRoom(page);
    await expectOneAccountRow(page);
    await expectInventory(page, [A, B], [C, D, E]);
    await beat();
  });

  await chapter('With every repository taken, Y is told so', async () => {
    await actAs(page, y);
    await openGitRoom(page);
    await main(page).getByRole('button', { name: 'Add or remove repositories' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`Nothing left to connect from ${ACCOUNT}`)).toBeVisible();
    await expect(dialog.getByText('Connected to this organisation').locator('..')).toContainText(
      '3',
    );
    await expect(dialog.getByText('Connected to other organisations').locator('..')).toContainText(
      '2',
    );
    await expect(dialog.getByRole('button', { name: 'Choose another account' })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('X runs the install again — same account, same two', async () => {
    await actAs(page, x);
    // The App's install round trip, returning the way GitHub's setup redirect
    // does: the state is the one Motir signs for "Install on another account".
    const { url } = await page.request
      .get(`/api/organizations/${x.organizationId}/github/install-url`)
      .then((res) => res.json() as Promise<{ url: string }>);
    const state = new URL(url).searchParams.get('state')!;
    await page.goto(
      `/api/github/setup?installation_id=${E2E_MULTI_ORG_INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    await page.waitForURL('**/settings/organization/git?github=installed');
    await expect(page.getByRole('status')).toHaveText(enMessages.github.banner.installed);
    await expectOneAccountRow(page);
    await expectInventory(page, [A, B], [C, D, E]);
    await beat();
  });

  await chapter('Y disconnects — and only Y', async () => {
    await actAs(page, y);
    await openGitRoom(page);
    await main(page).getByRole('button', { name: 'Disconnect' }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(
      dialog.getByRole('heading', { name: new RegExp(`Disconnect ${ACCOUNT} from`) }),
    ).toBeVisible();
    await expect(dialog).toContainText(
      `link to ${ACCOUNT} and the 3 repositories it connected here`,
    );
    await expect(dialog).toContainText(`Other organisations linked to ${ACCOUNT} are not affected`);
    await expect(dialog).toContainText(/kept for \d+ days/);
    await beat();

    const gone = page.waitForResponse(
      (r) =>
        r.url().includes(`/github/accounts/${E2E_MULTI_ORG_INSTALLATION_ID}`) &&
        r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    expect((await gone).status()).toBeLessThan(300);

    await expect(main(page).getByRole('list', { name: 'GitHub accounts' })).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expectInventory(page, [], [C, D, E]);
    await beat();

    await actAs(page, x);
    await openGitRoom(page);
    await expectOneAccountRow(page);
    await expectInventory(page, [A, B], [C, D, E]);
    await beat();
  });
});
