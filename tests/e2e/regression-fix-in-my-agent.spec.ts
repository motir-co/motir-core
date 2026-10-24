import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { setCredits } from './_helpers/my-agents-seed';
import {
  api,
  createAgent,
  finishRun,
  runsOf,
  seedReadyCard,
  seedRunInMyAgent,
  signInCodingAgent,
  type RunInMyAgentSeed,
} from './_helpers/run-in-my-agent-seed';
import {
  deliverChecks,
  endFix,
  headSha,
  recordNoSession,
  runCalls,
  sessionOf,
  signInCodex,
  stubCalls,
} from './_helpers/fix-in-my-agent-seed';
import en from '@/messages/en.json';

// FIX IN MY AGENT (Story MOTIR-8981) — the story's verification recipe in a browser and,
// for the first test, its acceptance receipt: a card's run in the developer's own agent
// ends with a pull request whose checks go red; the Development block offers "Fix in my
// agent"; one press starts a fix run in THAT agent, which resumes its own session on the
// same branch; a second press is refused naming the run; and when the checks go green the
// fix ends and the door is gone.
//
// ── THE SEAMS (each lives in the process that uses it) ───────────────────────
// - THE AGENT, THE EXEC DOOR AND THE RUN SESSION are `acceptance-run-in-my-agent`'s: the
//   fake fleet, the lane's terminal host running the REAL `motir agent-terminal run`, and
//   `_helpers/agent-terminal/motir-run.py` as the CLI the run session re-enters. Its
//   `fix` form adopts the server-opened run through MOTIR_DISPATCH_RUN_ID, reads the
//   run's `repair.resume`, and asks the SHIPPED `chooseRepairAgent` for the command.
// - THE VENDOR CLIs are `_helpers/agent-terminal/vendor-stub.mjs`. It answers the run
//   forms the shipped profiles build and RECORDS every argv and prompt, so "it resumed"
//   is asserted on what the agent was launched with, never on a line the stand-in prints.
// - THE RED AND THE GREEN are check rows on the pull request the run linked, settled
//   through the shipped recomputes (`fix-in-my-agent-seed.ts`). The stand-in plays the
//   fix's push by the spec writing the green rows.
//
// The vendor stub records only what a RUN launches through it: the stand-in run's own
// `claude -p` is the lane's older stub, so the first recorded run call is the FIX.
//
// ── WAITS ────────────────────────────────────────────────────────────────────
// On the start's own response, the work item's run list read back, the agent's recorded
// invocations, and the terminal's own screen. Nothing sleeps.

test.describe.configure({ timeout: 420_000 });

const fix = en.github.development.fix;
const myAgent = fix.myAgent;
const WIDE = { width: 1440, height: 810 };
/** Pull-request numbers: this spec owns the 71xxx block (no webhook is delivered). */
const PR = { story: 71311, gaveUp: 71312, settled: 71313, noSession: 71314, codex: 71315 };

/** A message as the page renders it: tags keep their children, `{var}` is its value. */
function plain(template: string, vars: Record<string, string | number> = {}): string {
  let text = template;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<\/?\w+>/g, '');
  } while (text !== previous);
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

const main = (page: Page): Locator => page.getByRole('main');
const fixPart = (page: Page): Locator =>
  page.getByRole('group', { name: fix.aria.part, exact: true });
const control = (page: Page): Locator => main(page).getByTestId('fix-my-agent-control');
const press = (page: Page): Locator => main(page).getByTestId('fix-my-agent');
const panel = (page: Page): Locator => main(page).getByTestId('agent-panel');
const runScreen = (page: Page): Locator =>
  panel(page).getByTestId('agent-run-watch').locator('.xterm-rows');

interface RunRow {
  id: string;
  status: string;
  origin: string;
}

