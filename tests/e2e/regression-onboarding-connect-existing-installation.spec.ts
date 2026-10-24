// ACCEPTANCE — ONBOARDING'S GITHUB CONNECT OFFERS THE ACCOUNTS THE MOTIR APP IS
// ALREADY INSTALLED ON, AND LINKS ONE INSTEAD OF INSTALLING AGAIN, IN ENGLISH AND
// IN CHINESE (Story MOTIR-8245 · MOTIR-8766).
//
// The story's browser walk: a person signs up by email, takes the entrance's
// "bring your existing project" door, reaches the migrate wizard's Connect step,
// signs in with GitHub, finds the account the App is already installed on, picks
// a subset of its repositories, links them and moves on to Index. Filmed in
// chapters so the story can be accepted by watching it.
//
// ── THE SEAM ────────────────────────────────────────────────────────────────
//
// The REAL routes run end to end. The account list, the repository list and the
// link are server reads and writes, and GitHub is answered in the SERVER by the
// seam this lane already arms (`E2E_TEST_GITHUB_ACCOUNTS`,
// `lib/test-github-accounts-mock.ts`): one account, `moooon-shared`, with five
// repositories, visible to every signed-in person who has a GitHub identity.
// Which organisation owns which repository is Motir's own state, written here
// through MOTIR-8220's shipped link route by the people in the story, never
// inserted.
//
// The GitHub SIGN-IN cannot leave for github.com. The step's own link is
// asserted first (so the start URL is pinned), then its navigation is answered
// the way the real callback answers a granted sign-in: the person's GitHub
// identity is written through the identity repository and the browser is sent to
// `/onboarding/migrate?github=connected`. (The lane's OAuth mock answers every
// grant with one GitHub user, so it cannot serve a second person;
// `regression-multi-org-github-account.spec.ts` records the same choice.)
//
// ── WHAT IS NOT ASSERTED HERE ──────────────────────────────────────────────
//
// Cross-organisation ownership, the other organisation's rows staying unchanged
// and every refusal body are `tests/github/onboardingExistingInstallation.integration.test.ts`'s.
// The non-admin refusal, `installation_not_accessible`, the 422 guards and the
// nothing-left panel are the component tests'. This walk asserts what a person
// sees and does, and in Chinese that the Chinese value is on screen while the
// English one is not, so a catalogue fallback cannot pass.

import {
  request as playwrightRequest,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { signUpToOnboarding } from './_helpers/shell-session';
import { setReaderLanguage } from './_helpers/reader-language';
import { E2E_GITHUB_TOKEN_ENCRYPTION_KEY } from './_helpers/github-const';
import { adminDb } from '../helpers/adminDb';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { withUserContext } from '@/lib/workspaces/context';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import {
  E2E_MULTI_ORG_ACCOUNT,
  E2E_MULTI_ORG_INSTALLATION_ID,
  E2E_MULTI_ORG_REPOS,
} from '@/lib/test-github-accounts-mock';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

const ACCOUNT = E2E_MULTI_ORG_ACCOUNT.login;
const INSTALLATION = E2E_MULTI_ORG_INSTALLATION_ID;
const repoId = (name: string): string =>
  String(E2E_MULTI_ORG_REPOS.find((repo) => repo.name === name)!.id);

/** The step's own sign-in link (`ExistingAccounts.tsx`'s `IDENTITY_START_HREF`). */
const IDENTITY_START_HREF = '/api/github/oauth/start?from=onboardingMigrateConnect';

// ── Language ─────────────────────────────────────────────────────────────────

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];
const CATALOGUE = { en: enMessages, zh: zhMessages } as const;

type ConnectCopy = (typeof enMessages)['onboardingMigrate']['connect'];

function words(lang: Lang) {
  const m = CATALOGUE[lang];
  return {
    connect: m.onboardingMigrate.connect as ConnectCopy,
    indexHeading: m.onboardingMigrate.index.heading,
    importProject: m.onboarding.entrance.importProject,
  };
}

/** `scope` shows the value `pick` takes from this language's catalogue, and, in
 *  any language but English, NOT the English one. */
