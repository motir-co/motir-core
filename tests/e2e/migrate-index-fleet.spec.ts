// E2E: the migrate wizard's INDEX step, driven by the container path's ledger
// (Story MOTIR-1981 · MOTIR-1993).
//
// The index fleet's user-observable surfaces are the migrate wizard's Index
// step, which renders a row per connected repo, and — once the person has moved
// on — the bar's indexing chip and its detail. Since Story MOTIR-8246 the Index
// step is NOT a stop: Next opens as soon as an index exists in any state, and
// the per-repo progress is read in the chip's detail at the Import step. Everything MOTIR-2026 / MOTIR-2027 do (one
// container per (repo × project), boot → poll → settle as durable steps) is
// invisible from a user's seat except through this surface, so this is where a
// regression in that path becomes visible to a person. It is also the assertion
// that catches a dispatch which BATCHED: a surface fed by a per-repo
// `output.repoRef` cannot show two of three repos done unless the ledger really
// carries one row per repo.
//
// ⚠️ THE FAKE ORCHESTRATOR, SELECTED BY THE SHIPPED CONFIG SEAM. The Playwright
// server is a separately-spawned process, so an in-process mock would not reach
// it — playwright.config.ts hands it `MOTIR_FLEET_ORCHESTRATOR=fake`, the same
// variable `selectedOrchestratorProvider()` reads in production, and the first
// test asserts that seam rather than trusting it. Nothing in this lane can
// reach Fly, need a fleet token, or boot a real container (MOTIR-1984's
// provisioning is verified by the operator run MOTIR-1963, never by CI).
//
// ⚠️ WHAT DRIVES THE ROWS, AND WHY. `job_run` rows are seeded directly (the
// `jobs-dashboard.spec.ts` precedent) because the LEDGER is the entire contract
// between the container path and this surface — `docs/decisions/
// code-graph-index-fleet.md` §6: one `job_run` per repo, `succeeded`, with one
// `output.repoRef`. The writer side (boot → poll → settle against the
// orchestrator port) is not reachable from a browser-driven server at all:
// `bootIndexContainer` first mints a motir-ai run credential and resolves a
// GitHub pre-signed tarball URL, and neither has an E2E seam — so asserting it
// here would assert a harness, not the product (notes.html #112 / #152). That
// half is the vitest gate's altitude (MOTIR-1992); this spec owns the half a
// person can see, and drives every ledger state the writer can produce:
// `running`, `succeeded` with a repo ref, and `failed` with none.
//
// Per CLAUDE.md's E2E discipline every assertion waits on the AUTHORITATIVE
// signal — the polled `index-status` response and its parsed body — never a
// fixed `waitForTimeout`, and never the optimistic UI alone.

