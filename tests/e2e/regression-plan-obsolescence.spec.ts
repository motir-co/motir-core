import type { Locator, Page, Response } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import {
  agentSession,
  authorPlanOverMcp,
  seedAgentAuthoredPlan,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
  type AgentPlanSeed,
} from './_helpers/agent-authored-plan-seed';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';

// A PLAN MARKS A CARD — THE ACCEPTANCE RECEIPT (Story MOTIR-6577 · Subtask
// MOTIR-6634). The story's verification recipe, steps 1 and 2, in a real browser
// against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A plan an agent wrote says a FINISHED story is no longer true of the code: it
// marks the story `outdated`, says why, and names the story the same plan adds as
// the one that replaces it. The reviewer reads exactly that on the review —
// *Current → Outdated*, the note, the *Superseded by* chip, and *Stays Done while
// marked* — and can tell it apart from re-opening the card (no Status row). They
// approve, and the old story carries the mark while staying Done, with the new
// story on the other end of one `supersedes` link.
//
// ── WHAT THIS LANE CANNOT SEE ───────────────────────────────────────────────
//
// The lane does not run motir-ai, so the plan is SEEDED as an agent-authored plan
// over the REAL MCP transport (`add_plan_items` carrying the mark keys, the door
// MOTIR-6631 opened) rather than laid by a planning pass. That Motir AI lays the
// mark is motir-ai's own gate (MOTIR-6638).
//
// ── WHY THE RESULT IS READ THROUGH THE API ──────────────────────────────────
//
// The item page does not render the mark or the Supersedes / Superseded-by groups
// yet — that is MOTIR-6575's (the person's surfaces story), still to be built when
// this ran. So the approved result is read through `GET /api/v1/work-items/{key}`,
// the published detail read, with a `project:browse` token — and the same response
// is shown on screen so the reviewer watching sees what is asserted. When
// MOTIR-6575 has merged, a spec for it asserts the item page instead.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// The review is server-rendered from the seeded plan, so its landmarks (the status
// pill, the proposal list, the canvas) ARE the loaded signal. The one write is
// approve: its POST is armed before the press and its 200 asserted before anything
// reads the tree it produced. Every `beat()` is PACING taken after the state it
// holds on has already been asserted — never a wait.

const EPIC = 'Checkout';
const OLD_STORY = 'Checkout with saved cards';
const NEW_STORY = 'Checkout, v2 — one-page flow';
const NOTE_FIRST = 'The one-page flow in Checkout, v2 replaced this.';
const NOTE = `${NOTE_FIRST}\nSaved cards now live in the wallet step.`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mcpOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  return baseURL;
}

const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const toolText = (r: CallToolResult) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

/** The receipt plan's title — its conversation row is titled by it (an agent's
 *  conversation has no first turn). */
const PLAN_TITLE = 'Checkout, v2 replaces the saved-cards flow';

/** One proposal's row on the review's list, found by its one control. */
const proposalRow = (page: Page, title: string): Locator =>
  page
    .getByTestId('plan-proposal-list')
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: new RegExp(escape(title)) }) });

/** A change line on a list row — the `<dl>` subgrid row whose label is `label`. */
const changeLine = (row: Locator, label: string): Locator =>
  row.locator('dl > div').filter({
    has: row.page().locator('dt', { hasText: new RegExp(`^${escape(label)}$`) }),
  });

/** A peek rail row, captioned `label` (plus the screen-reader `changed` word). */
const peekRow = (peek: Locator, label: string): Locator =>
  peek.locator('dt', { hasText: new RegExp(`^${escape(label)}\\s*(changed)?$`) }).locator('..');

async function openPeek(page: Page, title: string): Promise<Locator> {
  await page
    .getByTestId('plan-proposal-list')
    .getByRole('button', { name: new RegExp(escape(title)) })
    .click();
  return expectPeekOf(page, title);
}

async function expectPeekOf(page: Page, title: string): Promise<Locator> {
  const peek = page.getByRole('dialog').getByTestId('proposal-peek');
  await expect(peek).toBeVisible();
  await expect(peek.getByRole('heading', { name: title })).toBeVisible();
  return peek;
}

