import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { ingestContext } from './_helpers/agent-run-seed';
import {
  fakeContainerCount,
  readFakeContainers,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { seedContinueHosted, type ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import { seedSentBackCard } from './_helpers/fix-hosted-seed';
import en from '@/messages/en.json';

// A CARD A REVIEW SENT BACK IS REPAIRED FROM THE BROWSER — *FIX ON THE HOSTED AGENT*
// (Story MOTIR-1626 · Subtask MOTIR-6930; design MOTIR-6817 `design/github` § 30 Panels
// 3, 3b, 3c and 3e, `design/workbench` § 32 Panel 4; `approval-gates.md` §12.4b).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The review agent sent a card back. Where the card's fix part offered only the terminal
// command, there is now a model picker and **Fix on the hosted agent** above
// `motir fix <KEY>` — on the Development frame and on the To fix banner. One press, and
// the card says it is being fixed by you on the hosted agent, with the run's link, and
// neither repair is offered any more: the open repair is the lock. On a second card, a
// person's Request changes, Ben starts a repair from his terminal while the page is open;
// pressing the button is then refused, naming Ben, and nothing starts.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The gateway, motir-ai and GitHub — `lib/test-hosted-run-mock.ts`, as
//     `regression-continue-hosted.spec.ts` uses it.
//   * The container — the fake orchestrator; the spec reads its record to see the repair
//     booted in `fix` mode (`MOTIR_RUN_MODE=fix`). What the container then DOES is
//     MOTIR-6929's, not this spec's.
//   * The refusal — seeded (`fix-hosted-seed.ts`); how a review decides is MOTIR-6827's.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the start's own response (its status), the fake
// orchestrator's record, the part's `data-state` after the refresh the start triggers,
// and Ben's claim's own 200. No timed wait anywhere; the holds are `chapter()` / `beat()`'s.

test.describe.configure({ timeout: 240_000 });

const DEFAULT_MODEL = 'e2e-hosted-default';
const fix = en.github.development.fix;
const hosted = fix.hosted;

const main = (page: Page) => page.getByRole('main');
const fixPart = (page: Page): Locator => main(page).getByTestId('repair-fix-part');
const banner = (page: Page): Locator => main(page).getByTestId('to-fix-banner');

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the v1 calls have nowhere to go');
  return baseURL;
}

const modelsResponse = (page: Page) =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/hosted-runs/models' && res.request().method() === 'GET',
    { timeout: 30_000 },
  );
