import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { gotoLoadedBoard } from './_helpers/board';
import { setReaderLanguage } from './_helpers/reader-language';
import {
  FIXING_REPO,
  headShaFor,
  seedFixingMoving,
  type FixingCard,
  type FixingMovingSeed,
} from './_helpers/fixing-moving-seed';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// FIXING AND MOVING AGAIN — THE ACCEPTANCE RECEIPT (Story MOTIR-10305 · Subtask MOTIR-10311;
// `design/workbench/design-notes.md` § 40).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A member's card is on To fix because its CI failed. They push a fix. While the new
// commit's checks run, the row stays on To fix — the count does not move — but it now wears
// a calm FIXING tag instead of the failure, so an untouched failure and a repair in progress
// no longer look alike. Red again, and the failure is back; green, and the count drops at
// once while the row stays on screen, Cleared, until the next load. The same Fixing tag
// reads the same on the list, the board, the quick view and the item page's banner. A card
// a reviewer sent back whose repair runs on the hosted agent keeps its *Being fixed on the
// hosted agent* line. Separately, a card whose run stopped at a gate leaves To resume — and
// shows under In progress — as soon as CI starts on its pull request after the stop; a
// status move alone does not move it. Then the whole look again in Chinese.
//
// ── EVERY STATE ARRIVES THROUGH A REAL SEAM ─────────────────────────────────
//
// Nothing here writes `fixReason`, `fixDetail` or `resumeState`. Each is the shipped
// recompute answering a signed delivery to the REAL `/api/github/webhook` route:
//
//   CI failed            a FAILED `check_suite` at the pull request's head
//   a push               a `pull_request` `synchronize` at a new head — GitHub sends it
//                        before any check has reported there
//   CI started           an `in_progress` `check_suite` at that head
//   red / green          a completed `check_suite` at that head
//
// The reviewer's Request changes is the gate door itself (`approvalGatesService.decide`);
// the gated run is opened and closed through `dispatchRunService`, as a CLI run reports
// it. Only the hosted repair's RUN is a row: its container is not this lane's to boot.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a row's or a badge's text, or a
// read of the stored column. There is no `waitForTimeout`.
//
// ⚠️ THE 26xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 900_000 });

const PRS = {
  repaired: { number: 26001 },
  fixing: { number: 26002 },
  hosted: { number: 26003 },
  gated: { number: 26004 },
  gatedZh: { number: 26005 },
} as const;
type Scenario = keyof typeof PRS;

type Messages = typeof en;

// ── The page ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const strip = (page: Page, m: Messages) =>
  page.getByRole('navigation', { name: m.workbench.tabs.label });
const tabLink = (page: Page, m: Messages, label: string) =>
  strip(page, m).getByRole('link', { name: new RegExp(`^${label}`) });
const table = (page: Page, name: string): Locator => page.getByRole('table', { name });
const rowOf = (page: Page, tab: string, card: FixingCard): Locator =>
  table(page, tab).getByTestId(`workbench-row-${card.identifier}`);
const fixLineOf = (page: Page, card: FixingCard): Locator =>
  main(page).getByTestId(`workbench-fix-${card.identifier}`);
/** The Fixing state of the To fix tag, wherever it is drawn. */
const fixingTag = (scope: Locator): Locator => scope.locator('[data-to-fix-fixing]');
/** The To fix tag in its failure state. */
const toFixTag = (scope: Locator): Locator => scope.locator('[data-to-fix]');
const itemRow = (page: Page, card: FixingCard) =>
  page.getByRole('row').filter({ hasText: card.identifier });
const boardCard = (page: Page, card: FixingCard) =>
  page.getByRole('button', { name: new RegExp(card.identifier) });
const banner = (page: Page) => main(page).getByTestId('to-fix-banner');

/** The strip's badge for a tab, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, m: Messages, label: string): Promise<number> {
  const text = (await tabLink(page, m, label).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** Land on a Workbench tab, asserting the TAB ITSELF is mounted and current first — a tab
 *  that is not in the strip would let every absence below pass vacuously. */