async function closePeek(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog').getByTestId('proposal-peek')).toBeHidden();
}

/**
 * Re-lay the JSON response the browser is showing as indented text, so a reviewer
 * watching the clip can read the fields. PRESENTATION only: the text is the same
 * response body, parsed and re-serialised — and every assertion about the result is
 * made against the API response itself, not against this rendering.
 */
async function prettyPrintJson(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = document.body.innerText;
    const pre = document.createElement('pre');
    pre.style.cssText = 'font: 13px/1.35 monospace; margin: 12px; white-space: pre-wrap;';
    pre.textContent = JSON.stringify(JSON.parse(raw), null, 2);
    document.body.replaceChildren(pre);
  });
}

interface MarkSeed {
  seed: AgentPlanSeed;
  epicKey: string;
  old: { id: string; identifier: string };
}

/** The committed tree: an epic, and a DONE story under it — the only kind of card
 *  a plan may mark (MOTIR-6663). */
async function seedTree(email: string): Promise<MarkSeed> {
  await resetDatabase();
  const seed = await seedAgentAuthoredPlan(email);
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const epic = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'epic', title: EPIC },
    ctx,
  );
  const old = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: OLD_STORY, parentId: epic.id },
    ctx,
  );
  // Finished before the plan is written — seed-side, the shape the other plan
  // seeds use for a done card.
  await adminDb.workItem.update({ where: { id: old.id }, data: { status: 'done' } });
  return {
    seed,
    epicKey: epic.identifier,
    old: { id: old.id, identifier: old.identifier },
  };
}

/**
 * The plan the story's recipe describes, over MCP: an `add` story N that
 * `supersedesRefs` the old story, then a MARK-ONLY `modify` of the old story naming
 * N as `supersededByAdd` — both spellings of the one link — closed to `planned`.
 */
async function authorMarkPlan(
  client: Client,
  s: MarkSeed,
): Promise<{ planId: string; modifyItemId: string; newItemId: string }> {
  const created = (await client.callTool({
    name: CREATE_PLAN_TOOL_NAME,
    arguments: {
      projectKey: s.seed.projectKey,
      title: PLAN_TITLE,
      summary: 'Checkout, v2 replaces the saved-cards flow',
      plannedWithHarness: AGENT_HARNESS,
      plannedWithModel: AGENT_MODEL,
    },
  })) as CallToolResult;
  const planId = (created.structuredContent as unknown as { id: string }).id;

  const first = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: NEW_STORY, kind: 'story' },
          parentRef: s.epicKey,
          supersedesRefs: [s.old.identifier],
        },
      ],
    },
  })) as CallToolResult;
  if (first.isError) throw new Error(`add refused: ${toolText(first)}`);
  const newItemId = ids(first)[0]!;

  const second = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      final: true,
      proposals: [
        {
          op: 'modify',
          workItemId: s.old.id,
          patch: {
            obsolescence: 'outdated',
            obsolescenceNoteMd: NOTE,
            supersededByAdd: [`planItem:${newItemId}`],
          },
        },
      ],
    },
  })) as CallToolResult;
  if (second.isError) throw new Error(`modify refused: ${toolText(second)}`);
  return { planId, modifyItemId: ids(second)[0]!, newItemId };
}

// The receipt's seed runs in `beforeAll`, BEFORE the test's page exists, so the
// recording does not open on half a minute of blank screen while the tree and the
// plan are written.
let receipt: {
  s: MarkSeed;
  planId: string;
  reader: string;
} | null = null;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const s = await seedTree('acceptance-plan-obsolescence@example.com');
  const client = await agentSession(s.seed.token, mcpOrigin(testInfo.project.use.baseURL));
  const { planId } = await authorMarkPlan(client, s);
  await client.close();
  // The read token for the approved result (see the header: the item page does
  // not draw the mark yet).
  const reader = await apiTokensService.create(s.seed.userId, s.seed.workspaceId, {
    label: 'acceptance-plan-obsolescence-read',
    projectId: s.seed.projectId,
    permissions: ['project:browse'],
  });
  receipt = { s, planId, reader: reader.token };
});

