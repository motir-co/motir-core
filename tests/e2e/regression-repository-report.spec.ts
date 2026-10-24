// Acceptance E2E — APPROVE A PLAN AND BE INVITED TO YOUR CODE WITHOUT BEING
// ASKED FOR ANYTHING (Subtask MOTIR-5018, Story MOTIR-5010).
//
// ⚠️ WHY THIS FILE EXISTS RATHER THAN A RE-SCOPE OF `cloud-repository-set.spec.ts`.
// MOTIR-5018 asked for the receipt to come from that spec. It cannot, and the
// reason is structural rather than a preference:
//
//   * that file imports `./_helpers/promoted-regression`, where
//     `acceptanceStory()` is a NO-OP and no clip is recorded. It was PROMOTED out
//     of this lane by MOTIR-2769 because Story MOTIR-1775's receipt is approved
//     and FROZEN — a republish is refused, not superseded;
//   * it lives in `playwright.cloud.config.ts`'s `testMatch`, whose `video` is
//     `retain-on-failure`: a green run there records nothing at all;
//   * and `tests/e2e-acceptance-lane-imports.test.ts` (MOTIR-4751) FAILS a spec
//     outside this lane that imports `./acceptance-video`, in both directions.
//
// So the two instruments are separate because the lifecycle makes them separate:
// a promoted regression spec that runs on every pull request, and — here — ONE
// recorded run of MOTIR-5010 for a person to approve. They are not "two walks
// disagreeing about one surface": the regression spec asserts the surface stays
// correct, this one records it working once.
//
// ══ WHAT THE VIEWER MUST BE ABLE TO SEE ══
//
// The story's claim is small enough to watch, and the receipt has to SHOW the
// pair rather than let a reviewer take it on trust:
//
//   1 · the OWNERSHIP PROMISE — *It's yours … move it to your own GitHub whenever
//       you want* — on screen, on the main line, not in a footnote;
//   2 · the INVITED ACCOUNT, named, with no action taken to produce it.
//
// And the thing that is hardest to show is an ABSENCE, so the recording spends a
// chapter on it deliberately: the screen a person meets after approving carries
// no question about GitHub and no door to a repository picker. Before this story
// it carried a button reading **Connect GitHub** whose handler merely navigated —
// shown to people who had connected GitHub months earlier.
//
// ══ THE SECOND ACTOR ══ The no-identity arm is in the SAME recording, because
// "connected" is a property of the ACTOR rather than of the project: a teammate
// who did not run onboarding can approve a plan. A clip of only the happy arm
// would be indistinguishable from a build that claims an invitation it never
// sent.
//
// ══ NO REAL REPOSITORY IS CREATED ══ Both GitHub boundaries are faked INSIDE the
// Next server (`lib/test-github-repos-mock.ts`, `E2E_TEST_GITHUB_REPOS=1`),
// because both are server-side `fetch`es `page.route` cannot see. What GitHub was
// actually asked is asserted through the journal, not narrated.
//
// ══ WAITS ══ Every wait is on an authoritative signal (the coding convention § E2E): the
// write's own response, or the committed state the establish poll re-reads.
// Nothing here sleeps.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import {
  collaboratorInvites,
  repoCreates,
  resetGithubFixture,
  seedRepositorySet,
  REPO_SET_LOGIN,
  type RepositorySetSeed,
} from './_helpers/repository-set-seed';

// A full approve → derive → create → invite journey against a production build,
// twice, paced for a human. The lane runs `workers: 1`.
test.describe.configure({ timeout: 300_000 });

/** The default path's single status line (`repo-setup-status`). */
const setupStatus = (page: Page) => page.getByTestId('repo-setup-status');

/** The `created` panel's REPORT — either arm (`repo-access-report`). */
const accessReport = (page: Page) => page.getByTestId('repo-access-report');

/**
 * Approve the plan and wait for the APPROVE RESPONSE — the authoritative signal.
 * The step is server-rendered from the approved plan, so asserting it before the
 * write lands would race the round trip.
 */
async function approvePlan(page: Page, seed: RepositorySetSeed): Promise<void> {
  // Undecided, so it is approved where it is decided — the planning overlay's footer
  // (Story MOTIR-7883 · MOTIR-7886).
  const overlay = await openUndecidedPlan(page, seed.planId);
  const approve = overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeVisible();
  const approved = page.waitForResponse(
    (r) => /\/api\/plans\/[^/]+\/approve/.test(r.url()) && r.request().method() === 'POST',
  );
  await approve.click();
  expect((await approved).status(), 'the approve write succeeded').toBe(200);

  // The step is rendered from a SERVER read of the approved plan, on the plan's own
  // page — which is where a DECIDED plan lives. (Until Story MOTIR-7883 the approve
  // happened on this page and the re-navigation was MOTIR-1947's temporary refetch.)
  await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
  await expect(page.getByText(/^Added \d+ items? to your backlog$/)).toBeVisible();
}

