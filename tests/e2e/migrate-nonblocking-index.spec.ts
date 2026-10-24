// E2E: onboarding moves on while the code index builds (Story MOTIR-8246 ·
// MOTIR-8774), against Mo's approved design `design/onboarding-migrate/
// index-nonblocking--enter-motir.mock.html` (MOTIR-8767 revision A): no plan is
// drafted in onboarding, no questions step, and the Import step ends the wizard
// with Enter Motir, which never waits on the index or on an import.
//
// The index state is driven through the LEDGER, exactly as
// `migrate-index-fleet.spec.ts` drives it: a `system.code-graph-index` `job_run`
// row plus the repo's `indexing_run_id` claim on it (`migrate-index-seed.ts`).
// The wizard, the indicator, the routes and the run are all real.
//
// Per CLAUDE.md's E2E discipline every step waits on an authoritative signal —
// the route's response and its body, an element's state, or the URL — and never
// on a fixed wait.

import { expect, test, type Page, type Response } from '@playwright/test';
import type { MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';
import { resetDatabase, adminDb, truncateJobTables } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { assertNoRawKeys, msg } from './_helpers/i18n-walk';
import {
  E2E_INDEX_REPOS,
  claimIndexRun,
  indexRepoRef,
  recordIndexFailed,
  recordIndexRunning,
  seedConnectedRepos,
  type IndexSeedRepo,
} from './_helpers/migrate-index-seed';

test.describe.configure({ timeout: 180_000 });

const [STOREFRONT, BILLING_API] = E2E_INDEX_REPOS;

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type IndexState = 'running' | 'failed';
type Locale = 'en' | 'zh';

const isPost = (r: Response, tail: string) =>
  r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(tail);
const isIndexStatus = (r: Response) =>
  r.request().method() === 'GET' && r.url().includes('/index-status') && r.ok();

/** A polled `index-status` answer whose parsed body satisfies `predicate`. */
async function waitForIndexStatus(
  page: Page,
  predicate: (status: MigrateIndexStatusDto) => boolean,
): Promise<MigrateIndexStatusDto> {
  const res = await page.waitForResponse(
    async (r) => isIndexStatus(r) && predicate((await r.json()) as MigrateIndexStatusDto),
  );
  return (await res.json()) as MigrateIndexStatusDto;
}

const repoStatus = (s: MigrateIndexStatusDto, repo: IndexSeedRepo = STOREFRONT) =>
  s.repos.find((r) => r.repoRef === indexRepoRef(repo))?.status;

// The chip is client state, drawn only after the run's first status read, so it
// has no streamed or outgoing copy; `.first()` resolves the one there is. Its
// detail is a Popover dialog named by the step heading, reached by role.
const indicator = (page: Page) => page.getByTestId('migrate-index-indicator').first();
const detail = (page: Page, locale: Locale = 'en') =>
  page.getByRole('dialog', { name: msg(locale, 'onboardingMigrate.index.heading') });
const detailRow = (page: Page, locale: Locale = 'en', repo: IndexSeedRepo = STOREFRONT) =>
  detail(page, locale).locator(
    `[data-testid="migrate-index-detail-repo"][data-repo-ref="${indexRepoRef(repo)}"]`,
  );
const enterButton = (page: Page, locale: Locale) =>
  page.getByRole('button', { name: msg(locale, 'onboardingMigrate.enter.cta') });

/**
 * Sign up (in `locale`), connect ONE repository (`repo`) whose index is `index`, and walk
 * the wizard to the Import step: Start → Connect → Index → Import. Asserts on
 * the way that Index does not hold the person: its Next opens on the first read
 * while the index is still `index`. Returns the workspace and the run.
 */
async function reachImportStep(
  page: Page,
  index: IndexState,
  locale: Locale = 'en',
  repo: IndexSeedRepo = STOREFRONT,
): Promise<{ workspaceId: string; runId: string }> {
  const email = `e2e-nonblocking-${locale}-${index}-${Date.now()}@example.com`;
  await signUp(page, email);
  await createFirstProject(page, 'Invoicer');
  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const workspaceId = ws.id;
  if (locale !== 'en') await adminDb.user.update({ where: { email }, data: { locale } });

  // ⚠️ BOTH STATES ARE SEEDED `running` UNTIL CONNECT HAS ADVANCED (MOTIR-9444).
  // Connect's kick (`CONNECT.ensureKicked`) enqueues a REAL index job unless an
  // index is in flight in the workspace or one succeeded for the ref, and a
  // failed run is neither. That job's claim overwrote the seeded one, and the
  // first read raced it: `failed` when the read won, `queued` when the job won.
  // A run in flight covers the kick, so nothing but this spec writes the claim,
  // and the failure lands after Connect, where a real one would.
  await seedConnectedRepos(workspaceId, [repo]);
  const runRow = await recordIndexRunning(workspaceId);
  await claimIndexRun(workspaceId, repo, runRow);

  await page.goto('/onboarding/migrate');
  await page.getByRole('radio', { name: /Invoicer/ }).check();
  const started = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/onboarding/migrate',
  );
  await page
    .getByRole('button', {
      name: msg(locale, 'onboardingMigrate.start.ctaFor', { project: 'Invoicer' }),
    })
    .click();
  const startResp = await started;
  expect(startResp.status()).toBe(200);
  const runId = ((await startResp.json()) as { id: string }).id;

  // Connect → Index.
  const proceed = page.getByRole('button', {
    name: msg(locale, 'onboardingMigrate.connect.continue'),
    exact: true,
  });
  await expect(proceed).toBeEnabled({ timeout: 30_000 });
  let advanced = page.waitForResponse((r) => isPost(r, '/advance'));
  await proceed.click();
  expect((await advanced).status()).toBe(200);
  // The kick has run and found the index in flight; now the claimed run fails.
  if (index === 'failed') await recordIndexFailed(workspaceId, indexRepoRef(repo), runRow);

  // Index is not a stop: a read lists the repository still unfinished, and Next
  // is open anyway. The failed case waits for the read that carries the
  // failure, since a poll may still have seen the run in flight.
  const expected = index === 'running' ? 'indexing' : 'failed';
  const first = await waitForIndexStatus(
    page,
    (s) => s.total === 1 && repoStatus(s, repo) === expected,
  );
  expect(repoStatus(first, repo)).toBe(expected);
  expect(first.allIndexed).toBe(false);
  const next = page.getByRole('button', { name: msg(locale, 'onboardingMigrate.index.next') });
  await expect(next).toBeEnabled();
  advanced = page.waitForResponse((r) => isPost(r, '/advance'));
  await next.click();
  expect((await advanced).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: msg(locale, 'onboardingMigrate.import.heading') }),
  ).toBeVisible();

  return { workspaceId, runId };
}