import { expect, test, type Page } from '@playwright/test';
import { selectedOrchestratorProvider } from '@/lib/orchestrator';
import type { MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';
import { resetDatabase, db, truncateJobTables } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import {
  E2E_INDEX_REPOS,
  disconnectAllRepos,
  indexRepoRef,
  recordIndexFailed,
  recordIndexRunning,
  recordIndexSucceeded,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

// The wizard polls every 3s, and a run walks start → connect → index before the
// first assertion — comfortably outside the 30s default.
test.describe.configure({ timeout: 180_000 });

const [STOREFRONT, BILLING_API, SHARED_UI] = E2E_INDEX_REPOS;

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The signed-up user's auto-created workspace is "{local-part}'s Workspace". */
async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  return ws!.id;
}

const isIndexStatus = (url: string) => url.includes('/index-status');

/**
 * Wait for a polled `index-status` response whose PARSED BODY satisfies
 * `predicate` — the authoritative signal, not the rendered pixel. Used for
 * every POSITIVE transition (a row reaching `indexed`, the gate opening).
 */
async function waitForIndexStatus(
  page: Page,
  predicate: (status: MigrateIndexStatusDto) => boolean,
): Promise<MigrateIndexStatusDto> {
  const res = await page.waitForResponse(async (r) => {
    if (!isIndexStatus(r.url()) || r.request().method() !== 'GET' || !r.ok()) return false;
    return predicate((await r.json()) as MigrateIndexStatusDto);
  });
  return (await res.json()) as MigrateIndexStatusDto;
}

/**
 * The body of a poll the server answered AFTER a write that must change
 * NOTHING — the shape a negative assertion needs.
 *
 * TWO responses, deliberately: the first may belong to a request already in
 * flight when the write landed, and asserting on it would assert the PRE-write
 * read. The second cannot — its request was issued after this call, i.e. after
 * the write. Same reason a mutation spec arms `waitForResponse` before the
 * action rather than trusting assertion auto-retry.
 */
async function statusAfterUnchangedWrite(page: Page): Promise<MigrateIndexStatusDto> {
  let last: MigrateIndexStatusDto | null = null;
  for (let i = 0; i < 2; i += 1) {
    const res = await page.waitForResponse(
      (r) => isIndexStatus(r.url()) && r.request().method() === 'GET' && r.ok(),
    );
    last = (await res.json()) as MigrateIndexStatusDto;
  }
  return last!;
}

/**
 * HOLD every `index-status` response until released — the real server answer,
 * merely delayed, so the wizard's pre-first-response LOADING state is a
 * deterministic window instead of a race. `route.continue()` means nothing is
 * stubbed: the body the wizard finally reads is the one the real route computed.
 */
async function holdIndexStatus(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let open = false;
  await page.route('**/index-status**', async (route) => {
    if (!open) await gate;
    await route.continue();
  });
  return () => {
    open = true;
    release();
  };
}

/** The Index panel — the `aria-live` region the whole step renders inside. */
const indexPanel = (page: Page) => page.locator('div[aria-live="polite"]');

/** One repo's row in the per-repo list. */
const repoRow = (page: Page, repoName: string) =>
  indexPanel(page).getByRole('listitem').filter({ hasText: repoName });

const nextButton = (page: Page) =>
  indexPanel(page).getByRole('button', { name: 'Next: import your work' });

/** The bar's indexing chip past the Index step (MOTIR-8771), and its detail. */
// The chip is client state, drawn only after the run's first status read, so it
// has no streamed or outgoing copy; `.first()` resolves the one there is. Its
// detail is a Popover dialog named by the step heading, reached by role.
const indicator = (page: Page) => page.getByTestId('migrate-index-indicator').first();
const detail = (page: Page) => page.getByRole('dialog', { name: 'Indexing your codebase' });
const detailRow = (page: Page, repo: { owner: string; name: string }) =>
  detail(page).locator(
    `[data-testid="migrate-index-detail-repo"][data-repo-ref="${indexRepoRef(repo)}"]`,
  );

/**
 * The WIZARD's error banner (`<p role="alert">`), scoped to `main`.
 *
 * ⚠️ NOT a bare `page.getByRole('alert')`. Next.js appends its own route
 * announcer — `<p id="__next-route-announcer__" role="alert">`, visually hidden
 * and OUTSIDE `main` — to the body on every client navigation, so an unscoped
 * alert query resolves to 1 on every page of this app and would make "no error
 * is shown" un-assertable. The banner this spec cares about renders inside the
 * wizard's `<section>`; `main` contains it and never contains the announcer.
 */
const errorBanner = (page: Page) => page.locator('main').getByRole('alert');

/** Sign up, create the project, connect the repo set, and walk the wizard from
 *  its start panel to the Index step — each hop awaiting its route's 200. */
async function reachIndexStep(
  page: Page,
  email: string,
  beforeAdvance?: (workspaceId: string) => Promise<void>,
): Promise<string> {
  await signUp(page, email);
  await createFirstProject(page, 'Invoicer');
  const workspaceId = await workspaceIdFor(email);
  await seedConnectedRepos(workspaceId);

  await page.goto('/onboarding/migrate');
  await expect(page.getByRole('heading', { name: 'Migrate an existing codebase' })).toBeVisible();

  const started = page.waitForResponse(
    (r) => r.url().endsWith('/api/onboarding/migrate') && r.request().method() === 'POST',
  );
  // Two projects (the sign-up default + Invoicer), so the start panel offers a
  // choice (MOTIR-8254); the repos are seeded on the workspace, so pick Invoicer.
  await page.getByRole('radio', { name: /Invoicer/ }).check();
  await page.getByRole('button', { name: 'Start with Invoicer' }).click();
  expect((await started).status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'Connect the repositories in this project' }),
  ).toBeVisible();

  const advanced = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  // Connect lists the connected repositories itself (from `index-status`, so a
  // hold on that route must be armed only now) and moves on with Continue.
  const proceed = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(proceed).toBeVisible();
  await beforeAdvance?.(workspaceId);
  await proceed.click();
  expect((await advanced).status()).toBe(200);

  return workspaceId;
}