test('approve a plan, and Motir tells you your code is ready and who can open it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-5010');

  await resetDatabase();
  resetGithubFixture();
  // A connected identity — which, since MOTIR-4753's routing verdict, is what
  // every project that reaches plan approval has: a project with no repository
  // cannot be planned at all, so it went through onboarding, and onboarding is
  // where GitHub was connected.
  const seed = await seedRepositorySet('e2e-report@example.com', 'Acme Booking', 'ABK', {
    roles: ['web', 'api'],
    withInstallation: true,
    withIdentity: true,
  });
  await signIn(page, seed.email, seed.password);

  await chapter('A plan is approved — the work is safe before code is mentioned', async () => {
    await approvePlan(page, seed);
    await expect(page.getByRole('heading', { name: 'Motir will host your code' })).toBeVisible();
    await beat();
  });

  await chapter('Nothing is asked. Not about GitHub, not about code you have', async () => {
    // ⚠️ THE ABSENCE IS THE POINT OF THIS CHAPTER, and an absence is the one thing
    // a viewer cannot see for themselves — so it is asserted here, on camera, in
    // every form the question used to take.
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect GitHub' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'I already have code' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Set up \d+ repositor/ })).toHaveCount(0);
    // One action, and it is the only one on the screen.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await beat();
  });

  await chapter('One press, and the code exists', async () => {
    const established = page.waitForResponse(
      (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    expect((await established).status(), 'the establish run committed').toBe(200);
    await expect(setupStatus(page)).toHaveText('Your code is ready', { timeout: 60_000 });
    await beat();
  });

  await chapter('It’s yours — Motir says so before it is asked', async () => {
    // RECEIPT REQUIREMENT 1 of 2. The promise is on the main line, not a footnote.
    await expect(page.getByText(/It's yours\./).first()).toBeVisible();
    await expect(page.getByText(/move it to your own GitHub whenever you want/)).toBeVisible();
    await beat();
  });

  await chapter('And this is the account that can open it', async () => {
    // RECEIPT REQUIREMENT 2 of 2, and the whole of what this story changed: the
    // panel REPORTS the invitation rather than asking for the account it already
    // had. Nothing was pressed to make this appear.
    await expect(accessReport(page)).toBeVisible();
    await expect(accessReport(page).getByText(REPO_SET_LOGIN)).toBeVisible();
    await expect(page.getByText('This is the account Motir invited')).toBeVisible();
    await expect(page.getByText(/Accept the invitation on GitHub/)).toBeVisible();
    // A report is not a silent surface — the account stays correctable, because a
    // typed handle could invite a stranger to a private repository.
    await expect(page.getByRole('link', { name: 'Use a different account' })).toBeVisible();
    await beat();
  });

  // ── What GitHub was actually asked (evidence, not narrative) ────────────────
  expect(repoCreates(), 'exactly two repositories were created').toHaveLength(2);
  for (const call of repoCreates()) {
    expect(call.body?.['private'], 'every created repository is PRIVATE').toBe(true);
  }
  const invites = collaboratorInvites();
  expect(invites, 'one invitation per repository, with NO user action').toHaveLength(2);
  expect(invites.map((c) => c.path)).toEqual([
    `/repos/${E2E_PROVISIONING_ORG}/${seed.webRepoName}/collaborators/${REPO_SET_LOGIN}`,
    `/repos/${E2E_PROVISIONING_ORG}/${seed.apiRepoName}/collaborators/${REPO_SET_LOGIN}`,
  ]);
  for (const call of invites) {
    expect(call.body?.['permission'], 'invited as an ADMIN of their own code').toBe('admin');
  }

  await chapter('Leave and come back — it still reports, and still asks nothing', async () => {
    // The set is durable (ADR §4.4). This is the case a report can silently fail:
    // a panel that knew the account only from the establish RESPONSE would go
    // quiet on a reload, and the user would meet the old question again.
    await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
    await expect(setupStatus(page)).toHaveText('Your code is ready');
    await expect(accessReport(page).getByText(REPO_SET_LOGIN)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await beat();
  });

  await chapter('The second actor: nobody to invite — so Motir says exactly that', async () => {
    // ⚠️ IN THE SAME RECORDING, deliberately. "Connected" is a property of the
    // ACTOR, not of the project, so this arm is real rather than defensive — and
    // a clip of only the happy arm would be indistinguishable from a build that
    // claims an invitation it never sent.
    await resetDatabase();
    resetGithubFixture();
    const anon = await seedRepositorySet('e2e-report-anon@example.com', 'Bramble Co', 'BRM', {
      roles: ['web'],
      withInstallation: true,
      withIdentity: false,
    });
    await signIn(page, anon.email, anon.password);
    await approvePlan(page, anon);

    const established = page.waitForResponse(
      (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    expect((await established).status()).toBe(200);
    await expect(setupStatus(page)).toHaveText('Your code is ready', { timeout: 60_000 });

    // Nothing is claimed to have been sent, and the panel says so in the RAIL's
    // own words — its door reuses `repositorySet.outcomeNeedsAccess` rather than
    // restating the string, so the two cannot drift apart.
    await expect(accessReport(page)).toContainText("Motir doesn't know your GitHub account yet");
    await expect(page.getByText('Finish setting up access', { exact: true })).toHaveCount(2);
    await expect(page.getByText('This is the account Motir invited')).toHaveCount(0);
    expect(collaboratorInvites(), 'no identity, no invitation').toHaveLength(0);
    // …and STILL no ask, on the arm where an ask would be most tempting.
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await beat();
  });
});