async function expectCopy(
  scope: Locator,
  lang: Lang,
  pick: (copy: ConnectCopy) => string,
): Promise<void> {
  await expect(scope).toContainText(pick(words(lang).connect));
  if (lang !== 'en') await expect(scope).not.toContainText(pick(words('en').connect));
}

// ── The people ───────────────────────────────────────────────────────────────

interface Person {
  email: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  projectName: string;
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
}

/** Sign a person up by email through the UI (their own workspace and
 *  organisation, owner role) and name the ONE project that sign-up made for
 *  them. One project is what the entrance's "bring your existing project" door
 *  starts on at once; a second would open the wizard on its project choice,
 *  which makes no connect read (MOTIR-8254). */
async function signUpWithProject(
  page: Page,
  email: string,
  project: { name: string },
): Promise<Person> {
  await signUpToOnboarding(page, email);
  const user = await adminDb.user.findFirstOrThrow({ where: { email } });
  const membership = await adminDb.organizationMembership.findFirstOrThrow({
    where: { userId: user.id, role: ORGANIZATION_ROLE.owner },
    include: { organization: true },
  });
  const workspace = await adminDb.workspace.findFirstOrThrow({
    where: { organizationId: membership.organizationId },
  });
  const signedUp = await adminDb.project.findFirstOrThrow({
    where: { workspaceId: workspace.id },
  });
  await adminDb.project.update({ where: { id: signedUp.id }, data: { name: project.name } });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    data: { activeProjectId: signedUp.id },
  });
  await pinContextCookies(page, {
    workspaceId: workspace.id,
    organizationId: membership.organizationId,
  });
  return {
    email,
    userId: user.id,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    projectName: project.name,
    cookies: await page.context().cookies(),
  };
}

/** The GitHub identity a granted sign-in writes, through the identity repository. */
async function grantGithubIdentity(person: Person, githubUserId: string): Promise<void> {
  await withUserContext(person.userId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId: person.userId,
        githubUserId,
        githubLogin: `${person.email.split('@')[0]!}-gh`,
        avatarUrl: null,
        accessTokenEncrypted: encryptToken(`gho_e2e_${githubUserId}`),
      },
      tx,
    ),
  );
}

/** Link repositories for a person's organisation through MOTIR-8220's shipped
 *  route, acting as that person. */
async function linkAs(person: Person, names: string[]): Promise<void> {
  const api = await playwrightRequest.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: person.cookies, origins: [] },
  });
  try {
    const res = await api.post(`/api/organizations/${person.organizationId}/github/installations`, {
      data: { installationId: INSTALLATION, repoIds: names.map(repoId) },
    });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await api.dispose();
  }
}

/**
 * The other organisation, X: an admin who already linked `alpha` and `bravo`
 * from the shared account. Signed up first, so the page then belongs to Y.
 */
async function seedOtherOrganisation(page: Page): Promise<Person> {
  const x = await signUpWithProject(page, 'existing-install-x@e2e.motir.test', {
    name: 'Northwind Secret',
  });
  await grantGithubIdentity(x, '7300001');
  await linkAs(x, ['alpha', 'bravo']);
  return x;
}

// ── The step ─────────────────────────────────────────────────────────────────

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STEP_NAME = new RegExp(
  `^(${LANGS.map((lang) => escapeRe(words(lang).connect.heading)).join('|')})$`,
);
/** The connect step's own region, named by its heading in either language. */
const connectStep = (page: Page) => page.getByRole('region', { name: STEP_NAME });
const picker = (page: Page) => connectStep(page).getByTestId('existing-repository-picker');
const pickerRow = (page: Page, name: string) =>
  picker(page)
    .getByTestId('existing-picker-row')
    .filter({ hasText: `${ACCOUNT}/${name}` });

const isConnectRead = (url: string) => /\/api\/onboarding\/migrate\/[^/]+\/connect-state/.test(url);
const isAccountsRead = (url: string, method: string) =>
  /\/api\/organizations\/[^/]+\/github\/accounts$/.test(new URL(url).pathname) && method === 'GET';
