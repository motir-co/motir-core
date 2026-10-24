import type { Cookie, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn, signUpToOnboarding } from './_helpers/shell-session';
import { seedHostedRun, seedReadyHostedCard } from './_helpers/hosted-run-seed';
import { appendEvents, ingestContext } from './_helpers/agent-run-seed';
import {
  fakeContainerForRun,
  fakeContainerSettled,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { paidOrgState, resetBillingFixture, setOrgBillingState, TIERS } from './_helpers/billing';
import { hostedRunSeamEnv } from './_helpers/job-worker-process';
import { clearFleetRows } from './_helpers/fleet-monitor-seed';
import { fakePersistentOrchestrator } from '@motir/orchestrator';
import en from '@/messages/en.json';

// EACH ORGANISATION IS HELD TO ITS PLAN'S CAPS (Story MOTIR-9363 · MOTIR-9379) —
// the story's acceptance receipt, for a STANDARD organisation: one agent run at
// once, one agent per person, and the platform fleet view naming the plan.
//
// One recorded test, because the lane publishes ONE clip per story (a new
// recording supersedes the last): the three acts are its chapters.
//
//   1. A member runs card A hosted, then card B. B is not ended: it stays open
//      and claimed, its log says a Standard organization runs 1 agent run at
//      once, and no container boots for it. The member stops A from A's own
//      control, and B boots BY ITSELF — the job worker's `hosted-run/admit` pass.
//   2. On My agents the member creates one agent; the second is refused with the
//      plan and its figure (429 `user_cap`, `limit: 1`, `planName: 'Standard'`).
//   3. A platform admin opens /admin/monitoring: the org's row names Standard and
//      reads its hosted runs as "1 of 1"; the Fleet section has no "of 500".
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
// The plan is the lane's billing boundary mock (`E2E_TEST_BILLING`), answered
// from `MOTIR_AI_BILLING_FIXTURE_PATH` — by the webServer AND by the job worker,
// whose admit pass reads the same plan (`hostedRunSeamEnv`, asserted first).
// The gateway, motir-ai's models / credit pre-flight and GitHub are the hosted-run
// mock; the fleets are the fake orchestrators. Nothing above them is stubbed: the
// plan-caps lookup, the fleet admission lock, the admit job and the refusal
// mapper all run for real.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every press awaits its own response; run B booting by itself is polled on the
// fake orchestrator's own record of a container for B (its status is `running`
// while it waits AND once booted, so status alone cannot tell). No timers.

// The admit job re-asks every 30 s (`HOSTED_RUN_ADMIT_RETRY_MS`), after the job
// worker's supervisor has settled A's machine and freed its slot.
test.describe.configure({ timeout: 300_000 });

const MODEL = 'e2e-hosted-default';
const STAFF = 'acceptance-plan-caps-staff@example.com';
const WIDE = { width: 1440, height: 810 };
const WAITING = 'a Standard organization runs 1 agent run at once';

const fm = en.platformAdmin.monitoring.fleet;
const agents = en.myAgents;

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  return baseURL;
}

const startResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${itemKey}/hosted-runs`) &&
      res.request().method() === 'POST',
    { timeout: 30_000 },
  );
const runsListResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().includes(`/api/work-items/${itemKey}/dispatch-runs`) &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );
const instancesResponse = (page: Page) =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      /\/api\/projects\/[^/]+\/instances$/.test(new URL(res.url()).pathname),
    { timeout: 45_000 },
  );

/** The run a Run hosted press opened, off the list the section refetches. */
async function startedRunId(runsRes: Response, known: string[]): Promise<string> {
  const { runs } = (await runsRes.json()) as { runs: { id: string; origin: string }[] };
  const run = runs.find((r) => r.origin === 'hosted' && !known.includes(r.id));
  expect(run, 'the run list carries the hosted run just started').toBeTruthy();
  return run!.id;
}

/** Open a card and press Run hosted on the default model. */
async function runHosted(page: Page, itemKey: string, known: string[]): Promise<string> {
  await page.goto(`/items/${itemKey}`);
  const main = page.getByRole('main');
  await expect(main.getByTestId('run-hosted-door')).toBeVisible();
  await expect(main.getByRole('combobox', { name: 'Model' })).toContainText(MODEL);
  const started = startResponse(page, itemKey);
  const runs = runsListResponse(page, itemKey);
  await main.getByTestId('run-hosted').click();
  expect((await started).status()).toBe(201);
  const id = await startedRunId(await runs, known);
  await expect(main.getByTestId('hosted-run')).toBeVisible();
  return id;
}

const waitingLines = async (dispatchRunId: string) =>
  (await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId, kind: 'log' } }))
    .map((e) => e.body ?? '')
    .filter((body) => body.startsWith('[motir] waiting for room'));

/** What teardown must stop — everything the journey started, and as whom. */
let started: { runs: string[]; agents: string[]; projectKey: string; member: Cookie[] } | null =
  null;

test.afterEach(async ({ page }) => {
  if (!started) return;
  const { runs, agents: agentIds, projectKey, member } = started;
  started = null;
  await page.context().clearCookies();
  await page.context().addCookies(member);
  for (const id of runs) {
    const run = await adminDb.dispatchRun.findUnique({ where: { id } });
    if (run?.status !== 'running') continue;
    const res = await page.request.post(`/api/dispatch-runs/${id}/cancel`);
    expect(res.status(), await res.text()).toBe(200);
  }
  for (const id of agentIds) {
    const res = await page.request.delete(`/api/projects/${projectKey}/instances/${id}`);
    expect(res.ok(), await res.text()).toBe(true);
  }
  // The job worker's supervisor tears each booted machine down at its next poll.
  for (const id of runs) {
    if (!fakeContainerForRun(id)) continue;
    await expect.poll(() => fakeContainerSettled(id), { timeout: 90_000 }).toBe(true);
  }
});

test('a Standard org: its second agent run waits and boots by itself, its second agent is refused, and the fleet view names the plan', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9363');

  // ── The lane can answer the plan where the admit job runs ─────────────────
  // The waiting run is booted by the JOB WORKER, whose admit pass reads the
  // org's plan. It must read the SAME billing fixture the webServer reads, or
  // it would judge `plan_unknown` and the run would never boot.
  expect(hostedRunSeamEnv()).toMatchObject({
    E2E_TEST_BILLING: '1',
    MOTIR_AI_BILLING_FIXTURE_PATH: process.env['MOTIR_AI_BILLING_FIXTURE_PATH'],
  });

  await resetDatabase();
  await clearFleetRows();
  resetBillingFixture();
  fakePersistentOrchestrator.reset();
  writeHostedRunFixture({ models: { ids: [MODEL], default: MODEL }, mayRun: true });
  resetHostedRunJournal();

  const tag = Date.now().toString(36);
  const seed = await seedHostedRun(`plan-caps-${tag}@example.com`, `PLC${tag}`);
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.workspaceId },
  });
  // Standard, written BEFORE the first navigation so no cached read is free.
  setOrgBillingState(organizationId, paidOrgState({ tier: TIERS.standard }));
  const cardA = await seedReadyHostedCard(seed, 'Ship the pricing page');
  const cardB = await seedReadyHostedCard(seed, 'Add the changelog link');

  await page.setViewportSize(WIDE);
  await signIn(page, seed.email, seed.password);
  started = {
    runs: [],
    agents: [],
    projectKey: seed.projectKey,
    member: await page.context().cookies(),
  };
  const main = page.getByRole('main');

  let runA = '';
  let runB = '';

  await chapter('Run card A hosted — it boots', async () => {
    runA = await runHosted(page, cardA.identifier, []);
    started!.runs.push(runA);
    await expect.poll(() => fakeContainerForRun(runA) !== undefined).toBe(true);
  });
  await beat();

  await chapter('Run card B hosted — it waits, naming Standard and one run at once', async () => {
    runB = await runHosted(page, cardB.identifier, [runA]);
    started!.runs.push(runB);

    // Authoritative: B is open, its card claimed, its line written — and no
    // container booted for it.
    await expect.poll(async () => (await waitingLines(runB)).length).toBe(1);
    expect((await waitingLines(runB))[0]).toContain(WAITING);
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runB } })).toMatchObject({
      status: 'running',
    });
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: cardB.id } })).toMatchObject({
      status: 'in_progress',
      assigneeId: seed.userId,
    });
    expect(fakeContainerForRun(runB)).toBeUndefined();

    // What the member reads: the run's own log says why it waits.
    await page.goto(`/runs?run=${runB}`);
    const dialog = page.getByRole('dialog', { name: en.runs.modalTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('run-log-body')).toContainText(WAITING);
    await expect(dialog.getByTestId('run-log-body')).toContainText('1 is already running');
  });
  await beat();

  await chapter('Stop run A — run B boots by itself', async () => {
    await page.goto(`/items/${cardA.identifier}`);
    await main.getByTestId('hosted-run-cancel').click();
    const confirm = page.getByRole('alertdialog').getByTestId('hosted-run-cancel-confirm');
    await expect(confirm).toBeVisible();
    const cancelled = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/dispatch-runs/${runA}/cancel`) &&
        res.request().method() === 'POST',
    );
    await confirm.click();
    expect((await cancelled).status()).toBe(200);
    await expect(main.getByTestId('hosted-end')).toHaveAttribute('data-end', 'cancelled', {
      timeout: 30_000,
    });

    // Nobody presses anything: A's machine settles, its slot frees, and the
    // admit job's next pass boots B.
    await expect
      .poll(() => fakeContainerForRun(runB) !== undefined, { timeout: 150_000 })
      .toBe(true);
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runB } })).toMatchObject({
      status: 'running',
    });

    // B's container reports in, and the card's run section shows it running.
    const api = await ingestContext(runTokenFor(runB), origin(baseURL));
    await appendEvents(api, runB, [{ kind: 'agent_started', workItemKey: cardB.identifier }]);
    await page.goto(`/items/${cardB.identifier}`);
    await expect(main.getByTestId('hosted-run')).toBeVisible();
    await expect(main.locator('li[data-phase="running"]')).toHaveAttribute('data-state', 'now');
  });
  await beat();

  await chapter('My agents: the first agent is created', async () => {
    await page.getByRole('link', { name: 'My agents' }).click();
    await expect(page.getByRole('heading', { name: agents.title })).toBeVisible();
    await page.getByRole('button', { name: agents.newAgent }).first().click();
    const dialog = page.getByRole('dialog', { name: agents.create.title });
    await dialog.getByLabel(agents.create.name).fill('first-agent');
    await dialog.getByRole('radio', { name: /^Claude Code/ }).check();
    const created = instancesResponse(page);
    await dialog.getByRole('button', { name: agents.create.submit }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    const { instance } = (await res.json()) as { instance: { id: string } };
    started!.agents.push(instance.id);
    await expect(dialog).toBeHidden();
    await main
      .getByTestId('agent-panel')
      .getByRole('button', { name: 'Close first-agent' })
      .click();
    await expect(
      page.getByRole('table').getByTestId('agent-row').filter({ hasText: 'first-agent' }),
    ).toBeVisible();
  });
  await beat();

  await chapter('The second agent is refused — Standard allows 1 agent per person', async () => {
    await page.getByRole('button', { name: agents.newAgent }).first().click();
    const dialog = page.getByRole('dialog', { name: agents.create.title });
    await dialog.getByLabel(agents.create.name).fill('second-agent');
    const created = instancesResponse(page);
    await dialog.getByRole('button', { name: agents.create.submit }).click();
    const res = await created;
    expect(res.status()).toBe(429);
    expect(await res.json()).toMatchObject({
      reason: 'user_cap',
      limit: 1,
      planName: 'Standard',
    });

    const refusal = dialog.getByRole('alert');
    await expect(refusal).toContainText(agents.refusalTitle.userCap);
    await expect(refusal).toContainText('Standard');
    await expect(refusal).toContainText('1 agent per person');
    await expect(refusal).not.toContainText('10');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('table').getByTestId('agent-row')).toHaveCount(1);
  });
  await beat();

  await chapter('A platform admin’s fleet view names Standard, its runs 1 of 1', async () => {
    await signUpToOnboarding(page, STAFF);
    await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'superadmin' } });
    expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
    const fleetOrgs = main.getByTestId('fleet-orgs');
    await fleetOrgs.scrollIntoViewIfNeeded();
    const row = fleetOrgs.locator(`tr[data-org="${organizationId}"]`);
    await expect(row).toBeVisible();
    const cells = row.getByRole('cell');
    await expect(cells.nth(1)).toContainText('Standard');
    // org · plan · CI · hosted runs · agent instances · …
    await expect(cells.nth(3)).toContainText('1 of 1');
    await expect(
      fleetOrgs.getByRole('columnheader', { name: fm.orgs.col.plan, exact: true }),
    ).toBeVisible();
    await expect(fleetOrgs).not.toContainText('of 500');
  });
  await beat();
});
