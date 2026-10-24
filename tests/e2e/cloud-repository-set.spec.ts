// Regression E2E — the post-approval repository step: approve a plan and get the
// repositories your architecture needs, then be TOLD you can reach them.
//
// ⚠️ RE-SCOPED BY MOTIR-5018 · Story MOTIR-5010 — *the repository question belongs
// to ONBOARDING*. What this spec asserted was Story MOTIR-1775's surface, and a
// large part of that surface is gone. What changed, and what each removal means:
//
//   * `mode: 'own'` (**I already have code**) and `mode: 'set'` (the editable
//     rows, the picker, per-row state, **Set up N repositories**) were DELETED by
//     MOTIR-5014. Connecting a repository the user already owns is ONBOARDING's —
//     `parseRoutingVerdict` refuses `continue` when a project has no repository,
//     so a person standing at plan approval has already answered that question.
//   * `mode: 'access'` was DELETED by MOTIR-5015. The collaborator invitation is
//     sent SERVER-SIDE at establish (and has been since MOTIR-1900, through
//     `projectRepoSetService.attachRealizedRepo` → `inviteAfterEstablish`), so the
//     `created` panel REPORTS which account it went to instead of asking.
//
// **Every assertion that drove a deleted surface is REMOVED, not weakened, and
// each removal names where the behaviour is covered now.** The tests that stayed
// are the ones whose subject survived: the journey, the equivalence, the rail's
// two outcomes, and the evidence of what GitHub was actually asked.
//
// ══ THIS IS A PROMOTED REGRESSION SPEC, NOT A RECEIPT ══
//
// It imports `./_helpers/promoted-regression`, where `acceptanceStory()` is a
// no-op and no clip is recorded: Story MOTIR-1775's receipt is approved and
// FROZEN (`docs/decisions/acceptance-receipt-lifecycle.md`), and this file's job
// since MOTIR-2769 is to go red when a regression lands. **Story MOTIR-5010's own
// receipt is a different instrument in a different lane** —
// `tests/e2e/regression-repository-report.spec.ts`, which declares
// `acceptanceStory('MOTIR-5010')` and runs under `playwright.acceptance.config.ts`.
// The two are not "two walks over one surface": one is a regression check that
// runs on every pull request, the other is one recorded run a person approves.
// `tests/e2e-acceptance-lane-imports.test.ts` enforces the split in both
// directions.
//
// ══ WHAT THE STORY CLAIMS, AND WHAT THE JOURNEY PROVES ══
//
// A plan that separates a web app from an API needs TWO repositories, and Motir
// works that out from the plan rather than asking. So the journey is the TWO-repo
// one: a one-repo spec would pass while leaving the premise untested.
//
// ⚠️ THE HEADLINE ASSERTION IS AN EQUIVALENCE (the 2026-07-30 ownership re-plan).
// A user WITH a connected GitHub identity and a user WITHOUT one walk the same
// flow through creation — no connect prompt, no consent screen, no account
// question — and both end with repositories under MOTIR's org. `equivalence
// through creation` asserts that directly rather than testing two variants.
//
// ⚠️ AND SINCE v5 THE TWO JOURNEYS NO LONGER DIVERGE INTO DIFFERENT SCREENS.
// They diverge into two ARMS of one panel: the account is known and named, or it
// is absent and the panel says so in the rail's own words. Both are asserted.
//
// ══ NO REAL REPOSITORY IS CREATED ══ The two GitHub boundaries are faked INSIDE
// the Next server (`lib/test-github-repos-mock.ts`, E2E_TEST_GITHUB_REPOS=1),
// because both are server-side `fetch`es that `page.route` cannot see. The spec
// scripts it through the control file and asserts the EXACT outbound bodies
// through the journal (`repository-set-seed.ts`).
//
// ══ WAITS ══ Every wait is on an authoritative signal (the coding convention § E2E): the
// write's own response, or the committed state the establish poll re-reads.
//
// ══ SELECTOR SCOPING ══ Two collisions survive the deletion and both are still
// worked around: `Your code is ready` is BOTH `repositorySet.ready` (the step's
// status line) and `repositorySet.outcomeReady` (the rail's line), character for
// character — the step's is always read through `setupStatus`, and when the PAIR
// is the subject it is counted rather than located; and `Finish setting up access`
// shares a prefix with `Finish setting up repositories`, so both are matched with
// `exact: true`.
//
// ⚠️ ONE COLLISION IS GONE, and its absence is now itself an assertion: `Connect
// GitHub` used to appear at three altitudes here. It appears at NONE, and
// `renders no ask about GitHub` pins that.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import {
  collaboratorInvites,
  connectGithubIdentity,
  githubJournal,
  repoCreates,
  resetGithubFixture,
  seedRepositorySet,
  setGithubControl,
  REPO_SET_LOGIN,
  type RepositorySetSeed,
} from './_helpers/repository-set-seed';