async function openTab(page: Page, m: Messages, key: string, label: string): Promise<void> {
  await page.goto(`/workbench?tab=${key}`);
  await expect(tabLink(page, m, label)).toHaveAttribute('aria-current', 'page', {
    timeout: FIRST_PAINT_MS,
  });
}

/** Switch tabs by the strip's own link — a LOAD, which lets a held row go. */
async function switchTab(page: Page, m: Messages, key: string, label: string): Promise<void> {
  await tabLink(page, m, label).click();
  await page.waitForURL(new RegExp(`[?&]tab=${key}`));
  await expect(tabLink(page, m, label)).toHaveAttribute('aria-current', 'page', {
    timeout: FIRST_PAINT_MS,
  });
}

/** The Fixing words fit their pill: nothing is clipped or ellipsised. */
async function expectNotTruncated(tag: Locator): Promise<void> {
  const fits = await tag.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits, 'the Fixing words fit without truncation').toBe(true);
}

// ── The stored answers — read to prove the event landed BEFORE the camera looks ──

async function storedOf(card: FixingCard) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
  const detail = row.fixDetail as { fixing?: boolean } | null;
  return {
    fixReason: row.fixReason,
    fixing: detail?.fixing === true,
    resumeState: row.resumeState,
  };
}

// ── The deliveries ──────────────────────────────────────────────────────────

const headRefFor = (card: FixingCard, scenario: Scenario) =>
  `fix/${card.identifier.toLowerCase()}-${PRS[scenario].number}`;

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

/** Open and LINK the card's pull request, through the real delivery and the link door. */
async function openPr(page: Page, card: FixingCard, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, scenario);
  await deliver(
    page,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: FIXING_REPO,
    }),
    `open #${number}`,
  );
  await linkPr(page, { workItemId: card.id, repo: FIXING_REPO, number, headRef });
}

/** One signed `check_suite` for the card's pull request at its `push`-th head: `null` is a
 *  suite that has STARTED, the rest finished. */
async function checks(
  page: Page,
  card: FixingCard,
  scenario: Scenario,
  push: number,
  conclusion: 'success' | 'failure' | null,
): Promise<void> {
  const { number } = PRS[scenario];
  const headSha = headShaFor(number, push);
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion,
      status: conclusion === null ? 'in_progress' : 'completed',
      headSha,
      prNumber: number,
      headBranch: headRefFor(card, scenario),
      repo: FIXING_REPO,
    }),
    `${conclusion ?? 'started'} #${number} at ${headSha.slice(0, 7)}`,
  );
}

/** A fix PUSHED to the card's pull request — GitHub's `synchronize` at the new head, then its
 *  CI starting there: the two deliveries every real push makes, in the order GitHub sends. */
async function pushFix(
  page: Page,
  card: FixingCard,
  scenario: Scenario,
  push: number,
): Promise<void> {
  const { number } = PRS[scenario];
  const sha = headShaFor(number, push);
  const payload = pullRequestPayload({
    action: 'opened',
    number,
    title: card.title,
    headRef: headRefFor(card, scenario),
    state: 'open',
    merged: false,
    repo: FIXING_REPO,
  }) as { pull_request: Record<string, unknown> } & Record<string, unknown>;
  await deliver(
    page,
    'pull_request',
    {
      ...payload,
      action: 'synchronize',
      pull_request: { ...payload.pull_request, head: { ref: headRefFor(card, scenario), sha } },
    },
    `push #${number} to ${sha.slice(0, 7)}`,
  );
  await checks(page, card, scenario, push, null);
}

/** A run on the card that stops at a gate still waiting on its person. */
async function stopAtGate(seed: FixingMovingSeed, card: FixingCard): Promise<void> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const { run } = await dispatchRunService.open(
    {
      projectKey: seed.projectKey,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    ctx,
  );
  await adminDb.approvalGate.create({
    data: {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      workItemId: card.id,
      kind: 'design_result',
      subjectId: `ev-${card.id}`,
      state: 'awaiting',
    },
  });
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, ctx);
  expect((await storedOf(card)).resumeState).toBe('waiting_on_gate');
}