const isReposRead = (url: string, method: string) =>
  /\/github\/accounts\/[^/]+\/repositories$/.test(new URL(url).pathname) && method === 'GET';
const isLink = (url: string, method: string) =>
  /\/github\/installations$/.test(new URL(url).pathname) && method === 'POST';
const isAdvance = (url: string, method: string) =>
  /\/api\/onboarding\/migrate\/[^/]+\/advance$/.test(new URL(url).pathname) && method === 'POST';

/** Open a wizard address and wait on BOTH of the step's reads: the connect read
 *  and the accounts read. Each is the authoritative signal its half is drawn. */
async function openConnectStep(page: Page, href = '/onboarding/migrate'): Promise<void> {
  const read = page.waitForResponse((r) => isConnectRead(r.url()));
  const accounts = page.waitForResponse((r) => isAccountsRead(r.url(), r.request().method()));
  await page.goto(href);
  expect((await read).status()).toBe(200);
  expect((await accounts).status()).toBe(200);
}

async function expectLanguage(page: Page, lang: Lang): Promise<void> {
  await expect(
    page.locator('html'),
    `the saved account language did not take effect: the page did not render in "${lang}"`,
  ).toHaveAttribute('lang', lang);
}

/** Continue, through the shipped advance, onto the Index step. */
async function continueToIndex(page: Page, lang: Lang): Promise<void> {
  const advanced = page.waitForResponse((r) => isAdvance(r.url(), r.request().method()));
  await connectStep(page).getByTestId('connect-continue').click();
  expect((await advanced).status()).toBe(200);
  await expect(page.getByRole('heading', { name: words(lang).indexHeading })).toBeVisible();
}

// The pacing is the deliverable, and the happy path has six chapters.
test.describe.configure({ timeout: 240_000 });

test.beforeAll(() => {
  // The runner encrypts the identities' tokens with the key the server reads.
  process.env['GITHUB_TOKEN_ENCRYPTION_KEY'] ??= E2E_GITHUB_TOKEN_ENCRYPTION_KEY;
});