// ── The config seam ──────────────────────────────────────────────────────────

test('@smoke the index lane selects the FAKE orchestrator through the shipped config seam', () => {
  // Asserted, not assumed. `selectedOrchestratorProvider()` is the production
  // accessor; playwright.config.ts sets `MOTIR_FLEET_ORCHESTRATOR=fake` on BOTH
  // the runner and the spawned server, so no path in this lane can resolve to
  // Fly — which is what makes "no fleet org, no token, no live container" a
  // property of the configuration rather than a promise in a comment.
  expect(selectedOrchestratorProvider()).toBe('fake');
});

// ── The journey ──────────────────────────────────────────────────────────────

test('@smoke migrate Index step — Next opens on the first read, and every repo reaches indexed in the bar', async ({
  page,
}) => {
  let releaseFirstPoll!: () => void;
  let storefrontRun!: string;
  const workspaceId = await reachIndexStep(
    page,
    `e2e-index-${Date.now()}@example.com`,
    async (seededWorkspaceId) => {
      releaseFirstPoll = await holdIndexStatus(page);
      // ⚠️ A RUN IN FLIGHT BEFORE CONNECT ADVANCES (MOTIR-9454). Connect's kick
      // (`CONNECT.ensureKicked`) enqueues a REAL index job for the first repo
      // unless an index is already in flight in the workspace. That job claims
      // its repo with its own ledger row, so the repo reads `indexing` while it
      // runs — which this spec's `queued` assertions cannot allow. It read
      // `queued` only while the claim carried a job_queue id no reader could
      // resolve. An UNCLAIMED running row covers the kick and claims nothing, so
      // every per-repo state below is the one this spec writes.
      storefrontRun = await recordIndexRunning(seededWorkspaceId);
    },
  );

  // ── LOADING: the step renders before it knows anything ────────────────────
  // No status yet, so no per-repo list — but a frame the user can read, and no
  // error. An unanswered poll must not flash the error alert or an empty panel,
  // and with no repository listed yet there is nothing to move on from.
  const panel = indexPanel(page);
  await expect(page.getByRole('heading', { name: 'Indexing your codebase' })).toBeVisible();
  await expect(panel.getByText('Waiting for repositories to be indexed')).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(nextButton(page)).toBeDisabled();

  // ── NOT A STOP (Story MOTIR-8246 · MOTIR-8768): three repos, none indexed,
  //    and Next is OPEN — the run may leave once an index exists in any state.
  releaseFirstPoll();
  const initial = await waitForIndexStatus(page, (s) => s.total === E2E_INDEX_REPOS.length);
  expect(initial.indexedCount).toBe(0);
  expect(initial.allIndexed).toBe(false);
  // The SET, sorted — the route's order is `githubRepoRepository
  // .listByInstallation`'s `(owner, name)` collation, which is a property of the
  // connected-repo read and not of this step.
  expect([...initial.repos.map((r) => r.repoRef)].sort()).toEqual(
    E2E_INDEX_REPOS.map(indexRepoRef).sort(),
  );
  await expect(panel.getByText('0 of 3 repositories done')).toBeVisible();
  for (const repo of E2E_INDEX_REPOS) {
    await expect(repoRow(page, repo.name)).toContainText('Queued');
  }
  await expect(nextButton(page)).toBeEnabled();

  // ── Leave while nothing is indexed; the progress moves to the bar ─────────
  const advanced = page.waitForResponse(
    (r) => r.url().includes('/advance') && r.request().method() === 'POST',
  );
  await nextButton(page).click();
  expect((await advanced).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Bring in your existing backlog' })).toBeVisible();

  await indicator(page).click();
  await expect(detail(page)).toBeVisible();
  for (const repo of E2E_INDEX_REPOS) {
    await expect(detailRow(page, repo)).toHaveAttribute('data-status', 'queued');
  }

  // ── IN FLIGHT: a running row is aggregate, never per-repo ─────────────────
  // An UNCLAIMED running row cannot be tied to a repo (it carries no output and
  // no repo points at it), so it must move `hasRunning` and NOTHING else. It was
  // seeded before Connect advanced (see above).
  const running = await waitForIndexStatus(page, (s) => s.hasRunning);
  expect(running.indexedCount).toBe(0);
  expect(running.repos.every((r) => r.status === 'queued')).toBe(true);

  // ── ONE repo done: its row flips, the others do not ───────────────────────
  await recordIndexSucceeded(workspaceId, indexRepoRef(STOREFRONT), storefrontRun);
  const one = await waitForIndexStatus(page, (s) => s.indexedCount === 1);
  expect(one.allIndexed).toBe(false);
  expect(one.repos.find((r) => r.repoRef === indexRepoRef(STOREFRONT))?.status).toBe('indexed');

  await expect(detailRow(page, STOREFRONT)).toHaveAttribute('data-status', 'indexed');
  await expect(detailRow(page, BILLING_API)).toHaveAttribute('data-status', 'queued');
  await expect(detailRow(page, SHARED_UI)).toHaveAttribute('data-status', 'queued');
  await expect(detail(page).getByText('1 of 3 repositories done')).toBeVisible();

  // ── A FAILED container does NOT fake success ──────────────────────────────
  // The run failed, so it wrote no `output.repoRef` — the repo has no graph and
  // the surface must keep saying so. A build that marked rows indexed
  // unconditionally, or that read the repo out of the failure message, passes
  // every happy-path assertion above and fails exactly here.
  await recordIndexFailed(workspaceId, indexRepoRef(BILLING_API));
  const afterFailure = await statusAfterUnchangedWrite(page);
  expect(afterFailure.indexedCount).toBe(1);
  expect(afterFailure.allIndexed).toBe(false);
  expect(afterFailure.repos.find((r) => r.repoRef === indexRepoRef(BILLING_API))?.status).not.toBe(
    'indexed',
  );
  await expect(detailRow(page, BILLING_API)).not.toHaveAttribute('data-status', 'indexed');

  // ── The retry succeeds, and the last repo with it ─────────────────────────
  await recordIndexSucceeded(workspaceId, indexRepoRef(BILLING_API));
  const two = await waitForIndexStatus(page, (s) => s.indexedCount === 2);
  expect(two.allIndexed).toBe(false);
  await expect(detail(page).getByText('2 of 3 repositories done')).toBeVisible();

  await recordIndexSucceeded(workspaceId, indexRepoRef(SHARED_UI));
  const all = await waitForIndexStatus(page, (s) => s.allIndexed);
  expect(all.indexedCount).toBe(E2E_INDEX_REPOS.length);
  // The chip says done for a moment, then leaves the bar.
  await expect(indicator(page)).toHaveAttribute('data-state-summary', 'done');
  await expect(indicator(page)).toHaveCount(0, { timeout: 15_000 });
});

test('@smoke migrate Index step — no connected repos renders the empty state, not an error', async ({
  page,
}) => {
  const workspaceId = await reachIndexStep(page, `e2e-index-empty-${Date.now()}@example.com`);

  const panel = indexPanel(page);
  await waitForIndexStatus(page, (s) => s.total === E2E_INDEX_REPOS.length);
  await expect(panel.getByRole('listitem')).toHaveCount(E2E_INDEX_REPOS.length);

  // The grant is reconciled down to nothing — the wizard is now on a step whose
  // subject has vanished. `total: 0` must render the waiting frame, keep the
  // gate shut, and raise no error: `allIndexed` is false for an EMPTY set as
  // much as for an unfinished one (`total > 0 && indexedCount === total`), and
  // a naive `indexedCount === total` would open Next on zero repos.
  await disconnectAllRepos(workspaceId);
  const empty = await waitForIndexStatus(page, (s) => s.total === 0);
  expect(empty.repos).toEqual([]);
  expect(empty.indexedCount).toBe(0);
  expect(empty.allIndexed).toBe(false);

  await expect(panel.getByText('Waiting for repositories to be indexed')).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(nextButton(page)).toBeDisabled();
});