// ── The walk ────────────────────────────────────────────────────────────────

test.describe('Fixing on To fix, and a card that moves again leaves To resume', () => {
  let seed: FixingMovingSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedFixingMoving(Date.now().toString(36));
  });

  test('a pushed fix reads Fixing while its CI runs, and a gated card leaves To resume when CI starts', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10305');
    const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
    const { repaired, fixing, hosted, gated, gatedZh, gatedStill } = seed;

    await signIn(page, seed.email, seed.password);

    // ── Seeding, through the real seams ──
    // Two cards whose CI failed: the opened delivery lands each on Implemented.
    for (const [card, scenario] of [
      [repaired, 'repaired'],
      [fixing, 'fixing'],
    ] as const) {
      await openPr(page, card, scenario);
      await checks(page, card, scenario, 1, 'failure');
      expect(await storedOf(card)).toMatchObject({ fixReason: 'ci_failed', fixing: false });
    }
    // A card that went green (In Review, an approve-to-merge question raised), sent back by
    // its reviewer, and being repaired on the hosted agent.
    await openPr(page, hosted, 'hosted');
    await checks(page, hosted, 'hosted', 1, 'success');
    const [mergeGate] = await adminDb.approvalGate.findMany({
      where: { workItemId: hosted.id, kind: 'pull_request_approval', state: 'awaiting' },
    });
    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: mergeGate!.id,
        decision: 'request_changes',
        noteMd: 'Keep the header row when the list is empty.',
        source: 'ui',
      },
      ctx,
    );
    expect((await storedOf(hosted)).fixReason).toBe('changes_requested');
    const repairRun = await adminDb.dispatchRun.create({
      data: {
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        command: 'fix',
        status: 'running',
        origin: 'hosted',
        createdById: seed.userId,
      },
    });
    await adminDb.dispatchRunCard.create({
      data: {
        workspaceId: seed.workspaceId,
        dispatchRunId: repairRun.id,
        workItemId: hosted.id,
        workItemKey: hosted.identifier,
        position: 0,
      },
    });
    // Two cards with an open pull request whose run stopped at a gate, and one with none.
    // A run that parks at a gate leaves its card In Progress, so each is put back there
    // after its opened delivery delivered it.
    for (const [card, scenario] of [
      [gated, 'gated'],
      [gatedZh, 'gatedZh'],
    ] as const) {
      await openPr(page, card, scenario);
      await workItemsService.updateStatus(card.id, 'in_progress', ctx);
      await stopAtGate(seed, card);
    }
    await stopAtGate(seed, gatedStill);

    const toFix = en.workbench.tabs.toFix;
    const toResume = en.workbench.tabs.toResume;
    const inProgress = en.workbench.tabs.inProgress;
    const ciFailed = (card: FixingCard) => fixLineOf(page, card);

    // ── 1 · the failure, untouched ──
    let n = 0;
    await chapter('To fix: the red card reads CI failed, with no Fixing tag', async () => {
      await openTab(page, en, 'to-fix', toFix);
      await expect(rowOf(page, toFix, repaired)).toBeVisible({ timeout: FIRST_PAINT_MS });
      n = await badgeCount(page, en, toFix);
      expect(n).toBe(3);
      await expect(ciFailed(repaired)).toContainText('CI failed');
      await expect(fixingTag(ciFailed(repaired))).toHaveCount(0);
      await expect(ciFailed(repaired)).toContainText(`motir fix ${repaired.identifier}`);
    });
    await beat();

    // ── 2 · a push starts CI: Fixing, same count, still on To fix ──
    await chapter(
      'A fix is pushed and its CI starts — the row turns Fixing, the count holds',
      async () => {
        const url = page.url();
        await pushFix(page, repaired, 'repaired', 2);
        expect(await storedOf(repaired)).toMatchObject({ fixReason: 'ci_failed', fixing: true });

        await expect(fixingTag(ciFailed(repaired))).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(fixingTag(ciFailed(repaired))).toContainText(en.toFix.fixing.label);
        await expect(fixingTag(ciFailed(repaired)).locator('.lucide-hammer')).toHaveCount(1);
        await expect(
          main(page).getByTestId(`workbench-fix-checks-running-${repaired.identifier}`),
        ).toHaveText(en.workbench.toFix.fixing.checksRunning);
        await expect(ciFailed(repaired)).not.toContainText(`motir fix ${repaired.identifier}`);
        expect(await badgeCount(page, en, toFix)).toBe(n);
        expect(page.url(), 'nobody navigated').toBe(url);
      },
    );
    await beat();

    await chapter('…and it has not moved to In progress', async () => {
      await switchTab(page, en, 'in-progress', inProgress);
      await expect(main(page).getByTestId(`workbench-row-${repaired.identifier}`)).toHaveCount(0);
      await switchTab(page, en, 'to-fix', toFix);
      await expect(fixingTag(ciFailed(repaired))).toBeVisible({ timeout: FIRST_PAINT_MS });
    });
    await beat();

    // ── 3 · red again ──
    await chapter('Its checks fail — the Fixing tag is gone and CI failed is back', async () => {
      await checks(page, repaired, 'repaired', 2, 'failure');
      expect(await storedOf(repaired)).toMatchObject({ fixReason: 'ci_failed', fixing: false });

      await expect(fixingTag(ciFailed(repaired))).toHaveCount(0, { timeout: FIRST_PAINT_MS });
      await expect(ciFailed(repaired)).toContainText('CI failed');
      await expect(ciFailed(repaired)).toContainText(`motir fix ${repaired.identifier}`);
      expect(await badgeCount(page, en, toFix)).toBe(n);
    });
    await beat();

    // ── 4 · another push, and green ──
    await chapter(
      'Another push goes green — the count drops at once, the row stays, Cleared',
      async () => {
        await pushFix(page, repaired, 'repaired', 3);
        await expect(fixingTag(ciFailed(repaired))).toBeVisible({ timeout: FIRST_PAINT_MS });
        await beat();

        await checks(page, repaired, 'repaired', 3, 'success');
        expect((await storedOf(repaired)).fixReason).toBeNull();

        await expect
          .poll(() => badgeCount(page, en, toFix), { timeout: FIRST_PAINT_MS })
          .toBe(n - 1);
        await expect(rowOf(page, toFix, repaired)).toContainText(en.workbench.live.cleared);
        await expect(rowOf(page, toFix, repaired)).toHaveAttribute('data-held', 'true');
      },
    );
    await beat();

    await chapter('After a refresh the repaired row is gone', async () => {
      await page.reload();
      await expect(tabLink(page, en, toFix)).toHaveAttribute('aria-current', 'page', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(rowOf(page, toFix, fixing)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(rowOf(page, toFix, repaired)).toHaveCount(0);
      n -= 1;
    });
    await beat();

    // ── 5 · the same tag on every surface ──
    await pushFix(page, fixing, 'fixing', 2);
    expect(await storedOf(fixing)).toMatchObject({ fixReason: 'ci_failed', fixing: true });
    const fixingName = `${en.toFix.fixing.name} — ${en.toFix.tagName.ci_failed}`;

    await chapter('The list draws the same Fixing tag in the status cell', async () => {
      await page.goto('/items?view=list');
      await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      const glyph = fixingTag(itemRow(page, fixing));
      await expect(glyph).toHaveAttribute('aria-label', fixingName);
      await expect(glyph.locator('.lucide-hammer')).toHaveCount(1);
      await expect(toFixTag(itemRow(page, fixing))).toHaveCount(0);
    });
    await beat();

    await chapter('The board card wears it in its pill row', async () => {
      await gotoLoadedBoard(page, FIRST_PAINT_MS);
      const tag = fixingTag(boardCard(page, fixing));
      await expect(tag).toContainText(en.toFix.fixing.label);
      await expect(tag.locator('.lucide-hammer')).toHaveCount(1);
      await expect(tag).toHaveAttribute('title', fixingName);
      await tag.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('The quick view carries it in its header', async () => {
      await page.goto('/items?view=list');
      await page
        .getByRole('link', { name: `${fixing.identifier} ${fixing.title}`, exact: true })
        .click({ position: { x: 6, y: 22 } });
      await expect(page).toHaveURL(new RegExp(`[?&]peek=${fixing.identifier}`));
      const tag = fixingTag(page.getByRole('dialog'));
      await expect(tag).toContainText(en.toFix.fixing.label, { timeout: FIRST_PAINT_MS });
      await expect(tag).toHaveAttribute('title', fixingName);
      await beat();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await chapter(
      'The item page banner shows Fixing, and the reason from before the push',
      async () => {
        await page.goto(`/items/${fixing.identifier}`);
        await expect(page.getByRole('heading', { level: 1 })).toContainText(fixing.title, {
          timeout: FIRST_PAINT_MS,
        });
        await expect(banner(page)).toHaveAttribute('data-fixing', 'true');
        await expect(fixingTag(banner(page))).toContainText(en.toFix.fixing.label);
        await expect(banner(page)).toContainText(en.toFix.banner.fixing);
        await expect(banner(page)).toContainText(
          en.toFix.banner.fixingWas.replace(/<[^>]+>/g, '').trim(),
        );
        await expect(banner(page)).toContainText('CI failed');
        // `motir fix` refuses a card whose checks run, so the banner offers no command.
        await expect(banner(page).locator('pre')).toHaveCount(0);
      },
    );
    await beat();

    // ── 6 · the hosted repair's line wins ──
    await chapter(
      'A card being repaired on the hosted agent keeps that line, not Fixing',
      async () => {
        await pushFix(page, hosted, 'hosted', 2);
        expect(await storedOf(hosted)).toMatchObject({
          fixReason: 'changes_requested',
          fixing: true,
        });
        await openTab(page, en, 'to-fix', toFix);
        await expect(
          main(page).getByTestId(`workbench-fix-hosted-fixing-${hosted.identifier}`),
        ).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(fixingTag(fixLineOf(page, hosted))).toHaveCount(0);
        await expect(fixLineOf(page, hosted)).not.toHaveAttribute('data-fixing', 'true');
        // The other card is Fixing beside it — the two states side by side.
        await expect(fixingTag(fixLineOf(page, fixing))).toBeVisible();
      },
    );
    await beat();

    // ── 7 · To resume: CI starts after the run stopped ──
    let m = 0;
    await chapter('To resume lists the cards whose run stopped at a gate', async () => {
      await openTab(page, en, 'to-resume', toResume);
      await expect(
        table(page, toResume).getByText(gated.identifier, { exact: true }).first(),
      ).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(
        table(page, toResume).getByText(gatedStill.identifier, { exact: true }).first(),
      ).toBeVisible();
      m = await badgeCount(page, en, toResume);
      expect(m).toBe(3);
    });
    await beat();

    await chapter(
      'CI starts on its pull request — it leaves To resume, count one lower',
      async () => {
        await checks(page, gated, 'gated', 1, null);
        expect((await storedOf(gated)).resumeState).toBeNull();
        await expect
          .poll(() => badgeCount(page, en, toResume), { timeout: FIRST_PAINT_MS })
          .toBe(m - 1);
        await page.reload();
        await expect(tabLink(page, en, toResume)).toHaveAttribute('aria-current', 'page', {
          timeout: FIRST_PAINT_MS,
        });
        await expect(
          table(page, toResume).getByText(gatedStill.identifier, { exact: true }).first(),
        ).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await expect(
          table(page, toResume).getByText(gated.identifier, { exact: true }),
        ).toHaveCount(0);
      },
    );
    await beat();

    await chapter('…and it is listed under In progress', async () => {
      await switchTab(page, en, 'in-progress', inProgress);
      await expect(
        table(page, inProgress).getByTestId(`workbench-row-${gated.identifier}`),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(
        table(page, inProgress).getByTestId(`workbench-row-${gatedStill.identifier}`),
      ).toHaveCount(0);
    });
    await beat();

    await chapter('A status move alone does not move a gated card', async () => {
      await workItemsService.updateStatus(gatedStill.id, 'todo', ctx);
      await workItemsService.updateStatus(gatedStill.id, 'in_progress', ctx);
      expect((await storedOf(gatedStill)).resumeState).toBe('waiting_on_gate');
      await openTab(page, en, 'to-resume', toResume);
      await expect(
        table(page, toResume).getByText(gatedStill.identifier, { exact: true }).first(),
      ).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await switchTab(page, en, 'in-progress', inProgress);
      await expect(main(page).getByTestId(`workbench-row-${gatedStill.identifier}`)).toHaveCount(0);
    });
    await beat();

    // ── 8 · in Chinese ──
    await setReaderLanguage(page, seed.email, 'zh');
    const zhToFix = zh.workbench.tabs.toFix;
    const zhToResume = zh.workbench.tabs.toResume;
    const zhFixingName = `${zh.toFix.fixing.name} — ${zh.toFix.tagName.ci_failed}`;

    await chapter('In 简体中文 — the Workbench row reads 修复中', async () => {
      await openTab(page, zh, 'to-fix', zhToFix);
      const tag = fixingTag(fixLineOf(page, fixing));
      await expect(tag).toContainText(zh.toFix.fixing.label, { timeout: FIRST_PAINT_MS });
      await expectNotTruncated(tag);
      await expect(
        main(page).getByTestId(`workbench-fix-checks-running-${fixing.identifier}`),
      ).toHaveText(zh.workbench.toFix.fixing.checksRunning);
      expect(await badgeCount(page, zh, zhToFix)).toBe(n);
    });
    await beat();

    await chapter('In 简体中文 — the list, the board and the quick view', async () => {
      await page.goto('/items?view=list');
      await expect(fixingTag(itemRow(page, fixing))).toHaveAttribute('aria-label', zhFixingName, {
        timeout: FIRST_PAINT_MS,
      });
      await gotoLoadedBoard(page, FIRST_PAINT_MS);
      const boardTag = fixingTag(boardCard(page, fixing));
      await expect(boardTag).toContainText(zh.toFix.fixing.label);
      await expectNotTruncated(boardTag);
      await beat();
      await page.goto('/items?view=list');
      await page
        .getByRole('link', { name: `${fixing.identifier} ${fixing.title}`, exact: true })
        .click({ position: { x: 6, y: 22 } });
      const peekTag = fixingTag(page.getByRole('dialog'));
      await expect(peekTag).toContainText(zh.toFix.fixing.label, { timeout: FIRST_PAINT_MS });
      await expectNotTruncated(peekTag);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
    await beat();

    await chapter('In 简体中文 — the item page banner', async () => {
      await page.goto(`/items/${fixing.identifier}`);
      await expect(banner(page)).toHaveAttribute('data-fixing', 'true', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(banner(page)).toContainText(zh.toFix.banner.fixing);
      await expect(banner(page)).toContainText(
        zh.toFix.banner.fixingWas.replace(/<[^>]+>/g, '').trim(),
      );
      await expectNotTruncated(fixingTag(banner(page)));
    });
    await beat();

    await chapter('In 简体中文 — a gated card leaves 待继续 when CI starts', async () => {
      await openTab(page, zh, 'to-resume', zhToResume);
      await expect(
        table(page, zhToResume).getByText(gatedZh.identifier, { exact: true }).first(),
      ).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      const before = await badgeCount(page, zh, zhToResume);
      await checks(page, gatedZh, 'gatedZh', 1, null);
      expect((await storedOf(gatedZh)).resumeState).toBeNull();
      await expect
        .poll(() => badgeCount(page, zh, zhToResume), { timeout: FIRST_PAINT_MS })
        .toBe(before - 1);
      await switchTab(page, zh, 'in-progress', zh.workbench.tabs.inProgress);
      await expect(
        table(page, zh.workbench.tabs.inProgress).getByTestId(
          `workbench-row-${gatedZh.identifier}`,
        ),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
    });
    await beat();
  });
});