/** Enter Motir: one POST to enter, answered 200 with a completed run, then the
 *  project. Nothing about the index or a plan is started on the way. */
async function enterMotir(page: Page, locale: Locale, runId: string): Promise<void> {
  const planRequests: string[] = [];
  page.on('request', (req) => {
    const u = new URL(req.url()).pathname;
    if (/\/generate|\/discovery|\/api\/ai\//.test(u)) planRequests.push(u);
  });
  const entered = page.waitForResponse((r) => isPost(r, '/enter'));
  await enterButton(page, locale).click();
  const resp = await entered;
  expect(resp.status()).toBe(200);
  expect(await resp.json()).toMatchObject({ id: runId, step: 'done', status: 'completed' });
  await page.waitForURL((url) => url.pathname === '/roadmap', { timeout: 30_000 });

  const run = await adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id: runId } });
  expect(run).toMatchObject({ step: 'done', status: 'completed', generateJobId: null });
  expect(planRequests).toEqual([]);
}

// ── 1–4 · walk past index, the indicator, the rail, Enter Motir ─────────────

test('walks past a running index to Import, shows the indicator, and enters Motir', async ({
  page,
}) => {
  const { runId } = await reachImportStep(page, 'running');

  // 1 · The indicator names the repository as indexing.
  await expect(indicator(page)).toHaveAttribute('data-state-summary', 'indexing');
  await expect(indicator(page)).toContainText(STOREFRONT.name);

  // 2 · Its detail lists the repository and its state; Esc and the chip close
  //     it; the step underneath does not move.
  const heading = page.getByRole('heading', {
    name: msg('en', 'onboardingMigrate.import.heading'),
  });
  await indicator(page).click();
  await expect(detail(page)).toBeVisible();
  await expect(detailRow(page)).toHaveAttribute('data-status', 'indexing');
  await page.keyboard.press('Escape');
  await expect(detail(page)).toBeHidden();
  await indicator(page).click();
  await expect(detail(page)).toBeVisible();
  await indicator(page).click();
  await expect(detail(page)).toBeHidden();
  await expect(heading).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/onboarding/migrate');

  // 3 · The rail asks no questions and names no direction.
  const rail = page.getByRole('navigation', { name: msg('en', 'onboardingMigrate.rail.title') });
  await expect(rail).not.toContainText(msg('en', 'onboardingMigrate.rail.discoveryStep'));
  await expect(rail).not.toContainText(msg('en', 'onboardingMigrate.rail.directionGroup'));
  await expect(rail).toContainText(msg('en', 'onboardingMigrate.rail.subtitle'));

  // 4 · Enter Motir while the index is still running.
  await expect(enterButton(page, 'en')).toBeEnabled();
  await enterMotir(page, 'en', runId);
  // …and the index was left exactly where it was.
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { owner: STOREFRONT.owner, name: STOREFRONT.name },
  });
  const claimed = await adminDb.jobRun.findUniqueOrThrow({ where: { id: repo.indexingRunId! } });
  expect(claimed.status).toBe('running');
});

