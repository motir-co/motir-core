// ACCEPTANCE — ONBOARDING'S GITHUB CONNECT: THE ROUND TRIP AND EVERY OUTCOME
// STATE, IN ENGLISH AND IN CHINESE (Story MOTIR-8241 · MOTIR-8477).
//
// The story's one browser walk. It drives the migrate wizard's Connect step the
// way a person does: arrive, read what GitHub will ask, press Connect GitHub,
// come back, and find the step in exactly the state the trip left it in, with
// one way forward each time. Each test is filmed in chapters so the story can be
// accepted by watching it.
//
// ── HOW A BROWSER WALK DRIVES A ROUND TRIP THROUGH GITHUB WITHOUT GITHUB ──────
//
// GitHub's install screen is unreachable from any lane, so the walk does not
// draw one. Both legs that touch Motir are Motir's own code:
//
//   * OUT. The step's own button opens `/api/github/install/start` in a new tab.
//     The spec intercepts THAT request at the browser boundary, lets the real
//     route answer it (`route.fetch`, redirects not followed), and reads the
//     `Location` the product sent the browser to. That is the install URL the
//     browser was about to load, signed state included. The tab is then given a
//     stand-in page and closed, so nothing reaches github.com. (A route on
//     github.com itself would not work: Playwright calls a route handler only
//     for the FIRST url of a redirect chain.)
//   * BACK. That captured `state` is replayed to the shipped `/api/github/setup`
//     exactly as GitHub's redirect would send it, with the lane's installation
//     id. The callback's GitHub reads are answered by the seam this lane already
//     arms (`E2E_TEST_GITHUB_ACCOUNTS`, `lib/test-github-accounts-mock.ts`), so
//     the account and repositories the step then shows are the fixture's.
//
// The only state the spec signs itself is the EXPIRED one, because a ten-minute
// TTL cannot be waited out; it uses the product's encoder, and the spec first
// proves the runner signs with the server's secret.
//
// ── WHAT IS NOT ASSERTED HERE ────────────────────────────────────────────────
//
// The outcome → status mapping and the Settings return surface are the
// integration card's (MOTIR-8476); Settings appears here only as an ABSENCE. The
// copy is the copy cards'; this walk asserts which catalogue key each state
// renders, and in Chinese that the Chinese value is the one on screen while the
// English one is not (so a catalogue fallback cannot pass).
//
// ── THE PRESS AND THE "COME BACK" ────────────────────────────────────────────
//
// The step leaves `waiting` when the tab comes back into view (a `focus` or a
// `visibilitychange`). A headless browser has no window manager to send that,
// so the spec sends the same `focus` event the browser would. A read already in
// flight swallows a second one (the step's own `inFlight` guard), so the gesture
// is retried until the read the state depends on has landed. That is the dnd
// "retry until committed" shape from CLAUDE.md: the assertion is on the
// rendered state, never on a delay.
//
// ── THE RECORDING ────────────────────────────────────────────────────────────
//
// The receipt is `page`'s recording. The install tab is a popup and would leave
// a second `.webm` in the same output directory, and the uploader takes the
// first one it finds. So the popup's video is deleted once it closes.

import type { Locator, Page, Request, Route } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { setReaderLanguage } from './_helpers/reader-language';
import { E2E_GITHUB_APP_SLUG } from './_helpers/github-const';
import {
  E2E_INDEX_ACCOUNT,
  E2E_INDEX_REPOS,
  indexRepoRef,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';
import {
  CONNECT_JOURNEY_PASSWORD,
  expiredConnectState,
  readRun,
  seedConnectJourney,
  startRun,
  type ConnectJourneySeed,
} from './_helpers/onboarding-github-connect-seed';
import { decodeInstallStateResult } from '@/lib/github/installState';
import { handoffDestination } from '@/lib/planning/onboardingHandoff';
import {
  E2E_MULTI_ORG_ACCOUNT,
  E2E_MULTI_ORG_INSTALLATION_ID,
  E2E_MULTI_ORG_REPOS,
} from '@/lib/test-github-accounts-mock';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// ── Language ─────────────────────────────────────────────────────────────────

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];
const CATALOGUE = { en: enMessages, zh: zhMessages } as const;

