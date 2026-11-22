import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedScopedRun, SCOPED_RUN_PASSWORD } from './_helpers/scoped-run-seed';
import { agentMcpSession, callMotirTool, runEvents } from './_helpers/agent-run-seed';
import { CLAIM_WORK_ITEM_TOOL_NAME } from '@/lib/mcp/tools/claimWorkItem';
import { CREATE_WORK_ITEM_TOOL_NAME } from '@/lib/mcp/tools/createWorkItem';
import { LINK_WORK_ITEMS_TOOL_NAME } from '@/lib/mcp/tools/linkWorkItems';
import { RECORD_RUN_DISCREPANCY_TOOL_NAME } from '@/lib/mcp/tools/recordRunDiscrepancy';
import { TRANSITION_STATUS_TOOL_NAME } from '@/lib/mcp/tools/transitionStatus';
import {
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  START_WORK_ITEM_RUN_TOOL_NAME,
} from '@/lib/mcp/tools/workItemRun';

// A RUN BUILDS THROUGH A WRONG HOW AND RECORDS IT — THE ACCEPTANCE RECEIPT (Story
// MOTIR-8651 · Subtask MOTIR-8663, decision page MOTIR-8654).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An agent builds a card through a plan that was wrong only about the HOW. It does
// not stop: it files a bug it found on the way, records ONE discrepancy with three
// points, delivers the card and closes its run. The claim of the story is that a
// PERSON then finds that record where they already look — the findings strip of
// the run modal opened from `/runs`, beside the bug — and that its door leads to
// the work item's Run discrepancy section, open, listing every point.
//
// ⚠️ THE AGENT IS A SCRIPTED MCP CLIENT, not a coding agent, exactly as in
// `regression-agent-reported-run.spec.ts`. A real agent is non-deterministic and
// needs a provider key; what it does to Motir is a sequence of tool calls over the
// real transport with the seed's token, and that is what this sends. Nothing on
// the server is stubbed. Whether an agent CHOOSES to build through is the
// prompt's, `run.md`'s and the skill's to teach, and production verification
// checks it — it is not asserted here.
//
// ⚠️ THE STRIP HOLDS ONLY THE POINTER — `run-findings-protocol.md` Q5. The
// assertion that no point's text appears in the dialog is that boundary. It is
// made non-vacuous by reading the same three strings on the item page afterwards.
//
// ⚠️ THE DOOR LANDS ON THE RECORD'S OWN SECTION (MOTIR-11996). The door used to be
// `/items/<key>`, with the record read as a comment in Activity, because the page could
// not address one comment. The door writes no comment now: the record is the card's
// Run discrepancy section, and the door is `/items/<key>#run-discrepancy`, which opens it
// (`design/runs/design-notes.md` § _Run discrepancy — the record gets its own section_).

const EMAIL = 'run-discrepancy@example.com';
const HARNESS = 'Claude Code';
const MODEL = 'claude-opus-5';
const BRANCH = 'feat/run-discrepancy';

const POINTS = [
  {
    planAsked: 'Add the column to the legacy export table',
    built: 'Added it to the current export table',
    why: 'The legacy table was retired two releases ago',
  },
  {
    planAsked: 'Call the v1 helper to resolve the owner',
    built: 'Called the v2 helper to resolve the owner',
    why: 'The v1 helper no longer exists on main',
  },
  {
    planAsked: 'Seed the fixture through the old script',
    built: 'Seeded the fixture through the shared builder',
    why: 'The old script was deleted with its last caller',
  },
];

interface Started {
  outcome: string;
  runId: string;
}

interface Reported {
  outcome: string;
  refused: string[];
}