test('a plan marks a done story outdated, superseded by the story it adds — read on the review, approved, found on both cards', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(240_000);
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6577');
  if (!receipt) throw new Error('the receipt seed did not run');
  const { s, planId } = receipt;
  const reader = { token: receipt.reader };

  await signIn(page, s.seed.email, AGENT_PLAN_SEED_PASSWORD);

  await chapter('The agent’s plan is waiting — open its list of changes', async () => {
    await page.goto('/plans');
    // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7889), 2026-10-08: an undecided plan's
    // chip is an overlay door — its href is the overlay address, not `/plans/<id>` —
    // so it is found by its row's title link and its own name, and a click opens the
    // plan in the planning overlay IN PLACE over the Plans list. The overlay has no
    // review rail, so the undecided `Ready to review` pill is not read here (the
    // decided page's pill is, after the approve).
    const chip = page
      .getByRole('list', { name: 'Planning conversations' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: PLAN_TITLE, exact: true }) })
      .getByRole('link', { name: /^Open the plan — / });
    await expect(chip).toHaveAccessibleName('Open the plan — Waiting for approval');
    await chip.click();
    await page.waitForURL(
      (url) => url.pathname === '/plans' && url.searchParams.has('planSession'),
    );
    const overlay = page.getByRole('dialog', { name: /plan/i });
    await expect(overlay.getByTestId('plan-proposal-views')).toBeVisible();
    // The list of changes is asked for — the overlay's view is local, never `?view=`.
    await overlay
      .getByRole('group', { name: 'Plan view' })
      .getByRole('button', { name: 'List', exact: true })
      .click();
    await expect(overlay.getByTestId('plan-proposal-list')).toBeVisible();
    await expect(proposalRow(page, OLD_STORY)).toBeVisible();
    await expect(proposalRow(page, NEW_STORY)).toBeVisible();
  });

  await chapter('The done story: Current → Outdated, the note, and who replaces it', async () => {
    const row = proposalRow(page, OLD_STORY);
    await expect(changeLine(row, 'Mark').locator('dd')).toHaveText(/Current\s*→\s*Outdated/);
    await expect(changeLine(row, 'Note').locator('dd')).toHaveText(NOTE_FIRST);
    const chip = changeLine(row, 'Superseded by').getByTestId('supersedes-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-ref', 'proposal');
    await expect(chip).toHaveAttribute('data-delta', '+');
    await expect(chip).toContainText('New');
    await expect(chip).toContainText(NEW_STORY);
    // A mark is not a re-open: no Status row, and the row says the card stays Done.
    await expect(changeLine(row, 'Status')).toHaveCount(0);
    await expect(row.getByTestId('mark-holds-status')).toHaveText('Stays Done while marked');
    await row.scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter('The new story says which card it supersedes', async () => {
    const row = proposalRow(page, NEW_STORY);
    const chip = row.getByTestId('supersedes-row').getByTestId('supersedes-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-ref', 'committed');
    await expect(chip).toContainText(s.old.identifier);
    await beat();
  });

  await chapter('Open the done story: the mark, the whole note, Superseded by', async () => {
    const peek = await openPeek(page, OLD_STORY);
    const mark = peekRow(peek, 'Mark');
    await expect(mark.locator('[data-obsolescence="outdated"]')).toBeVisible();
    await expect(mark.getByTestId('mark-holds-status')).toHaveText('Stays Done while marked');
    await expect(peekRow(peek, 'Note').getByTestId('mark-note')).toHaveText(NOTE);
    const chip = peekRow(peek, 'Superseded by').getByTestId('supersedes-chip');
    await expect(chip).toContainText(NEW_STORY);
    await expect(peek).toContainText('This plan changes 3 of the 11 fields it can set.');
    await beat();

    // The proposed chip opens the proposal it names.
    await chip.getByTestId('supersedes-chip-open').click();
    const next = await expectPeekOf(page, NEW_STORY);
    const supersedes = peekRow(next, 'Supersedes').getByTestId('supersedes-chip');
    await expect(supersedes).toHaveCount(1);
    await expect(supersedes).toContainText(s.old.identifier);
    await beat();
    await closePeek(page);
  });

  await chapter('On the canvas: an Outdated pill, and Supersedes 1', async () => {
    await page
      .getByRole('group', { name: 'Plan view' })
      .getByRole('button', { name: 'Canvas' })
      .click();
    await expect(
      page.getByRole('dialog', { name: /plan/i }).getByRole('application'),
    ).toBeVisible();
    const oldCard = page.locator('[data-node-id]').filter({ hasText: OLD_STORY });
    await expect(oldCard.getByTestId('plan-item-obsolescence')).toHaveAttribute(
      'data-obsolescence',
      'outdated',
    );
    // Not locked: a mark-only change to a finished card is the one a plan may make.
    await expect(oldCard).toContainText(/Mark\s*Current\s*›?\s*Outdated/);
    const newCard = page.locator('[data-node-id]').filter({ hasText: NEW_STORY });
    await expect(newCard.getByTestId('plan-item-supersedes')).toHaveText('Supersedes 1');
    await beat();
  });

  await chapter('Approve the plan', async () => {
    // Undecided, so it is approved in the overlay's footer (Story MOTIR-7883).
    const approve = page
      .getByRole('dialog', { name: /plan/i })
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible();
    const approved = page.waitForResponse(
      (r: Response) =>
        r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status(), 'the approve').toBe(200);
    await page.goto(`/plans/${planId}`); // decided: the plan page renders, as a record
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText('Approved');
  });

  const created = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: s.seed.projectId, title: NEW_STORY },
    select: { id: true, identifier: true },
  });
  const auth = { Authorization: `Bearer ${reader.token}` };

  await chapter(
    'The old story is still Done — and now Outdated, superseded by the new one',
    async () => {
      const res = await page.request.get(`/api/v1/work-items/${s.old.identifier}`, {
        headers: auth,
      });
      expect(res.status()).toBe(200);
      const old = (await res.json()) as {
        status: string;
        obsolescence: string | null;
        obsolescenceNoteMd: string | null;
        links: { supersedes: { key: string }[]; supersededBy: { key: string }[] };
      };
      expect(old.status, 'a mark never moves the status').toBe('done');
      expect(old.obsolescence).toBe('outdated');
      expect(old.obsolescenceNoteMd).toBe(NOTE);
      expect(old.links.supersededBy.map((r) => r.key)).toEqual([created.identifier]);
      expect(old.links.supersedes).toEqual([]);

      // Exactly ONE row joins them, although both spellings named it.
      const links = await adminDb.workItemLink.findMany({
        where: {
          kind: 'supersedes',
          OR: [
            { fromId: created.id, toId: s.old.id },
            { fromId: s.old.id, toId: created.id },
          ],
        },
        select: { fromId: true, toId: true },
      });
      expect(links).toEqual([{ fromId: created.id, toId: s.old.id }]);

      // Shown, so the reviewer sees what is asserted.
      await page.setExtraHTTPHeaders(auth);
      await page.goto(`/api/v1/work-items/${s.old.identifier}`);
      await prettyPrintJson(page);
      await expect(page.locator('body')).toContainText(/"obsolescence":\s*"outdated"/);
      await expect(page.locator('body')).toContainText(/"status":\s*"done"/);
      await beat();
    },
  );

  await chapter('The new story lists the old one under Supersedes', async () => {
    const res = await page.request.get(`/api/v1/work-items/${created.identifier}`, {
      headers: auth,
    });
    expect(res.status()).toBe(200);
    const fresh = (await res.json()) as {
      obsolescence: string | null;
      links: { supersedes: { key: string }[]; supersededBy: { key: string }[] };
    };
    expect(fresh.obsolescence).toBeNull();
    expect(fresh.links.supersedes.map((r) => r.key)).toEqual([s.old.identifier]);
    expect(fresh.links.supersededBy).toEqual([]);

    await page.goto(`/api/v1/work-items/${created.identifier}`);
    await prettyPrintJson(page);
    await expect(page.locator('body')).toContainText(
      new RegExp(`"supersedes":\\s*\\[\\s*\\{\\s*"key":\\s*"${s.old.identifier}"`),
    );
    await beat();
  });
});