// A full approve → derive → create → invite → dispatch journey against a
// production build. The lane runs `workers: 1, retries: 0`.
test.describe.configure({ timeout: 300_000 });

// ── Locators, all scoped ─────────────────────────────────────────────────────

// ⚠️ EVERYTHING ON THIS SURFACE IS READ THROUGH `live()` (MOTIR-5116). The plan
// detail page renders BOTH halves this spec counts — `RepositorySetStep`'s status
// line and `PlanReviewRail`'s outcome — inside the shell's `<main>`, and neither
// carries a role of its own. That matters more here than anywhere else in this
// sweep, because most of the assertions below are COUNTS of a string that
// legitimately appears twice: React's streamed `<div hidden id="S:0">` copy and
// the outgoing subtree a client-side navigation leaves mounted would not trip
// strict mode on a `toHaveCount`, they would silently DOUBLE the number it reads
// (`CLAUDE.md` § *a boundary makes every unscoped locator a race*). Scoping to
// `main` — itself resolved through the accessibility tree — is what keeps a
// count a count.
/** The plan detail page's live route subtree: the step AND the rail. */
const live = (page: Page) => page.getByRole('main');

/** The default path's single status line (`repo-setup-status`). */
const setupStatus = (page: Page) => live(page).getByTestId('repo-setup-status');

/** The `created` panel's REPORT — either arm (`repo-access-report`, MOTIR-5015).
 *  Arm A names the invited account; arm B says nobody has been invited yet. */
const accessReport = (page: Page) => live(page).getByTestId('repo-access-report');

// ⚠️ NO `repo-row-*` LOCATOR ANY MORE. `RepositoryRow` was deleted with the
// technical path (MOTIR-5014), so there is no per-row surface on this route at
// all. The per-row invitation states live on `/settings/project/code-access`,
// which this spec does not walk — that surface has its own coverage and this
// story did not touch it.

// ── Journey helpers ──────────────────────────────────────────────────────────

/**
 * Approve the plan in the planning overlay's footer and wait for the APPROVE
 * RESPONSE — the authoritative signal. The step is server-rendered from the
 * approved plan, so asserting it before the write lands would race the round trip.
 */
async function approvePlan(page: Page, seed: RepositorySetSeed): Promise<void> {
  // Undecided, so it is approved where it is decided — the planning overlay's footer
  // (Story MOTIR-7883 · MOTIR-7887).
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
  // page — which is where a DECIDED plan lives. The rail there is read-only and says
  // so: the plan is safe BEFORE anything about code is asked (ADR §4.3), which is
  // the honesty the step depends on. (Until Story MOTIR-7883 the approve happened
  // on this page and the re-navigation was MOTIR-1947's temporary refetch.)
  await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
  await expect(live(page).getByText(/^Added \d+ items? to your backlog$/)).toBeVisible();
}

/**
 * Press **Continue** and wait for the establish to commit.
 *
 * ⚠️ THIS REPLACES `openTechnicalPath` + **Set up N repositories** (MOTIR-5014).
 * There is one way to establish a set now, and it is the default path's only
 * action — which is the point of the story rather than an incidental
 * simplification.
 */