for (const lang of LANGS) {
  const tag = lang === 'en' ? 'English' : 'Chinese';
  const label = (text: string) => `[${lang}] ${text}`;

  test(`${tag}: an email sign-up signs in with GitHub, picks the installed account, links a subset and moves on`, async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8245');
    await resetDatabase();
    const x = await seedOtherOrganisation(page);
    const y = await signUpWithProject(page, `existing-install-y-${lang}@e2e.motir.test`, {
      name: 'Harbor',
    });
    await setReaderLanguage(page, y.email, lang);
    const c = words(lang).connect;

    await chapter(label('A new email sign-up brings an existing project to Connect'), async () => {
      await page.goto('/onboarding');
      await expectLanguage(page, lang);
      const read = page.waitForResponse((r) => isConnectRead(r.url()));
      const accounts = page.waitForResponse((r) => isAccountsRead(r.url(), r.request().method()));
      await page.getByRole('link', { name: words(lang).importProject }).click();
      await page.waitForURL('**/onboarding/migrate');
      expect((await read).status()).toBe(200);
      const identity = await accounts;
      expect(identity.status()).toBe(200);
      expect(await identity.json()).toEqual({ state: 'identity_required' });

      const prompt = connectStep(page).getByTestId('existing-accounts-identity-prompt');
      await expect(prompt).toBeVisible();
      await expectCopy(prompt, lang, (copy) => copy.existing.identity.title);
      await expectCopy(
        connectStep(page).getByTestId('existing-accounts-skip'),
        lang,
        (copy) => copy.existing.identity.skipCta,
      );
      await expect(connectStep(page).getByTestId('connect-start')).toBeVisible();
      await beat();
    });

    await chapter(label('Skipping keeps the install path'), async () => {
      await connectStep(page).getByTestId('existing-accounts-skip').click();
      await expect(connectStep(page).getByTestId('existing-accounts-identity-prompt')).toHaveCount(
        0,
      );
      await expect(connectStep(page).getByTestId('connect-preflight')).toBeVisible();
      await expectCopy(
        connectStep(page).getByTestId('connect-start'),
        lang,
        (copy) => copy.preflightCta,
      );
      await beat();
      // The skip is this visit's; coming back offers the sign-in again.
      await openConnectStep(page);
      await expect(
        connectStep(page).getByTestId('existing-accounts-identity-prompt'),
      ).toBeVisible();
    });

    await chapter(label('Sign in with GitHub, and come back to the list'), async () => {
      const signInLink = connectStep(page).getByTestId('existing-accounts-sign-in');
      await expect(signInLink).toHaveAttribute('href', IDENTITY_START_HREF);
      await expectCopy(signInLink, lang, (copy) => copy.existing.identity.cta);
      await page.route('**/api/github/oauth/start**', async (route) => {
        // What a granted sign-in leaves behind, then the callback's redirect.
        await grantGithubIdentity(y, lang === 'en' ? '7300002' : '7300003');
        await route.fulfill({
          status: 302,
          headers: { location: '/onboarding/migrate?github=connected' },
        });
      });
      const accounts = page.waitForResponse(
        (r) => isAccountsRead(r.url(), r.request().method()) && r.status() === 200,
      );
      await signInLink.click();
      await page.waitForURL('**/onboarding/migrate**');
      const listed = (await (await accounts).json()) as { state: string };
      expect(listed.state).toBe('ok');

      const list = connectStep(page).getByTestId('existing-accounts');
      await expect(list).toBeVisible();
      await expectCopy(list, lang, (copy) => copy.existing.title);
      const row = list.getByTestId('existing-account-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(ACCOUNT);
      await expectCopy(row, lang, (copy) => copy.existing.typeOrg);
      await expect(connectStep(page).getByTestId('existing-accounts-identity-prompt')).toHaveCount(
        0,
      );
      // "Install on another account" stays, below the list.
      await expectCopy(
        list.getByTestId('connect-start'),
        lang,
        (copy) => copy.existing.installAnotherCta,
      );
      await beat();
    });

    await chapter(label('Pick the account: available, and connected elsewhere'), async () => {
      const repos = page.waitForResponse((r) => isReposRead(r.url(), r.request().method()));
      await connectStep(page).getByTestId('existing-account-row').click();
      expect((await repos).status()).toBe(200);
      await expect(picker(page)).toBeVisible();
      await expect(picker(page)).toContainText(
        c.existing.picker.heading.replace('{login}', ACCOUNT),
      );
      for (const name of ['alpha', 'bravo']) {
        const row = pickerRow(page, name);
        await expect(row).toHaveAttribute('data-availability', 'connected_elsewhere');
        await expectCopy(row, lang, (copy) => copy.existing.picker.connectedElsewhere);
        // Which organisation took it is never said.
        await expect(row).not.toContainText(x.organizationName);
        await expect(row).not.toContainText(x.projectName);
      }
      for (const name of ['charlie', 'delta', 'echo']) {
        await expect(pickerRow(page, name)).toHaveAttribute('data-availability', 'available');
      }
      await expect(picker(page).getByTestId('existing-picker-confirm')).toBeDisabled();
      await beat();
    });

    await chapter(label('Link two repositories'), async () => {
      await pickerRow(page, 'charlie').getByRole('checkbox').click();
      await pickerRow(page, 'delta').getByRole('checkbox').click();
      const confirm = picker(page).getByTestId('existing-picker-confirm');
      await expect(confirm).toBeEnabled();
      const linked = page.waitForResponse((r) => isLink(r.url(), r.request().method()));
      await confirm.click();
      const answer = await linked;
      expect(answer.status()).toBe(200);
      const body = answer.request().postDataJSON() as { installationId: string; repoIds: string[] };
      expect(Object.keys(body).sort()).toEqual(['installationId', 'repoIds']);
      expect(body.installationId).toBe(INSTALLATION);
      expect([...body.repoIds].sort()).toEqual([repoId('charlie'), repoId('delta')].sort());

      const outcome = connectStep(page).getByTestId('link-outcome-linked');
      await expect(outcome).toBeVisible();
      await expectCopy(outcome, lang, (copy) => copy.existing.outcome.linkedTitle);
      await expect(connectStep(page).getByTestId('connect-continue')).toBeVisible();
      await beat();
    });

    await chapter(label('Continue moves the wizard on to Index'), async () => {
      await continueToIndex(page, lang);
      await beat();
    });
  });
}