test('an agent builds a card through a wrong HOW, and its discrepancy is where you look for findings', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
  baseURL,
}) => {
  acceptanceStory('MOTIR-8651');
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP calls have nowhere to go');

  await resetDatabase();
  const seed = await seedScopedRun(EMAIL, 'RDS');
  const agent = await agentMcpSession(seed.token, baseURL);
  const card = seed.first.identifier;
  const dialog = page.getByRole('dialog');

  let runId = '';
  let legId = '';
  let recordId = '';
  let bugKey = '';

  await chapter('The agent claims a card and opens its run', async () => {
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

    const checkout = await callMotirTool<Reported>(agent, REPORT_ACTION_TOOL_NAME, {
      key: card,
      action: 'check out the branch',
      events: [{ kind: 'checkout_ready', sessionBranch: BRANCH, disposition: 'running' }],
    });
    expect(checkout).toMatchObject({ outcome: 'reported', refused: [] });
  });

  await chapter('It files a bug it found on the way, and the run records it', async () => {
    const created = await callMotirTool<{ identifier: string }>(agent, CREATE_WORK_ITEM_TOOL_NAME, {
      projectKey: 'RDS',
      kind: 'bug',
      title: 'The export header drops its last column',
      descriptionMd: 'Found while building the card; unrelated to it.',
      parentKey: seed.story.identifier,
    });
    bugKey = created.identifier;
    await callMotirTool(agent, LINK_WORK_ITEMS_TOOL_NAME, {
      fromKey: bugKey,
      toKey: card,
      relationship: 'relates_to',
    });

    const events = await runEvents(runId);
    const bugs = events.filter((e) => e.kind === 'bug_filed');
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.data).toMatchObject({ key: bugKey });
  });

  await chapter('It records ONE discrepancy with three points', async () => {
    const recorded = await callMotirTool<{ recordId: string; recorded: boolean }>(
      agent,
      RECORD_RUN_DISCREPANCY_TOOL_NAME,
      { key: card, points: POINTS },
    );
    expect(Object.keys(recorded).sort()).toEqual(['recordId', 'recorded']);
    expect(recorded.recorded).toBe(true);
    recordId = recorded.recordId;

    const found = (await runEvents(runId)).filter((e) => e.kind === 'discrepancy_recorded');
    expect(found).toHaveLength(1);
    legId = found[0]!.cardId ?? '';
    expect(legId).not.toBe('');
    // A POINTER and a count — no key beyond these three, and no text.
    expect(found[0]!.data).toEqual({ recordId, pointCount: 3, dispatchRunCardId: legId });
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

    // It did not stop: no unbuildable report, no re-plan.
    const kinds = (await runEvents(runId)).map((e) => e.kind);
    expect(kinds).not.toContain('unbuildable_reported');
    expect(kinds).not.toContain('plan_submitted');
  });

  await chapter('The run modal’s findings strip shows both, each as itself', async () => {
    await signIn(page, EMAIL, SCOPED_RUN_PASSWORD);
    await page.goto('/runs');
    await page.getByTestId('run-open').first().click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/runs\?(?:[^#]*&)?run=/);

    const strip = dialog.getByTestId('run-findings');
    const discrepancy = strip.getByTestId('finding-discrepancy');
    const bug = strip.getByTestId('finding-bug');
    await expect(discrepancy).toHaveCount(1);
    await expect(bug).toHaveCount(1);
    await expect(discrepancy).toContainText('Built differently');
    await expect(discrepancy).toContainText(card);
    await expect(discrepancy).toContainText('3 points');
    await expect(bug).toContainText(bugKey);

    // The design's order: what already happened, then bugs.
    const order = await strip
      .locator('[data-testid^="finding-"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid')));
    expect(order).toEqual(['finding-discrepancy', 'finding-bug']);

    // Q5: the strip holds the pointer only — never a point's text.
    const text = (await dialog.textContent()) ?? '';
    for (const needle of [POINTS[0]!.planAsked, POINTS[1]!.built, POINTS[2]!.why]) {
      expect(text).not.toContain(needle);
    }
    await beat();
  });

  await chapter(
    'The door opens the card at its Run discrepancy section, listing every point',
    async () => {
      // MOTIR-11996: the record has its own section, and the door lands on it, open.
      await dialog.getByTestId('finding-discrepancy').getByRole('link', { name: 'Open →' }).click();
      await expect(page).toHaveURL(new RegExp(`/items/${card}#run-discrepancy$`));
      await expect(page.getByText('Implemented').first()).toBeVisible();

      const section = page.locator('#run-discrepancy');
      await expect(section.getByRole('heading', { name: 'Run discrepancy' })).toBeVisible();
      await expect(section.getByTestId('run-discrepancy-point')).toHaveCount(3);
      // …and no comment on the card repeats it.
      await expect(
        page.getByRole('main').getByText('Built through a plan that was wrong about the HOW'),
      ).toHaveCount(0);
      const body = (await section.textContent()) ?? '';
      let cursor = -1;
      for (const p of POINTS) {
        for (const field of [p.planAsked, p.built, p.why]) {
          const at = body.indexOf(field, cursor + 1);
          expect(at, `"${field}" appears after the previous point text`).toBeGreaterThan(cursor);
          cursor = at;
        }
      }
      expect(recordId).not.toBe('');
      await beat();
    },
  );

  await agent.close();
});
