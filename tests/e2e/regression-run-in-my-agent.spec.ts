import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { setCredits } from './_helpers/my-agents-seed';
import {
  agentState,
  api,
  blockCard,
  createAgent,
  finishRun,
  letIdleWindowPass,
  runsOf,
  seedReadyCard,
  seedRunInMyAgent,
  signInCodingAgent,
  signOutCodingAgent,
  wakeAgent,
  type RunInMyAgentSeed,
} from './_helpers/run-in-my-agent-seed';
import en from '@/messages/en.json';

// RUN A READY CARD IN YOUR OWN AGENT (Story MOTIR-6864 · MOTIR-7031) — the story's
// verification recipe in a browser and, for the happy path, its acceptance
// receipt: a developer sends a ready card to a hibernated agent of theirs, watches
// it wake and start, sees the same run in the agent's terminal, is refused naming
// that run when they try a second card on the busy agent, sees the run end with a
// pull request and the card Implemented, and reads the run modal's agent, coding
// agent and machine-time-only cost.
//
// ── THE SEAMS (each lives in the process that uses it) ───────────────────────
// - THE FLEET is the persistent fake, shared with the web server and the job
//   worker through `MOTIR_FAKE_PERSISTENT_STATE_PATH`.
// - THE EXEC DOOR (new here): the fake routes every exec nothing scripted to the
//   lane's terminal host (`MOTIR_FAKE_EXEC_URL` → `_helpers/agent-terminal/host.ts`),
//   which runs `packages/cli`'s REAL `motir agent-terminal signin | run | stop`
//   against the machine's REAL terminal server over its control socket. So the
//   sign-in Motir records is the credential file's, and the launch really opens a
//   run session on a real PTY that the browser then attaches to.
// - THE RUN SESSION'S `motir run` is `_helpers/agent-terminal/motir-run.py`: it
//   speaks the run's own `/api/v1` ingest with the token the launcher wrote, and
//   runs the stub `claude -p` as its coding agent. The terminal assertions read
//   what THAT process printed — never a scripted exec answer.
// - THE PULL REQUEST is linked by the run itself on the lane's fake GitHub; the
//   spec only says when the coding agent is done, and which number GitHub gave the
//   pull request (`finishRun`).
// - THE CREDITS are the lane's motir-ai mock (`setCredits`).
//
// ── WAITS ────────────────────────────────────────────────────────────────────
// On the start's own response, the agents read the picker makes, the run's phases
// as its events arrive, the terminal's own screen, the cancel's response, and —
// for every "no run was created" — the work item's run list read back.

test.describe.configure({ timeout: 300_000 });

const r = en.runs.agent;
const WIDE = { width: 1440, height: 810 };
/** Pull-request numbers: this spec owns the 70xxx block. */
const PR_NUMBER = 70311;

/**
 * A message as the page renders it: tags keep their children, an empty tag pair
 * (a rendered command) is dropped, `{var}` is its value, and a `{count, plural}`
 * takes its `one` / `other` form.
 */
function plain(template: string, vars: Record<string, string | number> = {}): string {
  let text = template
    .replace(
      /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
      (_, key: string, one: string, other: string) =>
        (Number(vars[key]) === 1 ? one : other).replace('#', String(vars[key])),
    )
    .replace(/<(\w+)><\/\1>/g, '');
  // Strip tags until none is left, so a removal can never splice a new one together.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<\/?\w+>/g, '');
  } while (text !== previous);
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

const main = (page: Page): Locator => page.getByRole('main');
const agentRun = (page: Page): Locator => main(page).getByTestId('agent-run');
const phase = (page: Page, name: string): Locator =>
  agentRun(page).locator(`li[data-phase="${name}"]`);
// The picker (`send-to-agent-picker`) is a popover in a portal, outside <main>:
// found by its dialog role and name.
const picker = (page: Page): Locator => page.getByRole('dialog', { name: r.door.send });
const agentRow = (page: Page, name: string): Locator =>
  picker(page).locator(`[data-testid="send-to-agent-row"][data-agent="${name}"]`);
const panel = (page: Page): Locator => main(page).getByTestId('agent-panel');
const runLine = (page: Page): Locator => panel(page).getByTestId('agent-run-line');
const sessions = (page: Page): Locator =>
  panel(page).getByRole('group', { name: en.myAgents.panel.run.sessions.label });
const runScreen = (page: Page): Locator =>
  panel(page).getByTestId('agent-run-watch').locator('.xterm-rows');