test('a mark with a title beside it is refused and the review is unaffected; a plan with no marks draws none of the rows', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const s = await seedTree('acceptance-plan-obsolescence-edges@example.com');
  const client = await agentSession(s.seed.token, mcpOrigin(baseURL));

  const { planId, modifyItemId, newItemId } = await authorMarkPlan(client, s);

  // REFUSAL — a correction of the done story's `modify` that carries `title` beside
  // the mark is no longer mark-only, so the finished card is immutable to it. It is
  // refused AT the correction and the stored patch stays mark-only. (An APPEND
  // carrying the same patch is taken and refused at the close instead — the
  // carve-out is judged on the whole plan; `planMarkStoryGate.test.ts` holds both.)
  const refused = (await client.callTool({
    name: UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    arguments: {
      planId,
      planItemId: modifyItemId,
      patch: {
        title: 'Checkout with saved cards (legacy)',
        obsolescence: 'outdated',
        obsolescenceNoteMd: NOTE,
        supersededByAdd: [`planItem:${newItemId}`],
      },
    },
  })) as CallToolResult;
  expect(refused.isError, 'a non-mark key on a done card is refused').toBe(true);
  expect(toolText(refused)).toContain('PLAN_TARGET_IMMUTABLE');

  // EMPTY — a second plan with no marks at all.
  const empty = await authorPlanOverMcp(client, s.seed.projectKey, {
    title: 'Payouts, no marks',
    harness: AGENT_HARNESS,
  });
  await client.close();

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await signIn(page, s.seed.email, AGENT_PLAN_SEED_PASSWORD);

  // The first plan's review carries only what the accepted batch said.
  const firstOverlay = await openUndecidedPlan(page, planId, { view: 'list' });
  await expect(firstOverlay.getByTestId('plan-proposal-list')).toBeVisible();
  const row = proposalRow(page, OLD_STORY);
  await expect(changeLine(row, 'Mark').locator('dd')).toHaveText(/Current\s*→\s*Outdated/);
  await expect(changeLine(row, 'Title')).toHaveCount(0);
  await expect(row).not.toContainText('(legacy)');
  expect(
    await adminDb.planItem.count({ where: { planId, op: 'modify' } }),
    'the refused correction left one proposal',
  ).toBe(1);
  const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyItemId } });
  expect(stored.patch, 'the stored patch stays mark-only').not.toHaveProperty('title');

  // The no-mark plan: none of the new rows, anywhere on the review.
  const emptyOverlay = await openUndecidedPlan(page, empty.planId, { view: 'list' });
  await expect(emptyOverlay.getByTestId('plan-proposal-list')).toBeVisible();
  for (const title of empty.leafTitles) {
    await expect(proposalRow(page, title)).toBeVisible();
  }
  await expect(page.getByTestId('supersedes-chip')).toHaveCount(0);
  await expect(page.getByTestId('supersedes-row')).toHaveCount(0);
  await expect(page.getByTestId('mark-holds-status')).toHaveCount(0);
  for (const label of ['Mark', 'Note', 'Supersedes', 'Superseded by']) {
    await expect(
      emptyOverlay
        .getByTestId('plan-proposal-list')
        .locator('dt', { hasText: new RegExp(`^${label}$`) }),
    ).toHaveCount(0);
  }
  await openUndecidedPlan(page, empty.planId, { view: 'canvas' });
  await expect(page.getByRole('dialog', { name: /plan/i }).getByRole('application')).toBeVisible();
  await expect(page.getByTestId('plan-item-obsolescence')).toHaveCount(0);
  await expect(page.getByTestId('plan-item-supersedes')).toHaveCount(0);

  expect(pageErrors, 'the review threw nothing').toEqual([]);
});
