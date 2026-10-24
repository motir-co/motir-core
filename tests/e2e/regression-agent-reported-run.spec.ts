import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedScopedRun, SCOPED_RUN_PASSWORD } from './_helpers/scoped-run-seed';
import { agentMcpSession, callMotirTool, runEvents } from './_helpers/agent-run-seed';
import { CLAIM_WORK_ITEM_TOOL_NAME } from '@/lib/mcp/tools/claimWorkItem';
import { TRANSITION_STATUS_TOOL_NAME } from '@/lib/mcp/tools/transitionStatus';
import {
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  START_WORK_ITEM_RUN_TOOL_NAME,
} from '@/lib/mcp/tools/workItemRun';

// A CARD RUN BY AN AGENT IS ON THE RUN RECORD — THE ACCEPTANCE RECEIPT (Story
// MOTIR-7446 · Subtask MOTIR-7453, `docs/decisions/agent-reported-runs.md`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An agent in any harness runs a card through the MCP alone: it claims the card,
// opens its run naming its harness and model, says what it is about to do before
// each step, reports its checkout, moves the card and closes the run. The claim
// of the story is that a PERSON then finds that run where they already look for
// one — `/runs`, the run modal, the card's Run section — and that the card names
// who built it. So the clip opens `/runs` WHILE the run is open, then again after
// it closes, then the card.
//
// ⚠️ THE AGENT IS A SCRIPTED MCP CLIENT, not a coding agent. A real one is
// non-deterministic and needs a provider key; what it does to Motir is a sequence
// of tool calls over the real transport with a PAT, and that is exactly what this
// sends. Nothing on the server side is stubbed.
//
// ⚠️ THE STEPS ARE ASSERTED ON THE RECORD, NOT ON A SURFACE — deliberately, and it
// is a finding rather than a gap in this spec. `report_action` stores each step as
// an `agent_action` event, but the modal's log pane renders `log` events only
// (`RunLogPane.tsx`) and the card's step list has no row for it (`EVENT_STEP`
// maps it to null). The card's scope is the EXISTING surfaces, no new UI, and says
// to report that on the card rather than build it — so the clip shows what the
// surfaces draw, and the steps are read back from the run's events.
//
// ⚠️ THE TOOL'S OWN ANSWER IS EACH STEP'S AUTHORITATIVE SIGNAL. Every call commits
// before it answers and `callMotirTool` asserts the answer, so a page assertion
// after one waits on a stored fact (pushed over the SSE the modal holds, or read
// on navigation), never on a write in flight.

const EMAIL = 'agent-reported-run@example.com';
const HARNESS = 'Claude Code';
const MODEL = 'claude-opus-5';
const BRANCH = 'feat/agent-reported-run';
const STEPS = ['edit the service', 'run the changed tests'];

interface Started {
  outcome: string;
  runId: string;
}

interface Reported {
  outcome: string;
  refused: string[];
}