type ConnectCopy = (typeof enMessages)['onboardingMigrate']['connect'];

function words(lang: Lang) {
  const m = CATALOGUE[lang].onboardingMigrate;
  return {
    connect: m.connect as ConnectCopy,
    saveExit: m.common.saveExit,
    indexHeading: m.index.heading,
  };
}

/** `scope` shows the value `pick` takes from this language's catalogue, and, in
 *  any language but English, NOT the English one: a fallback cannot pass. */
async function expectCopy(
  scope: Locator,
  lang: Lang,
  pick: (copy: ConnectCopy) => string,
): Promise<void> {
  await expect(scope).toContainText(pick(words(lang).connect));
  if (lang !== 'en') await expect(scope).not.toContainText(pick(words('en').connect));
}

/** Sign the seeded person in, put their SAVED account language on `lang` (the
 *  value the locale resolver reads before the cookie), and start their migrate
 *  run, which is saved at `connect`. Returns the run's id. `expectLanguage` is
 *  the guard that the language took. */
async function signInAs(page: Page, seed: ConnectJourneySeed, lang: Lang): Promise<string> {
  await pinNoInstalledAccounts(page);
  await signIn(page, seed.email, CONNECT_JOURNEY_PASSWORD);
  await setReaderLanguage(page, seed.email, lang);
  const run = await startRun(page.request);
  expect(run.step).toBe('connect');
  return run.id;
}

/**
 * THE WORLD THIS WALK RECORDS: no account the Motir App is installed on is
 * offered to this person. Story MOTIR-8245 later put the accounts the App is
 * already installed on ahead of the pre-flight, read from
 * `GET /api/organizations/{orgId}/github/accounts`; with no GitHub identity that
 * read answers `identity_required` and the step offers a GitHub sign-in in the
 * pre-flight's place. This walk is about the install round trip, so its world is
 * pinned to "signed in, and nothing installed you can see" (`ok` with no
 * accounts), where the step draws exactly what it drew when this was recorded.
 * The accounts journey is `regression-onboarding-connect-existing-installation.spec.ts`'s.
 */
async function pinNoInstalledAccounts(page: Page): Promise<void> {
  await page.route('**/api/organizations/*/github/accounts', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, json: { state: 'ok', accounts: [] } });
  });
}

async function expectLanguage(page: Page, lang: Lang): Promise<void> {
  await expect(
    page.locator('html'),
    `the saved account language did not take effect: the page did not render in "${lang}"`,
  ).toHaveAttribute('lang', lang);
}

// ── The step ─────────────────────────────────────────────────────────────────

type ConnectState =
  | 'preflight'
  | 'starting'
  | 'waiting'
  | 'connected'
  | 'already_connected'
  | 'no_repositories_selected'
  | 'install_cancelled'
  | 'owner_pending'
  | 'failed';

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The connect step's own region, named by its heading in either language. Every
 *  test id below is read inside it, never page-rooted: React can keep an outgoing
 *  copy of the step mounted while the new one streams, and the accessibility tree
 *  is what excludes that copy. */
const STEP_NAME = new RegExp(
  `^(${LANGS.map((lang) => escapeRe(words(lang).connect.heading)).join('|')})$`,
);
const connectStep = (page: Page) => page.getByRole('region', { name: STEP_NAME });

const stateBox = (page: Page, state: ConnectState) =>
  connectStep(page).getByTestId(`connect-state-${state}`);

const isConnectRead = (url: string) => /\/api\/onboarding\/migrate\/[^/]+\/connect-state/.test(url);
const isAdvance = (url: string, method: string) =>
  /\/api\/onboarding\/migrate\/[^/]+\/advance$/.test(new URL(url).pathname) && method === 'POST';

/** Open the wizard and wait for the step's first read, the authoritative signal
 *  that the state drawn is the read's and not the `checking` placeholder. */
async function openConnectStep(page: Page, href = '/onboarding/migrate'): Promise<void> {
  const read = page.waitForResponse((r) => isConnectRead(r.url()));
  await page.goto(href);
  expect((await read).status()).toBe(200);
}

/** A navigation that landed on Motir's Settings return surface, recorded for the
 *  whole test: every outcome here must come back to onboarding instead. */