// ── 5 · a failed index, Enter Motir still open, and the retry ───────────────

// Pressing Retry enqueues a REAL `system.code-graph-index` job, which the e2e
// worker keeps running after the next `beforeEach` truncates the ledger, and whose
// claim writes every `github_repo` row of that owner/name across workspaces. So
// this case indexes a repository (`billing-api`) no other case in the file uses,
// and a job that outlives it cannot move a later case's `storefront` claim.
test('a failed index reads failed with a retry, and Enter Motir stays enabled', async ({
  page,
}) => {
  await reachImportStep(page, 'failed', 'en', BILLING_API);

  await expect(indicator(page)).toHaveAttribute('data-state-summary', 'failed');
  await expect(enterButton(page, 'en')).toBeEnabled();

  await indicator(page).click();
  await expect(detailRow(page, 'en', BILLING_API)).toHaveAttribute('data-status', 'failed');
  await expect(detailRow(page, 'en', BILLING_API)).toContainText(
    msg('en', 'onboardingMigrate.indexing.rowFailed'),
  );

  const retried = page.waitForResponse((r) => isPost(r, '/index-retry'));
  const nextRead = page.waitForResponse(isIndexStatus);
  await detailRow(page, 'en', BILLING_API)
    .getByRole('button', { name: msg('en', 'planningWorkspace.indexing.retry') })
    .click();
  const resp = await retried;
  expect(resp.status()).toBe(200);
  expect(await resp.json()).toEqual({ repoRef: indexRepoRef(BILLING_API), status: 'queued' });
  // The read the retry triggers is the one it is recorded against.
  const after = (await (await nextRead).json()) as MigrateIndexStatusDto;
  expect(repoStatus(after, BILLING_API)).toBe('queued');
  await expect(detailRow(page, 'en', BILLING_API)).toHaveAttribute('data-status', 'queued');
  await expect(enterButton(page, 'en')).toBeEnabled();
});

// ── 6 · the same, in Chinese ────────────────────────────────────────────────

test('in Chinese: the indicator, its detail, Enter Motir and the failed state', async ({
  page,
}) => {
  // Case 1 and 5 under zh: a failed index reached past Index, read in the bar.
  await reachImportStep(page, 'failed', 'zh');
  await expect(indicator(page)).toHaveAttribute('data-state-summary', 'failed');
  // The hint sits beside Enter Motir in the step's footer.
  await expect(
    enterButton(page, 'zh')
      .locator('xpath=..')
      .getByText(msg('zh', 'onboardingMigrate.enter.hint'), { exact: true }),
  ).toBeVisible();
  await indicator(page).click();
  await expect(detail(page, 'zh')).toContainText(msg('zh', 'onboardingMigrate.index.heading'));
  await expect(detailRow(page, 'zh')).toContainText(
    msg('zh', 'onboardingMigrate.index.state.failed'),
  );
  await expect(detailRow(page, 'zh')).toContainText(
    msg('zh', 'onboardingMigrate.indexing.rowFailed'),
  );
  await expect(
    detailRow(page, 'zh').getByRole('button', {
      name: msg('zh', 'planningWorkspace.indexing.retry'),
    }),
  ).toBeVisible();
  await assertNoRawKeys(page, 'the migrate Import step with the index detail open (zh)');
  await page.keyboard.press('Escape');

  // Case 4 under zh.
  const runId = (
    await adminDb.migrateOnboarding.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  ).id;
  await expect(enterButton(page, 'zh')).toBeEnabled();
  await enterMotir(page, 'zh', runId);
});