test('an agent runs a card through the MCP, and its run is where you look for runs', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
  baseURL,
}) => {
  acceptanceStory('MOTIR-7446');
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP calls have nowhere to go');

  await resetDatabase();
  const seed = await seedScopedRun(EMAIL, 'AGR');
  const agent = await agentMcpSession(seed.token, baseURL);
  const card = seed.first.identifier;
  const dialog = page.getByRole('dialog');

  let runId = '';

  await chapter('An agent claims a card and opens its run', async () => {
    const claimed = await callMotirTool<{ outcome: string }>(agent, CLAIM_WORK_ITEM_TOOL_NAME, {
      key: card,
    });
    expect(claimed.outcome).toBe('claimed');
    const started = await callMotirTool<Started>(agent, START_WORK_ITEM_RUN_TOOL_NAME, {
      key: card,
      harness: HARNESS,
      model: MODEL,
    });
    expect(started.outcome).toBe('started');
    runId = started.runId;

    // Before each step, the step; the checkout as a milestone that also puts the
    // card's leg to work.
    const checkout = await callMotirTool<Reported>(agent, REPORT_ACTION_TOOL_NAME, {
      key: card,
      action: 'check out the branch',
      events: [{ kind: 'checkout_ready', sessionBranch: BRANCH, disposition: 'running' }],
    });
    expect(checkout).toMatchObject({ outcome: 'reported', refused: [] });
    for (const action of STEPS) {
      const step = await callMotirTool<Reported>(agent, REPORT_ACTION_TOOL_NAME, {
        key: card,
        action,
      });
      expect(step.outcome).toBe('reported');
    }

    await signIn(page, EMAIL, SCOPED_RUN_PASSWORD);
    await beat();
  });

  await chapter('The runs page lists it as running, with the agent and the model', async () => {
    await page.goto('/runs');
    await expect(page.getByRole('heading', { name: 'Running now' })).toBeVisible();
    // Each row carries its `run-open` door (see `cloud-agent-runs.spec.ts`), and
    // the agent column joins harness and model.
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Open run' }) });
    await expect(row.first()).toContainText(`${HARNESS} · ${MODEL}`);
    await expect(row.first()).toContainText('Running');
    await beat();
  });

  await chapter('Its modal shows the card being worked', async () => {
    await page.getByTestId('run-open').first().click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/runs\?(?:[^#]*&)?run=/);
    await expect(dialog.getByText(`${HARNESS} · ${MODEL}`)).toBeVisible();
    const canvas = page.getByRole('region', { name: 'The set' });
    await expect(canvas.getByText(card, { exact: false }).first()).toBeVisible();
    // The checkout milestone moved the leg to work.
    await expect(canvas.getByText('Running').first()).toBeVisible();
    await beat();

    // The agent's own account of its steps is on the record, in order, as its own.
    const events = await runEvents(runId);
    expect(events.map((e) => e.kind)).toEqual([
      'run_opened',
      'checkout_ready',
      'agent_action',
      'agent_action',
      'agent_action',
    ]);
    expect(events.filter((e) => e.kind === 'agent_action').map((e) => e.body)).toEqual([
      'check out the branch',
      ...STEPS,
    ]);
    expect(events.slice(1).every((e) => e.reportedBy === 'agent')).toBe(true);
  });

  await chapter('The agent delivers the card and closes its run', async () => {
    await callMotirTool(agent, REPORT_ACTION_TOOL_NAME, {
      key: card,
      action: 'mark the card implemented',
      events: [{ kind: 'card_settled', disposition: 'implemented' }],
    });
    await callMotirTool(agent, TRANSITION_STATUS_TOOL_NAME, { key: card, status: 'implemented' });
    const closed = await callMotirTool<{ status: string; stamped: string[] }>(
      agent,
      CLOSE_WORK_ITEM_RUN_TOOL_NAME,
      { key: card, runId, outcome: 'completed' },
    );
    expect(closed).toMatchObject({ status: 'succeeded', stamped: [card] });

    // The header says it finished, why, and how long it took.
    await expect(dialog.getByText('Succeeded').first()).toBeVisible();
    await expect(dialog.getByText('the whole snapshot was attempted')).toBeVisible();
    await expect(dialog.getByText(/ · (?:\d+h \d{2}m|\d+m \d{2}s|\d+s)$/)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'The set' }).getByText('Implemented').first(),
    ).toBeVisible();
    await beat();
  });

  await chapter('The card shows the run, and names who built it', async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.goto(`/items/${card}`);

    const runSection = page
      .getByRole('main')
      .getByRole('heading', { name: 'Run', exact: true })
      .locator('xpath=ancestor::*[@data-surface="card"][1]');
    await runSection.scrollIntoViewIfNeeded();
    await expect(runSection.getByText('Recent runs')).toBeVisible();
    await expect(runSection.getByRole('link', { name: 'motir run' })).toBeVisible();
    await expect(runSection.getByText('Succeeded').first()).toBeVisible();
    await beat();

    await page.getByRole('button', { name: /Provenance/i }).click();
    const implementation = page
      .getByText('Implementation', { exact: true })
      .locator('..')
      .locator('..');
    await implementation.scrollIntoViewIfNeeded();
    await expect(implementation.getByText('BYOK', { exact: true })).toBeVisible();
    await expect(implementation.getByText(HARNESS, { exact: true })).toBeVisible();
    await expect(implementation.getByText(MODEL, { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('A run the agent halts names no implementer', async () => {
    const halted = seed.outsider.identifier;
    await callMotirTool(agent, CLAIM_WORK_ITEM_TOOL_NAME, { key: halted });
    const started = await callMotirTool<Started>(agent, START_WORK_ITEM_RUN_TOOL_NAME, {
      key: halted,
      harness: HARNESS,
      model: MODEL,
    });
    await callMotirTool(agent, REPORT_ACTION_TOOL_NAME, {
      key: halted,
      action: 'run the changed tests',
    });
    const closed = await callMotirTool<{ status: string; stamped: string[] }>(
      agent,
      CLOSE_WORK_ITEM_RUN_TOOL_NAME,
      { key: halted, runId: started.runId, outcome: 'halted' },
    );
    expect(closed).toMatchObject({ status: 'failed', stamped: [] });

    await page.goto(`/runs?run=${started.runId}`);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Failed').first()).toBeVisible();
    await expect(dialog.getByText(/halted on the first agent failure/)).toBeVisible();
    await beat();

    await page.keyboard.press('Escape');
    await page.goto(`/items/${halted}`);
    await page.getByRole('button', { name: /Provenance/i }).click();
    const implementation = page
      .getByText('Implementation', { exact: true })
      .locator('..')
      .locator('..');
    await implementation.scrollIntoViewIfNeeded();
    await expect(implementation.getByText('—')).toBeVisible();
    await beat();
  });

  await agent.close();
});