function watchForSettings(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).pathname.startsWith('/settings/organization/git')) {
      hits.push(request.url());
    }
  });
  return hits;
}

interface OutboundLeg {
  /** The install URL the browser was sent to. */
  url: URL;
  /** The signed state on it, as GitHub would echo it back. */
  state: string;
}

const INSTALL_START = '**/api/github/install/start**';

/**
 * Press a control that sends the person to GitHub, and capture where the browser
 * was sent. See the header: the install start answers for real, its `Location`
 * is recorded, and the tab that would have loaded github.com is closed.
 */
async function leaveForGithub(
  page: Page,
  press: Locator,
  /** Asserted while the GitHub tab is still open, so closing it (which a real
   *  browser answers with a `focus` on this tab) cannot race the assertion. */
  whileAway?: () => Promise<void>,
): Promise<OutboundLeg> {
  const context = page.context();
  let resolveLocation: (location: string) => void = () => {};
  const location = new Promise<string>((resolve) => {
    resolveLocation = resolve;
  });
  const handler = async (route: Route) => {
    const answer = await route.fetch({ maxRedirects: 0 });
    resolveLocation(answer.headers()['location'] ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>GitHub</title><p>GitHub would ask here.</p>',
    });
  };
  await context.route(INSTALL_START, handler);
  const popup = page.waitForEvent('popup');
  await press.click();
  const tab = await popup;
  const url = new URL(await location);
  await context.unroute(INSTALL_START, handler);

  // The App's OWN install page, never Motir's Settings.
  expect(url.host).toBe('github.com');
  expect(url.pathname).toBe(`/apps/${E2E_GITHUB_APP_SLUG}/installations/new`);
  expect(url.pathname).not.toContain('/settings/organization/git');
  const state = url.searchParams.get('state');
  expect(state, 'the install URL carries no signed state').toBeTruthy();

  if (whileAway) await whileAway();
  await tab.close();
  // The receipt is `page`'s recording; see the header.
  await tab.video()?.delete();
  return { url, state: state! };
}

/** The press ended with the browser gone to GitHub: the step is WAITING. The
 *  step leaves `starting` on the first read after the press (its 5 s poll). */
async function expectWaiting(page: Page, lang: Lang): Promise<void> {
  await expect(stateBox(page, 'waiting')).toBeVisible();
  await expectCopy(stateBox(page, 'waiting'), lang, (c) => c.waitingTitle);
}

/** Come back to this tab, retried until the read it triggers has landed and the
 *  step shows `expected`. */