/** The detail rail's Status field card. */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const agentsRead = (page: Page, key: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${key}/agent-runs/agents`) &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );
const startPost = (page: Page, key: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${key}/agent-runs`) && res.request().method() === 'POST',
    { timeout: 60_000 },
  );

/** Open a card and wait for its start bar — the page has painted its Run section. */
async function openCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(main(page).getByTestId('start-bar')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(main(page).getByTestId('start-send')).toBeVisible();
}

/** Open the picker and wait for the list it reads. */
async function openPicker(page: Page, key: string): Promise<void> {
  const read = agentsRead(page, key);
  await main(page).getByTestId('send-to-agent').click();
  expect((await read).status()).toBe(200);
  await expect(picker(page)).toBeVisible();
}

/** Press an agent's row — the send — and return the start's answer. */
async function sendTo(
  page: Page,
  key: string,
  name: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answered = startPost(page, key);
  await agentRow(page, name).click();
  const res = await answered;
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

test.describe('Run a ready card in my own agent', () => {
  let seed: RunInMyAgentSeed;
  test.beforeEach(async ({ page }) => {
    seed = await seedRunInMyAgent(Date.now().toString(36));
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
  });
  test.afterEach(() => setCredits(true));

  test('send a ready card to a hibernated agent: it wakes, runs in the agent’s terminal, refuses a second card, and ends in a pull request', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6864');
    const card = await seedReadyCard(seed, 'Export invoices as CSV');
    const second = await seedReadyCard(seed, 'Email the monthly invoice summary');
    // An agent of the developer's own, signed in to Claude Code, asleep.
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    await letIdleWindowPass(page, [agentId]);
    let runId = '';

    await chapter('A ready work item, and an agent of mine that is asleep', async () => {
      await openCard(page, card.key);
      await expect(main(page).getByTestId('start-send')).toContainText(en.runs.start.send.title);
      await beat();
      await openPicker(page, card.key);
      await expect(picker(page)).toContainText(plain(r.picker.title, { key: card.key }));
      const row = agentRow(page, 'yue-claude');
      await expect(row).toHaveAttribute('data-refusal', '');
      await expect(row).toContainText(en.myAgents.state.hibernated);
      await expect(row).toContainText(r.picker.signin.signedIn);
      await expect(row).toContainText(r.picker.next.wakes);
    });

    await chapter('Send it to my agent — one press wakes it and starts the run', async () => {
      const sent = await sendTo(page, card.key, 'yue-claude');
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body).toMatchObject({ created: true, woke: true });
      runId = sent.body['dispatchRunId'] as string;

      await expect(agentRun(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
      await expect(agentRun(page).getByTestId('agent-lane')).toHaveText(
        plain(r.lane, { name: 'yue-claude', agent: 'Claude Code' }),
      );
      await expect(phase(page, 'starting')).toContainText(
        plain(r.phaseDetail.waking, { name: 'yue-claude' }),
      );
      // The run's own events, as the agent's `motir run` reports them: checked
      // out, then Claude Code working — with who works it in the running phase.
      await expect(phase(page, 'running')).toHaveAttribute('data-state', 'now', {
        timeout: 90_000,
      });
      await expect(phase(page, 'running')).toContainText(
        plain(r.phaseDetail.running, { agent: 'Claude Code', name: 'yue-claude' }),
      );
      await expect(phase(page, 'cloned')).toContainText(seed.repository);
      // Machine time is the only cost a run in an agent carries.
      await expect(agentRun(page).getByTestId('agent-run-cost')).toBeVisible();
      await expect(main(page).getByTestId('hosted-run-cost')).toHaveCount(0);
      expect(await agentState(page, seed, agentId)).toBe('running');
    });
    await beat();

    await chapter('A second work item is refused, naming the run the agent is on', async () => {
      await openCard(page, second.key);
      await openPicker(page, second.key);
      const row = agentRow(page, 'yue-claude');
      await expect(row).toHaveAttribute('data-refusal', 'agent_instance_run_active');
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      const busy = row.getByTestId('send-to-agent-busy');
      await expect(busy).toContainText(
        plain(r.picker.busy, { key: card.key, title: 'Export invoices as CSV' }),
      );
      // The server says the same, whatever a page offers: the refusal names the run.
      const refused = await api(page, 'POST', `/api/work-items/${second.key}/agent-runs`, {
        agentInstanceId: agentId,
      });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        code: 'agent_instance_run_active',
        runId,
        workItemKey: card.key,
      });
      // …and no second run exists.
      expect(await runsOf(page, second.key)).toEqual([]);
      await beat();
      // The busy line links the work item the agent is on.
      // It sits inside the row's `aria-disabled` option, which Playwright's
      // actionability check reads as disabling the link too; a pointer is not
      // stopped by it (the row only drops its own onClick), so the click is forced
      // once the link is shown and points at the card.
      const busyLink = busy.getByRole('link', { name: card.key });
      await expect(busyLink).toBeVisible();
      await expect(busyLink).toHaveAttribute('href', `/items/${card.key}`);
      await busyLink.click({ force: true });
      await expect(page).toHaveURL(new RegExp(`/items/${card.key}$`));
      await expect(agentRun(page)).toHaveAttribute('data-status', 'running', {
        timeout: FIRST_PAINT_MS,
      });
    });

    await chapter('The same run, in the agent’s own terminal', async () => {
      await agentRun(page).getByTestId('agent-link').click();
      // Mounted before anything is read off it — the panel, on the developer's shell.
      await expect(panel(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(panel(page).getByRole('heading', { level: 2 })).toContainText('yue-claude');
      await expect(panel(page).getByTestId('agent-conn')).toHaveText(en.myAgents.panel.conn.live, {
        timeout: 30_000,
      });
      await expect(runLine(page)).toHaveAttribute('data-state', 'live');
      await expect(runLine(page)).toContainText(en.myAgents.panel.run.live);
      await expect(runLine(page)).toContainText(card.key);
      const runSession = sessions(page).getByRole('button', {
        name: plain(en.myAgents.panel.run.sessions.run, { key: card.key }),
      });
      await expect(runSession).toBeVisible();
      await beat();
      await runSession.click();
      await expect(panel(page)).toContainText(
        plain(en.myAgents.panel.run.strip.watching, { key: card.key }),
      );
      // What the agent's `motir run` and its coding agent printed, on the PTY.
      await expect(runScreen(page)).toContainText(`motir run ${card.key}`, { timeout: 30_000 });
      await expect(runScreen(page)).toContainText(
        'Editing src/invoices/export.ts — invoices export as CSV',
      );
    });
    await beat();

    await chapter('It finishes — a pull request, and the work item is Implemented', async () => {
      finishRun(agentId, runId, PR_NUMBER);
      await expect(runScreen(page)).toContainText('Tests pass.', { timeout: 30_000 });
      await expect(runScreen(page)).toContainText(
        `opened pull request ${seed.repository}#${PR_NUMBER}`,
      );
      await expect(panel(page)).toContainText(en.myAgents.panel.run.strip.endedSucceeded, {
        timeout: 30_000,
      });
      await expect(runLine(page)).toHaveAttribute('data-state', 'ended');
      await expect(runLine(page)).toContainText(en.myAgents.panel.run.last);
      // The committed read: the run succeeded.
      await expect.poll(async () => (await runsOf(page, card.key))[0]?.status).toBe('succeeded');
      await beat();

      await runLine(page).getByRole('link', { name: card.key }).click();
      await expect(agentRun(page)).toHaveAttribute('data-status', 'succeeded', {
        timeout: FIRST_PAINT_MS,
      });
      const end = agentRun(page).getByTestId('agent-end');
      await expect(end).toHaveAttribute('data-end', 'succeeded');
      await expect(end).toContainText(`${seed.repository} #${PR_NUMBER}`);
      await expect(statusCard(page)).toContainText('Implemented');
      await expect(agentRun(page)).toContainText(plain(r.where.ended));
      await expect(agentRun(page).getByTestId('agent-machine-time')).not.toHaveText('—');
      await end.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter(
      'The run modal: its log, the pull request, the agent and its coding agent, and machine time',
      async () => {
        await page.goto(`/runs?run=${runId}`);
        const modal = page.getByRole('dialog');
        await expect(modal.getByTestId('agent-lane')).toHaveText(
          plain(r.lane, { name: 'yue-claude', agent: 'Claude Code' }),
          { timeout: FIRST_PAINT_MS },
        );
        await expect(modal.getByTestId('agent-link')).toHaveText(
          plain(r.where.open, { name: 'yue-claude' }),
        );
        const strip = modal.getByTestId('agent-end-strip');
        await expect(strip).toHaveAttribute('data-end', 'succeeded');
        await expect(strip).toContainText(`${seed.repository} #${PR_NUMBER}`);
        const cost = modal.getByTestId('agent-run-cost');
        await expect(cost).toContainText(plain(r.cost.stripMachine, { name: 'yue-claude' }));
        await expect(cost).toContainText(plain(r.cost.stripNoTokens, { agent: 'Claude Code' }));
        await expect(modal.getByTestId('hosted-run-cost')).toHaveCount(0);
        // The log is the run's own: what its coding agent printed.
        await expect(modal.getByTestId('run-modal-log-region')).toContainText(
          'Editing src/invoices/export.ts',
        );
      },
    );
    await beat();
  });

  test('refusals in words — no agent, the work item not ready, the coding agent signed out, a wake with no credits — and no run is opened', async ({
    page,
  }) => {
    const noAgent = await seedReadyCard(seed, 'Nothing to send it to yet');
    const blocked = await seedReadyCard(seed, 'Becomes blocked while the page is open');
    const signedOut = await seedReadyCard(seed, 'Sent to a signed-out coding agent');
    const noCredits = await seedReadyCard(seed, 'Sent while the credits are gone');

    // NO AGENT ON THE PROJECT — the empty face, linking to My agents.
    await openCard(page, noAgent.key);
    await openPicker(page, noAgent.key);
    const empty = picker(page).getByTestId('send-to-agent-empty');
    await expect(empty).toContainText(plain(r.empty.title, { project: 'Agents' }));
    await expect(empty.getByTestId('send-to-agent-create')).toHaveAttribute('href', '/my-agents');
    await expect(empty.getByTestId('send-to-agent-create')).toHaveText(r.empty.create);
    expect(await runsOf(page, noAgent.key)).toEqual([]);

    // An agent, signed in and running (a wake after the sign-in records it).
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    await letIdleWindowPass(page, [agentId]);
    await wakeAgent(page, seed, agentId);

    // THE WORK ITEM IS NOT READY — it gained a blocker after the page read it.
    await openCard(page, blocked.key);
    await openPicker(page, blocked.key);
    await expect(agentRow(page, 'yue-claude')).toHaveAttribute('data-refusal', '');
    await blockCard(seed, blocked.id, 'A blocker that appeared meanwhile');
    const notReady = await sendTo(page, blocked.key, 'yue-claude');
    expect(notReady.status).toBe(409);
    expect(notReady.body['code']).toBe('agent_run_card_not_ready');
    const notReadyNotice = main(page).getByTestId('agent-refused-notReady');
    await expect(notReadyNotice).toContainText(r.refused.notReady.title);
    await expect(notReadyNotice).toContainText(r.refused.nothing);
    expect(await runsOf(page, blocked.key)).toEqual([]);
    // Read again, the page itself says why, and offers no send.
    await openCard(page, blocked.key);
    await expect(main(page).getByTestId('hosted-not-ready')).toHaveText(
      plain(en.runs.start.notReady, { count: 1 }),
    );
    await expect(main(page).getByTestId('send-to-agent')).toBeDisabled();

    // NOT SIGNED IN — the credential file is gone; the start asks the agent live.
    signOutCodingAgent(agentId);
    await openCard(page, signedOut.key);
    await openPicker(page, signedOut.key);
    const refusedSignIn = await sendTo(page, signedOut.key, 'yue-claude');
    expect(refusedSignIn.status).toBe(409);
    expect(refusedSignIn.body['code']).toBe('agent_not_signed_in');
    const signInNotice = main(page).getByTestId('agent-refused-notSignedIn');
    await expect(signInNotice).toContainText(
      plain(r.refused.notSignedIn.title, { agent: 'Claude Code', name: 'yue-claude' }),
    );
    await expect(signInNotice).toContainText(r.refused.nothing);
    await expect(signInNotice.getByRole('link')).toHaveText(
      plain(r.refused.notSignedIn.open, { name: 'yue-claude' }),
    );
    expect(await runsOf(page, signedOut.key)).toEqual([]);
    // The answer was recorded. A RUNNING agent's picker row never refuses on that
    // record (the start asks live, MOTIR-8869), so the agent sleeps first: the
    // hibernate takes the sign-in again, and the picker now says so on the row.
    await letIdleWindowPass(page, [agentId]);
    await openPicker(page, signedOut.key);
    await expect(agentRow(page, 'yue-claude')).toHaveAttribute(
      'data-refusal',
      'agent_not_signed_in',
    );
    await expect(agentRow(page, 'yue-claude').getByTestId('send-to-agent-why')).toContainText(
      'Sign in first: open yue-claude and run',
    );
    await page.keyboard.press('Escape');

    // A WAKE REFUSAL — the agent sleeps, signed in, and the credits are gone.
    signInCodingAgent(agentId);
    await wakeAgent(page, seed, agentId);
    await letIdleWindowPass(page, [agentId]);
    setCredits(false);
    await openCard(page, noCredits.key);
    await openPicker(page, noCredits.key);
    await expect(agentRow(page, 'yue-claude')).toHaveAttribute('data-refusal', '');
    const refusedWake = await sendTo(page, noCredits.key, 'yue-claude');
    expect(refusedWake.status, JSON.stringify(refusedWake.body)).toBe(402);
    const wakeNotice = main(page).getByTestId('agent-refused-wake');
    await expect(wakeNotice).toContainText(plain(r.refused.wakeTitle, { name: 'yue-claude' }));
    await expect(wakeNotice).toContainText(plain(en.myAgents.refusal.credits));
    await expect(wakeNotice).toContainText(r.refused.nothing);
    expect(await runsOf(page, noCredits.key)).toEqual([]);
    expect(await agentState(page, seed, agentId)).toBe('hibernated');
  });

  test('cancel a live run in my agent — a stale send is refused naming it, and the agent’s panel drops it', async ({
    page,
  }) => {
    const card = await seedReadyCard(seed, 'Archive paid invoices');
    const other = await seedReadyCard(seed, 'Rename the export button');
    // An agent, signed in and running. The picker reads the RECORDED sign-in, which
    // a boot or a hibernate takes, so the sign-in is followed by a sleep and a wake.
    const agentId = await createAgent(page, seed, 'yue-claude');
    signInCodingAgent(agentId);
    await letIdleWindowPass(page, [agentId]);
    await wakeAgent(page, seed, agentId);

    // The other work item's picker is open, listing the agent as free…
    await openCard(page, other.key);
    await openPicker(page, other.key);
    await expect(agentRow(page, 'yue-claude')).toHaveAttribute('data-refusal', '');
    // …when a run starts on the first one (another tab).
    const started = await api(page, 'POST', `/api/work-items/${card.key}/agent-runs`, {
      agentInstanceId: agentId,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const runId = (started.json as { dispatchRunId: string }).dispatchRunId;
    // The stale press is refused, in words that name the run it lost to.
    const refused = await sendTo(page, other.key, 'yue-claude');
    expect(refused.status).toBe(409);
    const busy = main(page).getByTestId('agent-refused-runActive');
    await expect(busy).toContainText(
      plain(r.refused.runActive.title, { name: 'yue-claude', key: card.key }),
    );
    await expect(busy.getByRole('link', { name: card.key, exact: true })).toHaveAttribute(
      'href',
      `/items/${card.key}`,
    );
    await expect(busy.getByRole('link', { name: new RegExp(`${card.key}.*run`) })).toHaveAttribute(
      'href',
      `/runs?run=${runId}`,
    );
    await expect(busy).toContainText(r.refused.nothing);
    expect(await runsOf(page, other.key)).toEqual([]);

    // The live run: its coding agent is working in the agent.
    await openCardWithRun(page, card.key);
    await expect(phase(page, 'running')).toHaveAttribute('data-state', 'now', { timeout: 90_000 });

    // Cancel it.
    await main(page).getByTestId('hosted-run-cancel').click();
    const cancelled = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/dispatch-runs/${runId}/cancel`) &&
        res.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await page.getByRole('alertdialog').getByTestId('hosted-run-cancel-confirm').click();
    expect((await cancelled).status()).toBe(200);
    await expect(agentRun(page)).toHaveAttribute('data-status', 'cancelled', { timeout: 30_000 });
    await expect(agentRun(page).getByTestId('agent-end')).toHaveAttribute('data-end', 'cancelled');
    expect((await runsOf(page, card.key))[0]).toMatchObject({ id: runId, status: 'cancelled' });

    // The agent's panel: no live run line and no run session any more — the
    // session was stopped in the agent, and the line says how the run ended.
    await page.goto(`/my-agents?agent=${agentId}`);
    await expect(panel(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(panel(page).getByTestId('agent-conn')).toHaveText(en.myAgents.panel.conn.live, {
      timeout: 30_000,
    });
    await expect(runLine(page)).toHaveAttribute('data-state', 'ended');
    await expect(runLine(page)).toContainText(en.runs.runStatus.cancelled);
    await expect(sessions(page)).toHaveCount(0);
    expect(await agentState(page, seed, agentId)).toBe('running');
  });
});

/** Open a card whose run is live — the Run section shows the run, not the start bar. */
async function openCardWithRun(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(agentRun(page)).toHaveAttribute('data-status', 'running', {
    timeout: FIRST_PAINT_MS,
  });
}