const startResponse = (page: Page, key: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${key}/hosted-runs`) && res.request().method() === 'POST',
    { timeout: 30_000 },
  );

/** Open a sent-back card and wait for its door: the models read, the part `offer`. */
async function openSentBack(page: Page, key: string): Promise<Locator> {
  const models = modelsResponse(page);
  await page.goto(`/items/${key}`);
  await models;
  const part = fixPart(page);
  await expect(part).toHaveAttribute('data-state', 'offer', { timeout: FIRST_PAINT_MS });
  await expect(part).toHaveAttribute('data-repair-kind', 'sent_back');
  await expect(part.getByTestId('fix-hosted-door')).toBeVisible();
  return part;
}

test.describe('Fix on the hosted agent', () => {
  let s: ContinueHostedSeed;
  let benApi: APIRequestContext;

  test.beforeEach(async ({ page, baseURL }) => {
    await resetDatabase();
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL, 'e2e-hosted-alt'], default: DEFAULT_MODEL },
      mayRun: true,
    });
    resetHostedRunJournal();
    const slug = Date.now().toString(36);
    s = await seedContinueHosted(`fix-${slug}@example.com`, `FH${slug}`);
    benApi = await ingestContext(s.ben.token, origin(baseURL));
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test.afterEach(async () => {
    await benApi.dispose();
  });

  test('a sent-back card is repaired on the hosted agent; a held repair refuses the press, naming its holder', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-1626');
    const agentCard = await seedSentBackCard(s, 'Export invoices as CSV', 'agent_review');
    const personCard = await seedSentBackCard(s, 'Name the reviewer', 'pull_request_approval');

    await chapter('The review agent sent the card back — two ways to repair it', async () => {
      const part = await openSentBack(page, agentCard.identifier);
      // The door LEADS, the terminal command follows (§ 30 Panel 3).
      await expect(part).toContainText(hosted.lead);
      await expect(part).toContainText(hosted.orTerminal);
      await expect(part).toContainText(`motir fix ${agentCard.identifier}`);
      // …and the To fix banner offers the same two (§ 32 Panel 4).
      await expect(banner(page).getByTestId('fix-hosted-door')).toBeVisible();
      await expect(banner(page)).toContainText(`motir fix ${agentCard.identifier}`);
    });
    await beat();

    await chapter('One press starts the repair on the hosted agent', async () => {
      const part = fixPart(page);
      const started = startResponse(page, agentCard.identifier);
      await part.getByTestId('fix-hosted').click();
      const res = await started;
      expect(res.status()).toBe(201);
      expect(res.request().postDataJSON()).toMatchObject({ mode: 'fix', model: DEFAULT_MODEL });
      // The container the press booted is a REPAIR — the fake orchestrator's own record,
      // written before the start answered (`hosted-run-boundary.ts`), so this read is
      // authoritative once the 201 is in.
      //
      // ⚠️ NEVER `res.json()` HERE. The door does not read a successful start's body (it
      // only refreshes on it), and Chrome then never reports that chunked 201 body
      // finished — `response.json()` hangs until the test times out, while the page
      // itself is fine. `regression-hosted-agent-run.spec.ts`'s `startedRunId` records the
      // same trap; the run id comes from the container the start booted instead.
      // ⚠️ THE NEWEST such record: the fake orchestrator's state outlives a test (the
      // server's own memory re-writes it), and a project key can repeat across runs.
      const machine = Object.values(readFakeContainers())
        .filter(
          (m) =>
            m.spec.env?.['MOTIR_WORK_ITEM_KEY'] === agentCard.identifier &&
            m.spec.env?.['MOTIR_RUN_MODE'] === 'fix',
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      expect(machine, `a fix container was booted for ${agentCard.identifier}`).toBeDefined();
      const dispatchRunId = machine!.spec.env!['MOTIR_DISPATCH_RUN_ID']!;
      expect(dispatchRunId).toBeTruthy();

      // The start refreshed the page (a server-derived state): the part is now Fixing,
      // told it is hosted, with the run's link — and neither repair is offered.
      await expect(part).toHaveAttribute('data-state', 'in_progress', { timeout: 30_000 });
      const line = part.getByTestId('repair-hosted-fixing');
      await expect(line).toContainText('Being fixed by you on the hosted agent');
      await expect(part.getByTestId('repair-hosted-run-link')).toHaveAttribute(
        'href',
        new RegExp(dispatchRunId),
      );
      await expect(part.getByTestId('fix-hosted-door')).toHaveCount(0);
      await expect(part).not.toContainText(`motir fix ${agentCard.identifier}`);
      // The banner says the same, and offers nothing either.
      await expect(banner(page).getByTestId('to-fix-banner-hosted-fixing')).toContainText(
        'A hosted repair is running — started by you',
      );
      await expect(banner(page).getByTestId('fix-hosted-door')).toHaveCount(0);
    });
    await beat();

    await chapter('A person’s Request changes offers the same door', async () => {
      await openSentBack(page, personCard.identifier);
    });
    await beat();

    await chapter('Ben starts a repair from his terminal while the page is open', async () => {
      const res = await benApi.post(`/api/v1/work-items/${personCard.identifier}/repair`);
      const text = await res.text();
      expect(res.status(), `repair → ${text.slice(0, 300)}`).toBe(200);
      expect((JSON.parse(text) as { outcome: string }).outcome).toBe('claimed');
    });

    await chapter('The press is refused, naming Ben — nothing started', async () => {
      const part = fixPart(page);
      const containersBefore = fakeContainerCount();
      const refused = startResponse(page, personCard.identifier);
      await part.getByTestId('fix-hosted').click();
      const res = await refused;
      expect(res.status()).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'hosted_fix_taken',
        holder: { id: s.ben.id, name: s.ben.name },
      });
      const notice = part.getByTestId('fix-hosted-refused-taken');
      await expect(notice).toContainText('Not started — a repair is already running, started by');
      await expect(notice).toContainText(s.ben.name);
      await expect(notice).toContainText(en.runs.hosted.refused.notReady.body);
      // Nothing was booted by the refused press — counted against the state before it, since
      // the fake orchestrator's record outlives a test.
      expect(fakeContainerCount()).toBe(containersBefore);
    });
    await beat();

    await chapter('A reload shows Ben’s repair holding the card, and no door', async () => {
      await page.reload();
      const part = fixPart(page);
      await expect(part).toHaveAttribute('data-state', 'in_progress', { timeout: FIRST_PAINT_MS });
      await expect(part).toContainText(`Being fixed by ${s.ben.name}`);
      await expect(part.getByTestId('fix-hosted-door')).toHaveCount(0);
    });
  });
});