async function comeBackToTab(page: Page, expected: ConnectState): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(stateBox(page, expected)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/** GitHub's redirect back, replayed against the shipped setup callback. Asserts
 *  the browser landed on the onboarding step, with Settings nowhere on the way. */
async function returnFromGithub(page: Page, query: Record<string, string>): Promise<void> {
  const read = page.waitForResponse((r) => isConnectRead(r.url()));
  const answer = await page.goto(`/api/github/setup?${new URLSearchParams(query).toString()}`);
  expect(answer, 'the setup callback produced no response').not.toBeNull();
  const chain: string[] = [];
  for (let hop = answer!.request() as Request | null; hop; hop = hop.redirectedFrom()) {
    chain.push(hop.url());
  }
  expect(new URL(answer!.url()).pathname).toBe('/onboarding/migrate');
  for (const hop of chain) {
    expect(new URL(hop).pathname).not.toMatch(/^\/settings\/organization\/git/);
  }
  expect((await read).status()).toBe(200);
}

/** Re-opening the wizard resumes on the Connect step, for the SAME run. */
async function expectRunSurvives(page: Page, runId: string, lang: Lang): Promise<void> {
  await openConnectStep(page);
  await expect(page.getByRole('heading', { name: words(lang).connect.heading })).toBeVisible();
  const run = await readRun(page.request, runId);
  expect(run.id).toBe(runId);
  expect(run.step).toBe('connect');
  expect(run.status).toBe('active');
}

/** Continue, through the shipped advance, onto the Index step. */
async function continueToIndex(page: Page, lang: Lang): Promise<void> {
  const advanced = page.waitForResponse((r) => isAdvance(r.url(), r.request().method()));
  await connectStep(page).getByTestId('connect-continue').click();
  expect((await advanced).status()).toBe(200);
  await expect(page.getByRole('heading', { name: words(lang).indexHeading })).toBeVisible();
}

const FIXTURE_REFS: readonly string[] = E2E_MULTI_ORG_REPOS.map(
  (repo) => `${E2E_MULTI_ORG_ACCOUNT.login}/${repo.name}`,
);

/** An installation id no lane seam answers: the state verifies, GitHub's side
 *  cannot be completed. */
const UNREADABLE_INSTALLATION_ID = '99008477';

// Each test is one recording. The pacing is the deliverable, and two of them
// carry a five-second poll on top of their chapters.
test.describe.configure({ timeout: 90_000 });

for (const lang of LANGS) {
  const tag = lang === 'en' ? 'English' : 'Chinese';
  const label = (text: string) => `[${lang}] ${text}`;

  test(`${tag}: the round trip, from the pre-flight to the index step and back to the plan window`, async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8241');
    await resetDatabase();
    const seed = await seedConnectJourney(`connect-trip-${lang}@e2e.motir.test`);
    const settings = watchForSettings(page);
    const runId = await signInAs(page, seed, lang);
    // Entered the way the plan window's hand-off sends a person here, with its
    // return address on the query.
    const entry = handoffDestination(
      { outcome: 'onboard_existing_project', message: 'Your repository is not connected yet.' },
      { kind: 'work-item', itemKey: seed.itemKey },
    );
    const c = words(lang).connect;

    await chapter(label('Pre-flight: what GitHub will ask, before you leave'), async () => {
      await openConnectStep(page, entry);
      await expectLanguage(page, lang);
      const box = stateBox(page, 'preflight');
      await expect(box).toBeVisible();
      const preflight = box.getByTestId('connect-preflight');
      await expectCopy(preflight, lang, (copy) => copy.preflightAccount);
      await expectCopy(preflight, lang, (copy) => copy.preflightRepositories);
      await expectCopy(preflight, lang, (copy) => copy.preflightAccess);
      await expectCopy(box.getByTestId('connect-start'), lang, (copy) => copy.preflightCta);
      // Nothing is connected, so nothing claims to advance.
      await expect(connectStep(page).getByTestId('connect-continue')).toHaveCount(0);
      await expect(page.getByRole('button', { name: c.continue, exact: true })).toHaveCount(0);
      await beat();
    });

    await chapter(label("Connect GitHub leaves for the App's own install page"), async () => {
      await leaveForGithub(page, connectStep(page).getByTestId('connect-start'), () =>
        expectWaiting(page, lang),
      );
    });

    await chapter(label('Back without installing: the install did not finish'), async () => {
      await comeBackToTab(page, 'install_cancelled');
      const box = stateBox(page, 'install_cancelled');
      await expectCopy(box, lang, (copy) => copy.cancelledTitle);
      await expectCopy(box, lang, (copy) => copy.cancelledHint);
      await expect(box.getByTestId('connect-start')).toBeVisible();
      // Benign: no danger tone anywhere on the step.
      await expect(box.locator('[data-tone="danger"]')).toHaveCount(0);
      const run = await readRun(page.request, runId);
      expect(run.step).toBe('connect');
      expect(run.connectedRepoRef).toBeNull();
    });

    let leg: OutboundLeg | undefined;
    await chapter(label('Connect GitHub again, and install this time'), async () => {
      leg = await leaveForGithub(
        page,
        stateBox(page, 'install_cancelled').getByTestId('connect-start'),
        () => expectWaiting(page, lang),
      );
    });

    await chapter(
      label('GitHub sends you back to this step, with the repositories granted'),
      async () => {
        await returnFromGithub(page, {
          installation_id: E2E_MULTI_ORG_INSTALLATION_ID,
          setup_action: 'install',
          state: leg!.state,
        });
        const box = stateBox(page, 'connected');
        await expect(box).toBeVisible();
        await expectCopy(box, lang, (copy) => copy.pill.connected);
        const list = box.getByRole('list', { name: c.listLabel });
        await expect(list.getByRole('listitem')).toHaveCount(E2E_MULTI_ORG_REPOS.length);
        await expect(list).toContainText(`${E2E_MULTI_ORG_ACCOUNT.login}/`);
        for (const repo of E2E_MULTI_ORG_REPOS) await expect(list).toContainText(repo.name);
        await expect(connectStep(page).getByTestId('connect-start')).toHaveCount(0);
      },
    );

    await chapter(
      label('Continue: the wizard moves on to Index, with the repository recorded'),
      async () => {
        await continueToIndex(page, lang);
        const run = await readRun(page.request, runId);
        expect(run.id).toBe(runId);
        expect(run.step).toBe('index');
        expect(FIXTURE_REFS).toContain(run.connectedRepoRef);
      },
    );

    await chapter(label('Save & exit still returns to the plan window you came from'), async () => {
      const saveExit = page.getByRole('link', { name: words(lang).saveExit });
      await expect(saveExit).toHaveAttribute('href', `/items/${seed.itemKey}`);
      await saveExit.click();
      await page.waitForURL((url) => url.pathname === `/items/${seed.itemKey}`);
      expect(settings, 'an outcome fell back to Settings').toEqual([]);
    });
  });

  test(`${tag}: an organisation that is already connected continues without a second install`, async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8241');
    await resetDatabase();
    const seed = await seedConnectJourney(`connect-already-${lang}@e2e.motir.test`);
    await seedConnectedRepos(seed.workspaceId);
    const installStarts: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/github/install/start') {
        installStarts.push(request.url());
      }
    });
    const runId = await signInAs(page, seed, lang);

    await chapter(label('Already connected: the repositories, and Continue'), async () => {
      await openConnectStep(page);
      await expectLanguage(page, lang);
      const box = stateBox(page, 'already_connected');
      await expect(box).toBeVisible();
      await expectCopy(box, lang, (copy) => copy.alreadyConnectedTitle);
      await expectCopy(box, lang, (copy) => copy.pill.alreadyConnected);
      const list = box.getByRole('list', { name: words(lang).connect.listLabel });
      await expect(list.getByRole('listitem')).toHaveCount(E2E_INDEX_REPOS.length);
      for (const repo of E2E_INDEX_REPOS) await expect(list).toContainText(repo.name);
      // The install is not the primary action; Continue is.
      await expect(connectStep(page).getByTestId('connect-start')).toHaveCount(0);
      await expect(connectStep(page).getByTestId('connect-continue')).toBeVisible();
      await beat();
    });

    await chapter(label('Continue moves the wizard on, with no install'), async () => {
      await continueToIndex(page, lang);
      const run = await readRun(page.request, runId);
      expect(run.step).toBe('index');
      expect(E2E_INDEX_REPOS.map(indexRepoRef)).toContain(run.connectedRepoRef);
      expect(installStarts, 'an install was started for an organisation already connected').toEqual(
        [],
      );
      await beat();
    });
  });

  test(`${tag}: GitHub is connected but no repository is, until the selection changes on GitHub`, async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8241');
    await resetDatabase();
    const seed = await seedConnectJourney(`connect-norepos-${lang}@e2e.motir.test`);
    // An installation bound to the organisation with no repository it can use.
    // The lane's GitHub fixture is static and always answers the same set, so
    // this state is seeded through the webhook's own reconcile rather than driven.
    await seedConnectedRepos(seed.workspaceId, []);
    const runId = await signInAs(page, seed, lang);
    const c = words(lang).connect;

    await chapter(label('No repositories selected: choose them on GitHub'), async () => {
      await openConnectStep(page);
      await expectLanguage(page, lang);
      const box = stateBox(page, 'no_repositories_selected');
      await expect(box).toBeVisible();
      await expectCopy(box, lang, (copy) => copy.noReposTitle);
      await expectCopy(box, lang, (copy) => copy.pill.chooseRepos);
      const choose = box.getByRole('link', { name: new RegExp(c.changeReposCta) });
      // The installation's own page on GitHub, never Motir's Settings.
      const href = new URL((await choose.getAttribute('href'))!);
      expect(href.host).toBe('github.com');
      expect(href.pathname).toContain(`/installations/`);
      expect(href.pathname).toContain(E2E_INDEX_ACCOUNT.login);
      await expect(connectStep(page).getByTestId('connect-continue')).toHaveCount(0);
      await beat();
    });

    await chapter(label('The run survives: re-opening resumes on Connect'), async () => {
      await expectRunSurvives(page, runId, lang);
      await expect(stateBox(page, 'no_repositories_selected')).toBeVisible();
    });

    await chapter(
      label('The selection changes on GitHub, and the step shows it on return'),
      async () => {
        // GitHub's side changes: the webhook reconcile records one repository.
        await seedConnectedRepos(seed.workspaceId, [E2E_INDEX_REPOS[0]]);
        await comeBackToTab(page, 'already_connected');
        const box = stateBox(page, 'already_connected');
        const list = box.getByRole('list', { name: c.listLabel });
        await expect(list.getByRole('listitem')).toHaveCount(1);
        await expect(list).toContainText(E2E_INDEX_REPOS[0].name);
        await expect(connectStep(page).getByTestId('connect-continue')).toBeVisible();
      },
    );
  });

  test(`${tag}: waiting on an owner, and failures, all stay on the connect step`, async ({
    page,
    chapter,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8241');
    await resetDatabase();
    const seed = await seedConnectJourney(`connect-outcomes-${lang}@e2e.motir.test`);
    const settings = watchForSettings(page);
    const runId = await signInAs(page, seed, lang);

    await chapter(label('An organisation owner has to approve the install'), async () => {
      await openConnectStep(page);
      await expectLanguage(page, lang);
      const leg = await leaveForGithub(page, connectStep(page).getByTestId('connect-start'));
      // The runner signs with the server's secret; the expired case relies on it.
      expect(
        decodeInstallStateResult(leg.state).ok,
        'the runner does not hold the server BETTER_AUTH_SECRET, so a state it signs would read as tampered',
      ).toBe(true);
      await returnFromGithub(page, { setup_action: 'request', state: leg.state });
      const box = stateBox(page, 'owner_pending');
      await expect(box).toBeVisible();
      await expectCopy(box, lang, (copy) => copy.ownerPendingTitle);
      await expectCopy(box, lang, (copy) => copy.pill.ownerPending);
      // Neither the step nor the run says it is done.
      await expect(connectStep(page).getByTestId('connect-continue')).toHaveCount(0);
      const run = await readRun(page.request, runId);
      expect(run.step).toBe('connect');
      expect(run.connectedRepoRef).toBeNull();
      expect(await adminDb.githubInstallation.count()).toBe(0);
    });

    await chapter(label('The run survives the wait for an owner'), async () => {
      await expectRunSurvives(page, runId, lang);
    });

    await chapter(
      label("GitHub's side cannot be completed: try again, from this step"),
      async () => {
        const leg = await leaveForGithub(page, connectStep(page).getByTestId('connect-start'));
        await returnFromGithub(page, {
          installation_id: UNREADABLE_INSTALLATION_ID,
          setup_action: 'install',
          state: leg.state,
        });
        const box = stateBox(page, 'failed');
        await expect(box).toBeVisible();
        await expectCopy(box, lang, (copy) => copy.outcome.install_provider_errorTitle);
        await expectCopy(box.getByTestId('connect-start'), lang, (copy) => copy.tryAgainCta);
        await expect(connectStep(page).getByTestId('connect-continue')).toHaveCount(0);
      },
    );

    await chapter(label('The run survives the failure'), async () => {
      await expectRunSurvives(page, runId, lang);
    });

    await chapter(
      label('The GitHub link expired while you were there: benign, start again'),
      async () => {
        await returnFromGithub(page, {
          installation_id: E2E_MULTI_ORG_INSTALLATION_ID,
          setup_action: 'install',
          state: expiredConnectState(seed),
        });
        const box = stateBox(page, 'failed');
        await expect(box).toBeVisible();
        await expectCopy(box, lang, (copy) => copy.outcome.install_expiredTitle);
        await expectCopy(box, lang, (copy) => copy.pill.expired);
        await expect(box.locator('[data-tone="danger"]')).toHaveCount(0);
        await expect(box.getByTestId('connect-start')).toBeVisible();
        // An expired state binds nothing.
        expect(await adminDb.githubInstallation.count()).toBe(0);
      },
    );

    await chapter(label('The run survives the expired link'), async () => {
      await expectRunSurvives(page, runId, lang);
      expect(settings, 'an outcome fell back to Settings').toEqual([]);
    });
  });
}