const startPost = (page: Page, key: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${key}/agent-runs`) && res.request().method() === 'POST',
    { timeout: 60_000 },
  );

async function openCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

/** The door's own server evaluation — what the page draws from. */
async function doorOf(page: Page, key: string): Promise<Record<string, unknown>> {
  const res = await api(page, 'GET', `/api/work-items/${key}/fix-in-my-agent`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as Record<string, unknown>;
}

/** Wait for a run to reach `status` on the committed read. */
async function runReaches(page: Page, key: string, runId: string, status: string): Promise<void> {
  await expect
    .poll(async () => (await runsOf(page, key)).find((run) => run.id === runId)?.status, {
      timeout: 90_000,
    })
    .toBe(status);
}

/** The run rows that are not `before`. */
async function newRuns(page: Page, key: string, before: RunRow[]): Promise<RunRow[]> {
  const known = new Set(before.map((run) => run.id));
  return (await runsOf(page, key)).filter((run) => !known.has(run.id));
}

/**
 * Send a ready card to the agent, let its run finish with pull request `number`, and
 * turn the pull request's checks red. The agent's recorded session is the one a fix resumes.
 */
async function runToRed(
  page: Page,
  seed: RunInMyAgentSeed,
  card: { id: string; key: string },
  agentId: string,
  number: number,
): Promise<{ runId: string; session: string }> {
  const started = await api(page, 'POST', `/api/work-items/${card.key}/agent-runs`, {
    agentInstanceId: agentId,
  });
  expect(started.status, JSON.stringify(started.json)).toBe(201);
  const runId = (started.json as { dispatchRunId: string }).dispatchRunId;
  // The run names its conversation when its coding agent starts.
  await expect.poll(() => sessionOf(agentId, runId), { timeout: 90_000 }).not.toBeNull();
  const session = sessionOf(agentId, runId) as string;
  finishRun(agentId, runId, number);
  await runReaches(page, card.key, runId, 'succeeded');
  await deliverChecks(seed, card, number, headSha(number, 1), 'failure');
  return { runId, session };
}

/** Press Fix in my agent and return the start's answer. */
async function pressFix(
  page: Page,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answered = startPost(page, key);
  await press(page).click();
  const res = await answered;
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** Open the agent's panel on the run of `key` and return its read-only screen. */
async function watchRun(page: Page, agentId: string, key: string): Promise<Locator> {
  await page.goto(`/my-agents?agent=${encodeURIComponent(agentId)}`);
  await expect(panel(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(panel(page).getByTestId('agent-conn')).toHaveText(en.myAgents.panel.conn.live, {
    timeout: 30_000,
  });
  const session = panel(page)
    .getByRole('group', { name: en.myAgents.panel.run.sessions.label })
    .getByRole('button', { name: plain(en.myAgents.panel.run.sessions.run, { key }) });
  await session.click();
  await expect(panel(page)).toContainText(plain(en.myAgents.panel.run.strip.watching, { key }));
  return runScreen(page);
}

test.describe('Fix a red pull request in my own agent', () => {
  let seed: RunInMyAgentSeed;
  test.beforeEach(async ({ page }) => {
    seed = await seedRunInMyAgent(Date.now().toString(36));
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
  });
  test.afterEach(() => setCredits(true));

  test('a red pull request is fixed in the same agent: one press resumes its session, a second is refused, and green ends it', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8981');
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    const { session } = await runToRed(page, seed, card, agentId, PR.story);
    const before = await runsOf(page, card.key);
    let fixRunId = '';

    await chapter('A red pull request, and the door in the agent that built it', async () => {
      await openCard(page, card.key);
      await expect(fixPart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await beat();
      await expect(control(page)).toBeVisible();
      await expect(control(page)).toContainText(plain(myAgent.lead, { agent: 'yue-claude' }));
      await expect(press(page)).toHaveText(myAgent.door.label);
      expect(await doorOf(page, card.key)).toMatchObject({
        offered: true,
        agent: { name: 'yue-claude' },
      });
    });

    await chapter('The press — one fix starts in that agent', async () => {
      const sent = await pressFix(page, card.key);
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body).toMatchObject({ created: true });
      fixRunId = sent.body['dispatchRunId'] as string;
      const [created] = await newRuns(page, card.key, before);
      expect(created?.id).toBe(fixRunId);
      await expect(control(page)).toHaveCount(0);
      expect(await doorOf(page, card.key)).toMatchObject({ offered: false, reason: 'repair_open' });
    });
    await beat();

    await chapter(
      'The fix is running in the agent’s own terminal, in its own session',
      async () => {
        const screen = await watchRun(page, agentId, card.key);
        await expect(screen).toContainText(`motir fix ${card.key}`, { timeout: 60_000 });
        await expect(screen).toContainText(
          `${card.key}: resuming the claude session from the last run.`,
        );
        // What the agent was LAUNCHED with, from the vendor stub's own record: the
        // conversation the earlier run named, resumed — never a new session.
        await expect.poll(() => runCalls(agentId).length, { timeout: 60_000 }).toBe(1);
        const call = runCalls(agentId)[0]!;
        expect(call.args).toContain('--resume');
        expect(call.args![call.args!.indexOf('--resume') + 1]).toBe(session);
        expect(call.args).not.toContain('--session-id');
        expect(call.prompt).toContain(card.key);
        await beat();
      },
    );

    await chapter('A second press is refused, naming the run, and no run is added', async () => {
      const runs = await runsOf(page, card.key);
      const refused = await api(page, 'POST', `/api/work-items/${card.key}/agent-runs`, {
        agentInstanceId: agentId,
        command: 'fix',
        idempotencyKey: 'a-second-press',
      });
      expect(refused.status).toBe(409);
      // The agent is running this very fix, so the start refuses it busy at the agent's
      // own check (step 4), before the repair claim is asked — the unit contract is
      // `agentInstanceRunStart.test.ts`'s "the same agent pressed again is refused busy".
      expect(refused.json).toMatchObject({ code: 'agent_instance_run_active' });
      // No run is added. Compared by id: a live run's heartbeat moves between
      // the two reads (MOTIR-9411: the recording lane's holds hid the drift).
      expect((await runsOf(page, card.key)).map((run) => run.id)).toEqual(
        runs.map((run) => run.id),
      );
    });

    await chapter('The checks go green: the fix ends and the card is settled', async () => {
      endFix(agentId, fixRunId, 'green');
      await deliverChecks(seed, card, PR.story, headSha(PR.story, 2), 'success');
      await runReaches(page, card.key, fixRunId, 'succeeded');
      await openCard(page, card.key);
      await expect(control(page)).toHaveCount(0);
      await expect(fixPart(page)).toHaveCount(0);
      expect(await doorOf(page, card.key)).toMatchObject({ offered: false });
      await beat();
    });
  });

  test('not offered without a red pull request, and a press on a page gone stale is refused as settled', async ({
    page,
  }) => {
    const noPr = await seedReadyCard(seed, 'Email the monthly invoice summary');
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);

    // A work item with no pull request has nothing to fix.
    await openCard(page, noPr.key);
    await expect(control(page)).toHaveCount(0);
    expect(await doorOf(page, noPr.key)).toMatchObject({ offered: false });

    await runToRed(page, seed, card, agentId, PR.settled);
    await openCard(page, card.key);
    await expect(control(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const runs = await runsOf(page, card.key);

    // The checks go green while the page is open: the press is refused, not started.
    await deliverChecks(seed, card, PR.settled, headSha(PR.settled, 2), 'success');
    expect(await doorOf(page, card.key)).toMatchObject({ offered: false });
    const sent = await pressFix(page, card.key);
    expect(sent.status).toBe(409);
    await expect(main(page).getByTestId('fix-my-agent-refused-settled')).toContainText(
      myAgent.settled.notice,
    );
    expect(await runsOf(page, card.key)).toEqual(runs);
    // …and a reload shows a green delivery with no door.
    await openCard(page, card.key);
    await expect(control(page)).toHaveCount(0);
  });

  test('a fix that gave up releases the claim: the door is back and a further press starts a second fix', async ({
    page,
  }) => {
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    await runToRed(page, seed, card, agentId, PR.gaveUp);
    const initial = await runsOf(page, card.key);

    await openCard(page, card.key);
    await expect(control(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const first = await pressFix(page, card.key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstId = first.body['dispatchRunId'] as string;
    await expect.poll(() => runCalls(agentId).length, { timeout: 60_000 }).toBe(1);

    // It gives up: the stand-in closes the run halted, the checks still red.
    endFix(agentId, firstId, 'gave_up');
    await runReaches(page, card.key, firstId, 'failed');
    await openCard(page, card.key);
    await expect(control(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

    const second = await pressFix(page, card.key);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toMatchObject({ created: true });
    const secondId = second.body['dispatchRunId'] as string;
    expect(secondId).not.toBe(firstId);
    expect((await newRuns(page, card.key, initial)).map((run) => run.id).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    endFix(agentId, secondId, 'green');
  });

  test('a run that recorded no session starts the fix fresh and says so', async ({ page }) => {
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    recordNoSession(agentId);
    await runToRed(page, seed, card, agentId, PR.noSession);
    await openCard(page, card.key);
    await expect(control(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const sent = await pressFix(page, card.key);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const screen = await watchRun(page, agentId, card.key);
    await expect(screen).toContainText(
      `${card.key}: the last claude run recorded no session to resume — starting a fresh agent.`,
      { timeout: 60_000 },
    );
    await expect.poll(() => runCalls(agentId).length, { timeout: 60_000 }).toBe(1);
    const call = runCalls(agentId)[0]!;
    expect(call.args).toContain('--session-id');
    expect(call.args).not.toContain('--resume');
    endFix(agentId, sent.body['dispatchRunId'] as string, 'green');
  });

  test('a codex agent resumes its own session through codex’s resume form', async ({ page }) => {
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const agentId = await createAgent(page, seed, 'yue-codex', 'codex');
    signInCodex(agentId);
    const { session } = await runToRed(page, seed, card, agentId, PR.codex);
    await openCard(page, card.key);
    await expect(control(page)).toContainText(plain(myAgent.lead, { agent: 'yue-codex' }), {
      timeout: FIRST_PAINT_MS,
    });
    const sent = await pressFix(page, card.key);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    await expect.poll(() => runCalls(agentId).length, { timeout: 60_000 }).toBe(1);
    const call = runCalls(agentId)[0]!;
    expect(call.cli).toBe('codex');
    expect(call.args).toEqual([
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="danger-full-access"',
      session,
      '-',
    ]);
    for (const flag of ['--session-id', '--output-format', '--include-partial-messages']) {
      expect(call.args).not.toContain(flag);
    }
    expect(stubCalls(agentId).filter((entry) => entry.refused)).toEqual([]);
    endFix(agentId, sent.body['dispatchRunId'] as string, 'green');
  });
});