async function establish(page: Page): Promise<void> {
  // Assert the STEP is on the page before reaching for a control inside it. The
  // step renders only when the project's set has rows, and the set is derived by
  // a best-effort post-commit pass that SWALLOWS its failures — so a derivation
  // that broke shows up here as "the button never appeared", which is an
  // unreadable way to learn that the set is empty.
  await expect(
    page.getByRole('heading', { name: 'Motir will host your code' }),
    'the establish step is on the page (an empty set renders no step at all)',
  ).toBeVisible();
  const established = page.waitForResponse(
    (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await established).status(), 'the establish run committed').toBe(200);
  await expect(setupStatus(page)).toHaveText('Your code is ready', { timeout: 60_000 });
}

/** The `owner/name` a create landed on, read off the journal's own request. */
function createdNames(): string[] {
  return repoCreates().map((c) => String(c.body?.['name']));
}

/**
 * WHICH ACCOUNT a create call targets — the assertion the whole ownership
 * decision rests on, and it is NOT simply "the org appears in the path".
 *
 * The two endpoints carry the target differently, and the template one is the
 * trap: `POST /repos/{templateOwner}/{template}/generate` names the STARTER's
 * owner in its path (`moooon-B-V`) and the destination only in its BODY's
 * `owner`. Asserting on the path alone would therefore read the template's owner
 * as the repository's owner and pass for entirely the wrong reason.
 */
function createTargetOwner(call: { path: string; body: Record<string, unknown> | null }): string {
  if (typeof call.body?.['owner'] === 'string') return call.body['owner'];
  return /^\/orgs\/([^/]+)\/repos$/.exec(call.path)?.[1] ?? '';
}

