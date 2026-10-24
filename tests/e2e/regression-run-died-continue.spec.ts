import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  appendEvents,
  heartbeat,
  ingestContext,
  lapseRun,
  openRun,
  type OpenRunArgs,
} from './_helpers/agent-run-seed';
import { seedRunDied, type DiedCard, type RunDiedSeed } from './_helpers/run-died-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A RUN THAT DIES KEEPS ITS WORK — `motir continue <key>` — THE ACCEPTANCE RECEIPT
// (Story MOTIR-6526 · Subtask MOTIR-6536).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Ada's run is working a card and reporting that it is alive: the card is In
// Progress and says nothing more. The run goes silent. The card is STILL In
// Progress — nothing moved — and now says the run died, when it was last heard
// from, whose run it was, the branch its work is on, and the one command that
// carries it on. Ben runs that command: the card says Ben is continuing it, and
// it is Ben's. A second continue is refused, naming Ben. Then the same marker
// reads in Chinese.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The run — opened, annotated with its `checkout_ready` branch and heartbeated
//     through the REAL `/api/v1/dispatch-runs` ingest ops (`agent-run-seed.ts`),
//     with Ada's own token, exactly as the CLI's reporter calls them.
//   * The lapse — `lapseRun`, the ONE field written directly: `lastHeartbeatAt`
//     moved six minutes back. Five minutes of silence cannot be waited for, and no
//     server clock is moved.
//   * The continue — the shipped `POST /api/v1/work-items/{key}/continue`, called
//     with Ben's token as `motir continue` calls it. A browser lane cannot drive a
//     CLI; the command's own lane is `packages/cli/test/continueCommand.test.ts`.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: an ingest op's committed response, the claim's
// response, a v1 read of the card, or the part's `data-state` after a reload. No
// timed wait anywhere in this file; the holds are `chapter()` / `beat()`'s.
//
// ⚠️ NOT DRIVEN HERE: the marker's LOADING and ERROR faces (Panel D8). The read is
// one of the item page's late reads, resolved server-side before the part renders,
// so its pending face is the late stack's own frame, and its error face needs the
// database to fail mid-render. Both are asserted where they can be produced
// deterministically: `tests/components/continue-part.test.tsx`.

test.describe.configure({ timeout: 300_000 });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A rich message read as the rendered text reads it: tags keep their children,
 *  `{var}` becomes its value, `<when></when>` becomes ANY relative time. */
function richPattern(template: string, vars: Record<string, string> = {}): RegExp {
  const parts = template.split(/<when><\/when>/);
  const literal = (s: string) =>
    escape(
      s
        .replace(/<\/?(b|mono|ref|link)>/g, '')
        .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ''),
    );
  return new RegExp(parts.map(literal).join('.+'));
}

type Messages = typeof en;

/** The Development block's continue part — a labelled group. */
const continuePart = (page: Page, messages: Messages = en): Locator =>
  page.getByRole('group', { name: messages.github.development.continue.aria.part, exact: true });

/** The detail rail's Status field card (the `approval-gate-repaint.spec.ts` precedent). */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const branchOf = (card: DiedCard) => `motir/${card.identifier.toLowerCase()}-work`;

interface ContinueClaimBody {
  key: string;
  outcome: 'claimed' | 'mine' | 'taken' | 'not_continuable';
  reason: string | null;
  holder: { id: string; name: string | null } | null;
  branch: string | null;
}