test('English: the install round trip opens the picker, and a repository taken meanwhile is said, not lost', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8245');
  await resetDatabase();
  const x = await seedOtherOrganisation(page);
  const y = await signUpWithProject(page, 'existing-install-y-return@e2e.motir.test', {
    name: 'Harbor',
  });
  await grantGithubIdentity(y, '7300004');
  // Y's organisation connected `echo` earlier.
  await linkAs(y, ['echo']);
  const c = words('en').connect;

  await chapter('Already connected: the account is marked as linked here', async () => {
    await openConnectStep(page);
    await expect(connectStep(page).getByTestId('connect-state-already_connected')).toBeVisible();
    const row = connectStep(page).getByTestId('existing-account-row');
    await expect(row).toContainText(ACCOUNT);
    await expect(row.getByTestId('existing-account-linked')).toHaveText(c.existing.linkedHere);
    await beat();
  });

  await chapter('GitHub sends you back with an account that is already installed', async () => {
    const repos = page.waitForResponse((r) => isReposRead(r.url(), r.request().method()));
    await openConnectStep(
      page,
      `/onboarding/migrate?github=select_repos&installation_id=${INSTALLATION}`,
    );
    expect((await repos).status()).toBe(200);
    await expect(picker(page)).toBeVisible();
    await expect(picker(page)).toContainText(c.existing.picker.fromInstallHint);
    // The pair is consumed once the picker is open.
    await expect.poll(() => new URL(page.url()).searchParams.has('installation_id')).toBe(false);
    expect(new URL(page.url()).searchParams.has('github')).toBe(false);

    await expect(pickerRow(page, 'echo')).toHaveAttribute('data-availability', 'connected_here');
    await expect(pickerRow(page, 'echo')).toContainText(c.existing.picker.connectedHere);
    await expect(pickerRow(page, 'alpha')).toHaveAttribute(
      'data-availability',
      'connected_elsewhere',
    );
    await expect(pickerRow(page, 'charlie')).toHaveAttribute('data-availability', 'available');
    await beat();
  });

  await chapter('Another organisation takes a repository while you choose', async () => {
    await pickerRow(page, 'charlie').getByRole('checkbox').click();
    await pickerRow(page, 'delta').getByRole('checkbox').click();
    // X connects charlie between Y's read and Y's confirm.
    await linkAs(x, ['alpha', 'bravo', 'charlie']);

    const refused = page.waitForResponse((r) => isLink(r.url(), r.request().method()));
    const reread = page.waitForResponse((r) => isReposRead(r.url(), r.request().method()));
    await picker(page).getByTestId('existing-picker-confirm').click();
    expect((await refused).status()).toBe(409);
    expect((await reread).status()).toBe(200);

    const notice = connectStep(page).getByTestId('link-outcome-taken');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(c.existing.outcome.takenTitle);
    // The picker stays open; charlie is marked taken, delta is still chosen.
    await expect(picker(page)).toBeVisible();
    await expect(pickerRow(page, 'charlie')).toHaveAttribute(
      'data-availability',
      'connected_elsewhere',
    );
    await expect(pickerRow(page, 'delta').getByRole('checkbox')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await beat();
  });

  await chapter('Confirm again: the rest is linked, and the wizard moves on', async () => {
    const linked = page.waitForResponse((r) => isLink(r.url(), r.request().method()));
    await picker(page).getByTestId('existing-picker-confirm').click();
    const answer = await linked;
    expect(answer.status()).toBe(200);
    const body = answer.request().postDataJSON() as { repoIds: string[] };
    expect(body.repoIds).toContain(repoId('delta'));
    expect(body.repoIds).not.toContain(repoId('charlie'));
    await expect(connectStep(page).getByTestId('link-outcome-linked')).toBeVisible();
    await continueToIndex(page, 'en');
    await beat();
  });
});