/** Ask the REAL dispatch surface for one item and return its payload. */
async function dispatchNext(
  page: Page,
  projectKey: string,
  excludeIds: string[] = [],
): Promise<Record<string, unknown>> {
  const res = await page.request.post('/api/ready/next', {
    data: { projectKey, excludeIds },
  });
  expect(res.status(), 'the dispatch surface answered').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE JOURNEY — approve, and be told your code is ready and who can open it.
// ═════════════════════════════════════════════════════════════════════════════

test('approve a plan with two parts, get a repository for each, and be INVITED without asking', async ({
  page,
  chapter,
  beat,
}) => {
  await resetDatabase();
  resetGithubFixture();
  // ⚠️ `withIdentity: true` — AND THAT IS THE CHANGE THIS STORY MADE. This
  // journey used to run with NO identity, because the pre-v5 main line was
  // "approve, then be prompted to connect". There is no prompt any more: the
  // invitation rides the establish, so the interesting journey is the one where
  // Motir HAS the account, which after MOTIR-4753 is every project that reached
  // plan approval at all. The no-identity arm is asserted below, in its own test.
  const seed = await seedRepositorySet('e2e-repo-set@example.com', 'Acme Booking', 'ABK', {
    roles: ['web', 'api'],
    withInstallation: true,
    withIdentity: true,
  });
  await signIn(page, seed.email, seed.password);

  await chapter('The plan is approved — and only then is code discussed', async () => {
    await approvePlan(page, seed);
    // The step takes the canvas. ONE sentence and ONE primary: no repository
    // name, role or count reaches it, and no branch either.
    await expect(page.getByRole('heading', { name: 'Motir will host your code' })).toBeVisible();
    await beat();
  });

  await chapter('Nothing is asked about GitHub, or about code you already have', async () => {
    // ⚠️ ASSERTED AS AN ABSENCE, which is what the story's claim actually is. The
    // door into the technical path and the connect ask are both gone, and a
    // deletion that leaves either one reachable is the regression this pins.
    await expect(page.getByRole('button', { name: 'I already have code' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect GitHub' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Set up \d+ repositor/ })).toHaveCount(0);
    await beat();
  });

  await chapter('Motir makes both repositories — one press, no questions', async () => {
    await establish(page);
    await beat();
  });

  // ── What GitHub was actually asked (not recorded — evidence, not narrative) ──
  const creates = repoCreates();
  expect(creates, 'exactly two repositories were created').toHaveLength(2);
  expect(createdNames()).toEqual([seed.webRepoName, seed.apiRepoName]);
  for (const call of creates) {
    expect(call.body?.['private'], 'every created repository is PRIVATE').toBe(true);
  }
  // The `web` row seeds from the platform starter (a template `generate`); the
  // `api` row is an initialised repo in Motir's org. Both land under Motir's org.
  expect(creates[0]!.path, 'the web row is templated from the starter').toMatch(/\/generate$/);
  expect(creates[0]!.body?.['owner']).toBe(E2E_PROVISIONING_ORG);
  expect(creates[1]!.path).toBe(`/orgs/${E2E_PROVISIONING_ORG}/repos`);
  // NOT ONE call went to a user account — the whole ownership decision, asserted.
  expect(githubJournal().some((c) => c.path.startsWith('/user/repos'))).toBe(false);

  await chapter('It’s yours — Motir says so, before it is asked', async () => {
    await expect(page.getByText(/It's yours\./).first()).toBeVisible();
    await expect(
      live(page).getByText(/move it to your own GitHub whenever you want/),
    ).toBeVisible();
    await beat();
  });

  await chapter('And here is the account that can open it', async () => {
    // ⚠️ THE HEADLINE ASSERTION OF THIS STORY. The panel REPORTS: it names the
    // account the invitation went to, rather than offering a button labelled
    // `Connect GitHub` to somebody who connected GitHub months ago.
    await expect(accessReport(page)).toBeVisible();
    await expect(accessReport(page).getByText(REPO_SET_LOGIN)).toBeVisible();
    await expect(live(page).getByText('This is the account Motir invited')).toBeVisible();
    await expect(live(page).getByText(/Accept the invitation on GitHub/)).toBeVisible();
    // A report is not a silent surface: the account stays correctable, because a
    // typed handle could invite a stranger to a private repository.
    await expect(page.getByRole('link', { name: 'Use a different account' })).toBeVisible();
    // The one forward action is the JOURNEY's.
    await expect(page.getByRole('link', { name: 'Go to my backlog' })).toBeVisible();
    await beat();
  });

  // ── The invitations, as GitHub was actually asked (MOTIR-1900) ──────────────
  const invites = collaboratorInvites();
  expect(invites, 'one invitation per created repository, with no user action').toHaveLength(2);
  expect(invites.map((c) => c.path)).toEqual([
    `/repos/${E2E_PROVISIONING_ORG}/${seed.webRepoName}/collaborators/${REPO_SET_LOGIN}`,
    `/repos/${E2E_PROVISIONING_ORG}/${seed.apiRepoName}/collaborators/${REPO_SET_LOGIN}`,
  ]);
  for (const call of invites) {
    expect(call.body?.['permission'], 'invited as an ADMIN of their own code').toBe('admin');
  }

  await chapter('Leave, come back — it still reports rather than asks', async () => {
    // The set is a durable property of the project (ADR §4.4), so the panel is
    // the same on a second visit. This is the case a report can silently fail:
    // a panel that only knows the account from the establish RESPONSE would go
    // quiet on a reload, and the user would meet the old question again.
    await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
    await expect(setupStatus(page)).toHaveText('Your code is ready');
    await expect(accessReport(page).getByText(REPO_SET_LOGIN)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await beat();
  });

  await chapter('Two parts, two repositories — and every task knows which is its own', async () => {
    // Two items in one project, two different repositories, no ambiguity —
    // asserted against the REAL dispatch surface the CLI calls.
    const first = await dispatchNext(page, seed.projectKey);
    const second = await dispatchNext(page, seed.projectKey, [String(first['id'])]);
    const byTitle = new Map([first, second].map((item) => [String(item['title']), item]));

    const frontend = byTitle.get(seed.frontendTitle)!;
    const backend = byTitle.get(seed.backendTitle)!;
    expect(frontend, 'the frontend item was dispatched').toBeDefined();
    expect(backend, 'the backend item was dispatched').toBeDefined();
    expect(frontend['targetRepo'], 'the frontend item names the web repo').toBe(seed.webRepoName);
    expect(backend['targetRepo'], 'the backend item names the api repo').toBe(seed.apiRepoName);
    // And HOW to obtain each — the clone URL the CLI checks out (MOTIR-1783).
    expect(String(frontend['targetRepoCloneUrl'])).toContain(
      `${E2E_PROVISIONING_ORG}/${seed.webRepoName}`,
    );
    expect(String(backend['targetRepoCloneUrl'])).toContain(
      `${E2E_PROVISIONING_ORG}/${seed.apiRepoName}`,
    );
    await beat();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE STATES THE JOURNEY SKIPS
// ═════════════════════════════════════════════════════════════════════════════

test('NO connected identity: nothing claims an invitation, and the rail says what is unfinished', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-anon@example.com', 'Anon Co', 'ANO', {
    roles: ['web'],
    withInstallation: true,
    withIdentity: false,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await establish(page);

  // ⚠️ ARM B. "Connected" is a property of the ACTOR, not of the project — a
  // teammate who did not run onboarding can approve a plan — so this arm is real
  // rather than defensive.
  await expect(accessReport(page)).toBeVisible();
  await expect(accessReport(page)).toContainText("Motir doesn't know your GitHub account yet");
  // ⚠️ AND IT SAYS IT IN THE RAIL'S OWN WORDS, because the panel's door reuses
  // `repositorySet.outcomeNeedsAccess` rather than restating the string. Two on
  // the page: the panel's door and the rail's outcome.
  await expect(live(page).getByText('Finish setting up access', { exact: true })).toHaveCount(2);
  const door = page.getByRole('link', { name: 'Finish setting up access' });
  await expect(door).toHaveAttribute('href', '/settings/project/code-access');
  // Nothing was sent, so nothing claims it was.
  expect(collaboratorInvites(), 'no identity, no invitation').toHaveLength(0);
  await expect(live(page).getByText('This is the account Motir invited')).toHaveCount(0);
  // The rail must not claim the code is ready: the step's own line says it, and
  // the rail's says the opposite — exactly one of the two identical strings.
  await expect(live(page).getByText('Your code is ready')).toHaveCount(1);
  // …and still no ask, on the arm where an ask would be most tempting.
  await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
});

test('the rail flips to “Your code is ready” once the invitation goes out', async ({ page }) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-outcome@example.com', 'Outcome Co', 'OUT', {
    roles: ['web'],
    withInstallation: true,
    withIdentity: false,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await establish(page);

  // Created, but nobody has been invited — the rail must not claim it is ready.
  await expect(live(page).getByText('Finish setting up access', { exact: true })).toHaveCount(2);
  await expect(live(page).getByText('Your code is ready')).toHaveCount(1);

  // ⚠️ THE RECOVERY PATH, AND IT IS NO LONGER ON THIS SURFACE (MOTIR-5015). The
  // user connects an identity wherever they connect it, and the invitation is
  // sent by the establish — so this drives a SECOND establish rather than a
  // button on the step, which is what a real retry (**Try again**, or a later
  // visit that finds unresolved rows) does.
  await connectGithubIdentity(seed.userId);
  // ⚠️ NO `page.waitForResponse` HERE, deliberately. The write is driven through
  // `page.request` — an `APIRequestContext`, which does NOT emit the page's
  // `response` events — so a wait armed against it can never resolve and the
  // test ends holding a pending promise. The response object IS the
  // authoritative signal (the coding convention § E2E: "the write's own response"), and the
  // committed state is re-read by the navigation below.
  const res = await page.request.post(`/api/projects/${seed.projectKey}/repositories/access`, {
    data: {},
  });
  expect(res.status(), 'the invitations were sent').toBe(200);

  await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
  // Now BOTH the step's status line and the rail's outcome read "Your code is
  // ready" — the one place those two identical strings legitimately co-occur.
  await expect(live(page).getByText('Your code is ready')).toHaveCount(2);
  await expect(live(page).getByText('Finish setting up access', { exact: true })).toHaveCount(0);
  await expect(accessReport(page).getByText(REPO_SET_LOGIN)).toBeVisible();
});

test('equivalence through creation: a connected identity changes NOTHING about how the code is made', async ({
  page,
}) => {
  // THE ACCEPTANCE FOR THE OWNERSHIP DECISION (the 2026-07-30 re-plan). Run the
  // SAME journey twice — once with a GitHub identity, once without — and pin that
  // the creation half is byte-for-byte identical. Asserted as an equivalence
  // rather than as two variants, because "the two audiences get the same flow" is
  // the claim, and two independent tests could both pass while diverging.
  //
  // ⚠️ IT IS A STRONGER CLAIM SINCE v5, and worth saying so: the two journeys used
  // to diverge into different SCREENS after creation (one met the connect prompt,
  // one met the invited state). They now diverge into two arms of one panel, so
  // the equivalence covers everything up to a single line of copy.
  const runs: { creates: unknown[]; heading: string }[] = [];

  for (const withIdentity of [false, true]) {
    await resetDatabase();
    resetGithubFixture();
    const seed = await seedRepositorySet(
      `e2e-repo-equiv-${withIdentity ? 'id' : 'anon'}@example.com`,
      'Equivalence Co',
      withIdentity ? 'EQI' : 'EQA',
      { roles: ['web', 'api'], withInstallation: true, withIdentity },
    );
    await signIn(page, seed.email, seed.password);
    await approvePlan(page, seed);

    // The DEFAULT path is identical for both: one sentence, one primary. No
    // account question, no consent screen, no GitHub prompt before or during
    // creation — asserted as an ABSENCE, which is what the claim actually is.
    const heading = await page.getByRole('heading', { level: 2 }).first().innerText();
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'I already have code' })).toHaveCount(0);

    await establish(page);

    runs.push({
      // Normalize away the per-run project slug — the SHAPE of the two create
      // calls is the invariant, not the names the two tenants happened to get.
      creates: repoCreates().map((c) => ({
        path: c.path.replace(seed.projectSlug, '<slug>'),
        private: c.body?.['private'],
        // The DESTINATION account, resolved per endpoint shape — never the raw
        // path, which on the template call names the STARTER's owner.
        targetOwner: createTargetOwner(c),
        name: String(c.body?.['name']).replace(seed.projectSlug, '<slug>'),
      })),
      heading,
    });
  }

  expect(runs[0]!.heading, 'both audiences are told the same thing').toBe(runs[1]!.heading);
  expect(runs[0]!.creates, 'both audiences get the same repositories, made the same way').toEqual(
    runs[1]!.creates,
  );
  // …and in BOTH runs the repositories are Motir's, never the user's account.
  for (const run of runs) {
    expect(run.creates).toHaveLength(2);
    for (const call of run.creates as { targetOwner: string; private: unknown }[]) {
      expect(call.targetOwner, 'created in MOTIR’s org, for both audiences').toBe(
        E2E_PROVISIONING_ORG,
      );
      expect(call.private, 'private, for both audiences').toBe(true);
    }
  }
});

test('a GitHub refusal does not cost the user their code — the repositories still land', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  // Refuse the INVITATION, not the create: the repositories exist either way, and
  // that is the graceful-degradation contract MOTIR-1900 specified.
  const seed = await seedRepositorySet('e2e-repo-refused@example.com', 'Refused Co', 'REF', {
    roles: ['web'],
    withInstallation: true,
    withIdentity: true,
  });
  // Keyed by repo NAME, which is why the seed has to exist first — the fake
  // refuses the collaborator PUT for exactly this repository and nothing else.
  setGithubControl({
    inviteFailures: {
      [seed.webRepoName]: { status: 403, message: 'Must have admin rights to Repository.' },
    },
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await establish(page);

  // The repository was created and the step says so. A refused invitation must
  // not present as a failed establish.
  expect(repoCreates(), 'the repository was still created').toHaveLength(1);
  await expect(setupStatus(page)).toHaveText('Your code is ready');
  await expect(page.getByText(/It's yours\./).first()).toBeVisible();

  // ⚠️ AND THE PANEL SAYS WHAT ACTUALLY HAPPENED — ASSERTED POSITIVELY, which is
  // the assertion whose ABSENCE let bug MOTIR-5036 ship. Everything else in this
  // test denies a failure presentation, and all of it passed while the panel
  // read "Motir doesn't know your GitHub account yet" — a fact about the user
  // that is untrue, four inches under "Your code is ready", for an account the
  // seed connected and the product had just used in the call GitHub refused.
  // A negative-only test cannot tell a correct sentence from a wrong one.
  const report = accessReport(page);
  await expect(report).toContainText('GitHub turned the invitation down');
  await expect(report).toContainText(`@${REPO_SET_LOGIN}`);
  // The arm that used to answer for this state must NOT be the one on screen.
  await expect(report).not.toContainText("Motir doesn't know your GitHub account yet");
  // No new destination: the refusal is retried where it is owned.
  await expect(page.getByRole('link', { name: 'Finish setting up access' })).toHaveAttribute(
    'href',
    '/settings/project/code-access',
  );

  // ⚠️ THE NOTIFICATION IS NOT ASSERTED HERE, and this is the explicit statement
  // MOTIR-5018 requires rather than a silent omission.
  //
  // The lane CAN drive the refusal — `setGithubControl({ inviteStatus: 403 })` is
  // exactly what this test does — so the limitation is not "the refusal is
  // unreachable". What this spec does not do is assert the BELL, because doing so
  // would mean opening the notification drawer and reading a row, which is the
  // notification surface's own subject and not this step's. The row is covered
  // where it lives:
  //
  //   * `tests/projectRepos/projectRepoAccessService.test.ts` — that a refusal
  //     writes exactly ONE notification, that a retry writes no second, that a
  //     SUCCESS writes none, and that the channel gate suppresses it;
  //   * `tests/components/notification-drawer.test.tsx` — that the row renders
  //     the design's copy, routes to code access, and draws no actor.
  //
  // What IS asserted here is the half only a browser can see: that the refusal
  // leaves this surface honest.
  //
  // ⚠️ ASSERTED BY THE STEP'S OWN FAILURE COPY, NOT BY `getByRole('alert')`.
  // Radix's `Toast.Provider` mounts an EMPTY `role="alert"` live region for the
  // life of the shell — it is how a toast is announced — so `getByRole('alert')`
  // is ≥ 1 on every authed page and a `toHaveCount(0)` against it can never pass.
  // The step's failure arm is the thing being denied, so it is what gets named.
  await expect(live(page).getByText("Motir couldn't finish setting up your code")).toHaveCount(0);
  await expect(live(page).getByText(/Your plan is safe in your backlog/)).toHaveCount(0);
});

/* ⚠️ SIX TESTS WERE REMOVED BY MOTIR-5018, NOT WEAKENED — each drove a surface
   that no longer exists, and each names where its behaviour is covered now:

   * `the degenerate case reads as ONE question` — the one-row technical path.
     The DEFAULT path was always identical for one row and three (design panel
     1b), and `equivalence through creation` still pins that both audiences see
     one heading. There is no list chrome left to be absent from.
   * `a row that fails leaves its sibling alone, keeps its recoveries, and
     retries on its own` — per-row recovery controls, all on the deleted rows.
     Per-row independence is asserted at the service, over real Postgres, in
     `tests/projectRepos/projectRepoProvisioningService.test.ts`.
   * `a skipped row completes the flow` — `skipRow` was a row control.
   * `an invitation that fails does not fail the row` — replaced above by
     `a GitHub refusal does not cost the user their code`, which asserts the same
     contract on the surface that survived.
   * `all three invitation states render at once` — the per-row invitation lines
     moved to `/settings/project/code-access`, which draws all three per person
     and per repository and has its own coverage.
   * `the in-flight state is visible per row` — there is no per-row surface. The
     step's ONE status line and its poll are asserted by `establish()` on every
     test in this file, which waits on the committed state rather than a frame.

   None of these was deleted because it was inconvenient: each asserted a control
   this story removed, and rewriting one to assert the new surface would have been
   a second copy of a test already here. */