async function claimContinue(api: APIRequestContext, key: string): Promise<ContinueClaimBody> {
  const res = await api.post(`/api/v1/work-items/${key}/continue`);
  const text = await res.text();
  expect(res.status(), `continue ${key} → ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text) as ContinueClaimBody;
}

/** The card as the v1 read reports it — committed state, not the page. */
async function readCard(
  api: APIRequestContext,
  key: string,
): Promise<{ status: string; assigneeId: string | null }> {
  const res = await api.get(`/api/v1/work-items/${key}`);
  expect(res.status(), `read ${key}`).toBe(200);
  return (await res.json()) as { status: string; assigneeId: string | null };
}

/**
 * A run on `card`, reporting as the CLI does: opened with its set, alive by a
 * heartbeat, and — unless `pushed` is false — its `checkout_ready` naming the
 * branch the work is on.
 */
async function startRun(
  api: APIRequestContext,
  card: DiedCard,
  opts: { pushed?: boolean; scope?: Pick<OpenRunArgs, 'command' | 'scopeKey'> } = {},
): Promise<string> {
  const runId = await openRun(api, {
    projectKey: 'DIED',
    command: 'run',
    agent: 'claude',
    ...opts.scope,
    cards: [{ key: card.identifier }],
  });
  if (opts.pushed !== false) {
    await appendEvents(api, runId, [
      { kind: 'checkout_ready', workItemKey: card.identifier, data: { branch: branchOf(card) } },
    ]);
  }
  await heartbeat(api, runId);
  return runId;
}

test.describe('a run that dies keeps its work — motir continue', () => {
  let seed: RunDiedSeed;
  let adaApi: APIRequestContext;
  let benApi: APIRequestContext;

  test.beforeEach(async ({ page, baseURL }) => {
    await resetDatabase();
    seed = await seedRunDied(Date.now().toString(36));
    adaApi = await ingestContext(seed.ada.token, baseURL!);
    benApi = await ingestContext(seed.ben.token, baseURL!);
    await signIn(page, seed.ada.email, seed.password);
  });

  test.afterEach(async () => {
    await adaApi.dispose();
    await benApi.dispose();
  });

  test('a run goes silent, the card says it died without moving, and a continue picks it up', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6526');
    const c = en.github.development.continue;
    const key = seed.main.identifier;
    let runId = '';

    await chapter('Ada’s run is working the card, and says it is alive', async () => {
      runId = await startRun(adaApi, seed.main);
      expect((await readCard(adaApi, key)).status).toBe('in_progress');
      await page.goto(`/items/${key}`);
      await expect(statusCard(page)).toContainText('In Progress', { timeout: FIRST_PAINT_MS });
      // ⚠️ ABSENT for a heartbeating run — the died state below cannot be satisfied
      // by a run that was never alive.
      await expect(continuePart(page)).toHaveCount(0);
      await expect(page.getByTestId('run-died-line')).toHaveCount(0);
    });
    await beat();

    await chapter(
      'The run goes silent: the card says it died, and is still In Progress',
      async () => {
        await lapseRun(runId, 6);
        await page.reload();
        const part = continuePart(page);
        await expect(part).toHaveAttribute('data-state', 'died', { timeout: FIRST_PAINT_MS });
        await expect(part.getByText(c.died.pill, { exact: true })).toBeVisible();
        await expect(part).toContainText(richPattern(c.reason.lapsed));
        await expect(part).toContainText(
          richPattern(c.ranBy, { name: seed.ada.name, command: 'motir run' }),
        );
        await expect(part).toContainText(richPattern(c.branch, { branch: branchOf(seed.main) }));
        await expect(part).toContainText(richPattern(c.safe, { status: 'In Progress' }));
        await expect(part.getByText(`motir continue ${key}`, { exact: true })).toBeVisible();
        // The run section says it too, pointing down to the part — found by ROLE, so
        // only the live subtree's copy can match (the page-rooted-locator guard).
        const diedLine = page.getByRole('status').filter({ hasText: /This run died/ });
        await expect(diedLine).toBeVisible();
        // ⚠️ NOTHING MOVED — the committed status, and the rail.
        expect((await readCard(adaApi, key)).status).toBe('in_progress');
        await expect(statusCard(page)).toContainText('In Progress');
        await diedLine.scrollIntoViewIfNeeded();
        await beat();
        await part.scrollIntoViewIfNeeded();
      },
    );
    await beat();

    await chapter('Ben runs motir continue: the card is his, on the same branch', async () => {
      const claim = await claimContinue(benApi, key);
      expect(claim.outcome).toBe('claimed');
      expect(claim.branch).toBe(branchOf(seed.main));
      const card = await readCard(adaApi, key);
      expect(card.status).toBe('in_progress');
      expect(card.assigneeId).toBe(seed.ben.id);
    });

    await chapter('Ada reloads: Ben is continuing it, and the status never moved', async () => {
      await page.reload();
      const part = continuePart(page);
      await expect(part).toHaveAttribute('data-state', 'continuing', { timeout: FIRST_PAINT_MS });
      await expect(part.getByText(c.continuing.pill, { exact: true })).toBeVisible();
      await expect(part).toContainText(richPattern(c.continuing.by, { name: seed.ben.name }));
      await expect(part).toContainText(richPattern(c.continuing.tookOver, { name: seed.ada.name }));
      await expect(part.getByText(`motir continue ${key}`, { exact: true })).toHaveCount(0);
      await expect(statusCard(page)).toContainText('In Progress');
      await part.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('A second continue is refused, naming Ben', async () => {
      const claim = await claimContinue(adaApi, key);
      expect(claim.outcome).toBe('taken');
      expect(claim.holder?.name).toBe(seed.ben.name);
      // A rival is handed no branch.
      expect(claim.branch).toBeNull();
    });

    await chapter('In Chinese: a second card whose run died', async () => {
      const z = zh.github.development.continue;
      const zkey = seed.zh.identifier;
      await lapseRun(await startRun(adaApi, seed.zh), 6);
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto(`/items/${zkey}`);
      const part = continuePart(page, zh as unknown as Messages);
      await expect(part).toHaveAttribute('data-state', 'died', { timeout: FIRST_PAINT_MS });
      await expect(part.getByText(z.died.pill, { exact: true })).toBeVisible();
      await expect(part).toContainText(richPattern(z.reason.lapsed));
      await expect(part).toContainText(z.lead);
      await expect(part.getByText(`motir continue ${zkey}`, { exact: true })).toBeVisible();
      await part.scrollIntoViewIfNeeded();
    });
    await beat();
  });

  test('the refusals read in words: nothing pushed, implemented, and a child of a parent run', async ({
    page,
  }) => {
    const c = en.github.development.continue;

    // NOTHING PUSHED — only the start-over hint, no command.
    await lapseRun(await startRun(adaApi, seed.noPush, { pushed: false }), 6);
    await page.goto(`/items/${seed.noPush.identifier}`);
    let part = continuePart(page);
    await expect(part).toHaveAttribute('data-state', 'no_branch', { timeout: FIRST_PAINT_MS });
    await expect(part).toContainText(c.nothingPushed);
    await expect(part).toContainText(richPattern(c.startOver, { target: seed.noPush.identifier }));
    await expect(part.getByText(/motir continue/)).toHaveCount(0);
    expect((await claimContinue(benApi, seed.noPush.identifier)).reason).toBe('no_branch');

    // IMPLEMENTED — its checks decide from here: `motir fix`, never continue.
    await lapseRun(await startRun(adaApi, seed.implemented), 6);
    await page.goto(`/items/${seed.implemented.identifier}`);
    part = continuePart(page);
    await expect(part).toHaveAttribute('data-state', 'use_fix', { timeout: FIRST_PAINT_MS });
    await expect(part).toContainText(richPattern(c.implemented.line));
    await expect(part).toContainText(`motir fix ${seed.implemented.identifier}`);
    await expect(part.getByText(/motir continue/)).toHaveCount(0);
    expect((await claimContinue(benApi, seed.implemented.identifier)).reason).toBe('use_fix');
    expect((await readCard(adaApi, seed.implemented.identifier)).status).toBe('implemented');

    // A CHILD OF A PARENT RUN — continued from its parent.
    await lapseRun(
      await startRun(adaApi, seed.child, {
        scope: { command: 'run_scope', scopeKey: seed.parent.identifier },
      }),
      6,
    );
    await page.goto(`/items/${seed.child.identifier}`);
    part = continuePart(page);
    await expect(part).toHaveAttribute('data-state', 'continue_the_parent', {
      timeout: FIRST_PAINT_MS,
    });
    await expect(part.getByRole('link', { name: seed.parent.identifier })).toHaveAttribute(
      'href',
      `/items/${seed.parent.identifier}`,
    );
    await expect(
      part.getByText(`motir continue ${seed.parent.identifier}`, { exact: true }),
    ).toBeVisible();
    await expect(
      part.getByText(`motir continue ${seed.child.identifier}`, { exact: true }),
    ).toHaveCount(0);
    expect((await claimContinue(benApi, seed.child.identifier)).reason).toBe('continue_the_parent');
  });
});
